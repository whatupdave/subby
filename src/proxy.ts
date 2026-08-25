import { loadSubs, saveSubs } from "./store.ts"
import { ensureFreshToken, fetchUsage, TokenRefreshError } from "./codex.ts"
import type { Sub, Usage } from "./types.ts"

const upstreamBase = () => process.env.SUBBY_CHATGPT_BASE ?? "https://chatgpt.com/backend-api"
const responsesUrl = () => `${upstreamBase()}/codex/responses`
const modelsUrl = () => {
  const url = new URL(`${upstreamBase()}/codex/models`)
  url.searchParams.set("client_version", process.env.SUBBY_CODEX_CLIENT_VERSION ?? "0.147.0")
  return url
}
const USAGE_CACHE_TTL_MS = 60_000
const MODEL_CACHE_TTL_MS = 5 * 60_000
const MODEL_REQUEST_TIMEOUT_MS = 5_000
const usageTimeoutMs = () => Number(process.env.SUBBY_USAGE_TIMEOUT_MS) || 5_000

// Terminal usage-limit errors (plan exhausted) vs transient 429 rate limits
function isUsageLimitError(status: number, text: string): boolean {
  return (
    status === 429 &&
    /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|usage limit|usage_limit|out of budget|quota exceeded/i.test(text)
  )
}

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

class AccountAuthError extends Error {
  constructor(message: string, public permanent: boolean) {
    super(message)
  }
}

function errorResponse(status: number, message: string): Response {
  return Response.json({ error: { message, type: "subby_error", param: null, code: null } }, { status })
}

interface ProxyState {
  server: ReturnType<typeof Bun.serve> | null
  host: string
  port: number
  currentId: string | null
  exhausted: Map<string, number>
  requests: number
  lastError: string | null
}

const state: ProxyState = {
  server: null,
  host: "127.0.0.1",
  port: 0,
  currentId: null,
  exhausted: new Map<string, number>(),
  requests: 0,
  lastError: null,
}

let getSubs: () => Sub[] = loadSubs
let persistSubs: (subs: Sub[]) => void = saveSubs

/** App wires this so the proxy sees the live in-memory subs (shared token refreshes). */
export function setSubSource(fn: (() => Sub[]) | null): void {
  getSubs = fn ?? loadSubs
}

export function setSubSaver(fn: ((subs: Sub[]) => void) | null): void {
  persistSubs = fn ?? saveSubs
}

export function isRunning(): boolean {
  return state.server !== null
}

export function info(): { running: boolean; host: string; port: number; url: string | null; currentId: string | null; requests: number; lastError: string | null } {
  const running = isRunning()
  const host = state.host.includes(":") && !state.host.startsWith("[") ? `[${state.host}]` : state.host
  return {
    running,
    host: state.host,
    port: state.port,
    url: running ? `http://${host}:${state.port}/v1` : null,
    currentId: state.currentId,
    requests: state.requests,
    lastError: state.lastError,
  }
}

const usageCache = new Map<string, { at: number; usage: Usage }>()
const pendingTokenSaves = new Set<string>()

function saveRefreshedToken(sub: Sub, previousAccessToken: string): void {
  if (sub.tokens.access !== previousAccessToken) pendingTokenSaves.add(sub.id)
  if (!pendingTokenSaves.has(sub.id)) return
  persistSubs(getSubs())
  pendingTokenSaves.delete(sub.id)
}

async function usageOf(sub: Sub, force: boolean, signal: AbortSignal): Promise<Usage> {
  const cached = usageCache.get(sub.id)
  if (!force && cached && Date.now() - cached.at < USAGE_CACHE_TTL_MS) return cached.usage
  const before = sub.tokens.access
  const usage = await fetchUsage(sub, signal).catch((e) => ({ error: String(e?.message ?? e) }) as Usage)
  saveRefreshedToken(sub, before)
  usageCache.set(sub.id, { at: Date.now(), usage })
  return usage
}

function effectivePct(u: Usage): number {
  if (u.error) return 100
  return Math.max(u.session?.pct ?? 0, u.weekly?.pct ?? 0)
}

function exhaust(sub: Sub, usage: Usage | undefined): void {
  const now = Date.now()
  const windows = [usage?.session, usage?.weekly].filter((w) => w?.resetsAt && w.resetsAt > now)
  const fullResets = windows.filter((w) => w!.pct >= 100).map((w) => w!.resetsAt!)
  const anyResets = windows.map((w) => w!.resetsAt!)
  // If usage has caught up, wait until every full window resets. If it has not,
  // use the nearest reset (normally the 5h session window) rather than a week.
  const until = fullResets.length
    ? Math.max(...fullResets)
    : anyResets.length
      ? Math.min(...anyResets)
      : now + 5 * 60_000
  state.exhausted.set(sub.id, until)
  if (state.currentId === sub.id) state.currentId = null
}

/**
 * Pick the sub to serve a request. Sticky: keep the current sub while it's
 * usable; only when it's used up (marked exhausted) pick the most available
 * remaining one (lowest session/weekly usage).
 */
async function pickSub(signal: AbortSignal): Promise<Sub> {
  const now = Date.now()
  for (const [id, until] of state.exhausted) if (until <= now) state.exhausted.delete(id)

  const codexSubs = getSubs().filter((s) => s.provider === "codex")
  if (!codexSubs.length) throw new ApiError(503, "no codex subs configured in subby")

  const current = codexSubs.find((s) => s.id === state.currentId && !state.exhausted.has(s.id))
  if (current) return current

  const available = codexSubs.filter((s) => !state.exhausted.has(s.id))
  if (!available.length) {
    const soonest = Math.min(...codexSubs.map((s) => state.exhausted.get(s.id) ?? now))
    throw new ApiError(429, `all codex subs are used up; next reset in ${Math.ceil((soonest - now) / 60_000)} min`)
  }

  const usageSignal = AbortSignal.any([signal, AbortSignal.timeout(usageTimeoutMs())])
  const scored = await Promise.all(
    available.map(async (sub) => {
      const usage = await usageOf(sub, false, usageSignal)
      return { sub, usage, pct: effectivePct(usage) }
    }),
  )
  if (signal.aborted) throw signal.reason
  for (const { sub, usage, pct } of scored) {
    if (pct >= 100 && !usage.error) exhaust(sub, usage)
  }
  const usable = scored.filter(({ sub }) => !state.exhausted.has(sub.id))
  if (!usable.length) throw new ApiError(429, "all codex subs are used up")
  const best = usable.reduce((lowest, candidate) => candidate.pct < lowest.pct ? candidate : lowest)
  state.currentId = best.sub.id
  return best.sub
}

async function withAccessToken(sub: Sub, forceFresh: boolean, request: (accessToken: string) => Promise<Response>) {
  const before = sub.tokens.access
  try {
    await ensureFreshToken(sub, forceFresh)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    throw new AccountAuthError(message, e instanceof TokenRefreshError && e.permanent)
  }
  saveRefreshedToken(sub, before)

  const accessToken = sub.tokens.access
  return { response: await request(accessToken), accessToken }
}

async function withAuthRetry(sub: Sub, request: (accessToken: string) => Promise<Response>): Promise<Response> {
  const first = await withAccessToken(sub, false, request)
  if (first.response.status !== 401) return first.response
  await first.response.text()

  const forceRefresh = sub.tokens.access === first.accessToken
  const retry = await withAccessToken(sub, forceRefresh, request)
  if (retry.response.status !== 401) return retry.response
  await retry.response.text()
  throw new AccountAuthError(`${sub.label} is unauthorized`, true)
}

function abortable<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort)
    const onAbort = () => {
      cleanup()
      reject(signal.reason)
    }
    signal.addEventListener("abort", onAbort, { once: true })
    start().then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
  })
}

function forward(sub: Sub, body: string, stream: boolean, signal: AbortSignal): Promise<Response> {
  return abortable(
    () => withAuthRetry(sub, (accessToken) => {
      const sessionId = crypto.randomUUID()
      return fetch(responsesUrl(), {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "chatgpt-account-id": sub.tokens.accountId ?? "",
          "content-type": "application/json",
          accept: stream ? "text/event-stream" : "application/json",
          "openai-beta": "responses=experimental",
          originator: "subby",
          "user-agent": "subby",
          "session-id": sessionId,
          "x-client-request-id": sessionId,
        },
        body,
        signal,
      })
    }),
    signal,
  )
}

function passthrough(upstream: Response, body: string | ReadableStream<Uint8Array> | null = upstream.body): Response {
  const headers = new Headers(upstream.headers)
  // Bun's fetch already decompressed the body; stale length/encoding headers would corrupt it
  headers.delete("content-length")
  headers.delete("content-encoding")
  headers.delete("transfer-encoding")
  headers.delete("connection")
  headers.delete("keep-alive")
  return new Response(body, { status: upstream.status, headers })
}

async function handleResponses(req: Request): Promise<Response> {
  const inBody = await req.text()

  // Mimic the regular API: accept the same body shape, force statelessness
  // (the ChatGPT backend rejects store: true and holds no server-side state)
  let parsed: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(inBody)
    if (!value || typeof value !== "object" || Array.isArray(value)) return errorResponse(400, "JSON body must be an object")
    parsed = value as Record<string, unknown>
  } catch {
    return errorResponse(400, "invalid JSON body")
  }
  if (parsed.previous_response_id !== undefined && parsed.previous_response_id !== null) {
    return errorResponse(400, "previous_response_id is unsupported because subby responses are stateless")
  }
  parsed.store = false
  const stream = parsed.stream === true
  // The ChatGPT Codex backend 400s on an explicit stream:false (the OpenAI
  // SDK sends it for typed non-streaming calls); absence is accepted.
  if (!stream) delete parsed.stream
  const body = JSON.stringify(parsed)

  const attempts = Math.max(1, getSubs().filter((s) => s.provider === "codex").length)
  let terminalStatus = 429

  for (let i = 0; i < attempts; i++) {
    const sub = await pickSub(req.signal)
    let res: Response
    try {
      res = await forward(sub, body, stream, req.signal)
    } catch (e) {
      state.lastError = e instanceof Error ? e.message : String(e)
      if (e instanceof AccountAuthError) {
        if (!e.permanent) return errorResponse(502, `token refresh failed: ${state.lastError}`)
        exhaust(sub, undefined)
        terminalStatus = 503
        continue
      }
      return errorResponse(502, `upstream request failed: ${state.lastError}`)
    }

    if (res.ok) {
      state.requests++
      state.lastError = null
      return passthrough(res)
    }

    const text = await res.text()

    // sub is used up — mark exhausted and fail over to the next one
    if (isUsageLimitError(res.status, text)) {
      const usage = await usageOf(sub, true, AbortSignal.any([req.signal, AbortSignal.timeout(usageTimeoutMs())])).catch(() => undefined)
      exhaust(sub, usage)
      state.lastError = `${sub.label} used up, failing over`
      continue
    }

    // anything else is a real upstream error — pass it through
    state.lastError = `upstream ${res.status}`
    return passthrough(res, text)
  }

  return terminalStatus === 429
    ? errorResponse(429, "all codex subs are used up")
    : errorResponse(503, state.lastError ?? "no authorized codex subs are available")
}

function modelObject(id: string) {
  return { id, object: "model", created: 0, owned_by: "openai" }
}

let modelCache: { at: number; ids: string[] } | null = null

async function parseModelIds(res: Response): Promise<string[]> {
  let value: unknown
  try {
    value = await res.json()
  } catch {
    throw new ApiError(502, "models upstream returned invalid JSON")
  }
  if (!value || typeof value !== "object" || !Array.isArray((value as { models?: unknown }).models)) {
    throw new ApiError(502, "models upstream returned an invalid catalog")
  }
  const slugs = (value as { models: unknown[] }).models
    .map((model) => model && typeof model === "object" ? (model as { slug?: unknown }).slug : undefined)
    .filter((slug): slug is string => typeof slug === "string" && slug.length > 0)
  return [...new Set(slugs)]
}

async function modelIds(signal: AbortSignal): Promise<string[]> {
  const cached = modelCache
  if (cached && Date.now() - cached.at < MODEL_CACHE_TTL_MS) return cached.ids

  const allSubs = getSubs().filter((sub) => sub.provider === "codex")
  const current = allSubs.find((sub) => sub.id === state.currentId)
  const subs = current ? [current, ...allSubs.filter((sub) => sub !== current)] : allSubs
  if (!subs.length) {
    if (cached) return cached.ids
    throw new ApiError(503, "no codex subs configured in subby")
  }

  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(MODEL_REQUEST_TIMEOUT_MS)])
  let failure = new ApiError(502, "models request failed")
  for (const sub of subs) {
    let res: Response
    try {
      res = await abortable(
        () => withAuthRetry(sub, (accessToken) =>
          fetch(modelsUrl(), {
            headers: {
              authorization: `Bearer ${accessToken}`,
              "chatgpt-account-id": sub.tokens.accountId ?? "",
              originator: "subby",
              "user-agent": "subby",
            },
            signal: requestSignal,
          }),
        ),
        requestSignal,
      )
    } catch (e) {
      if (e instanceof AccountAuthError) {
        failure = new ApiError(e.permanent ? 503 : 502, `token refresh failed: ${e.message}`)
        if (e.permanent) exhaust(sub, undefined)
      } else {
        failure = new ApiError(502, `models request failed: ${e instanceof Error ? e.message : String(e)}`)
      }
      continue
    }
    if (res.status === 403) {
      await res.text()
      exhaust(sub, undefined)
      failure = new ApiError(503, `${sub.label} cannot access the models catalog`)
      continue
    }
    if (!res.ok) {
      await res.text()
      failure = new ApiError(res.status, `models upstream returned ${res.status}`)
      break
    }

    try {
      const ids = await parseModelIds(res)
      modelCache = { at: Date.now(), ids }
      return ids
    } catch (e) {
      failure = e instanceof ApiError ? e : new ApiError(502, "models upstream returned an invalid catalog")
      break
    }
  }
  if (cached) return cached.ids
  throw failure
}

async function handleModels(signal: AbortSignal): Promise<Response> {
  return Response.json({ object: "list", data: (await modelIds(signal)).map(modelObject) })
}

async function handleModel(id: string, signal: AbortSignal): Promise<Response> {
  if (!(await modelIds(signal)).includes(id)) return errorResponse(404, `model '${id}' not found`)
  return Response.json(modelObject(id))
}

export function startProxy(port = Number(process.env.SUBBY_PORT) || 8787): void {
  if (state.server) return
  const host = process.env.SUBBY_HOST ?? "127.0.0.1"
  const local = host === "127.0.0.1" || host === "::1" || host === "localhost"
  if (!local && !process.env.SUBBY_KEY) throw new Error("SUBBY_KEY is required when binding outside localhost")
  state.server = Bun.serve({
    hostname: host,
    port,
    async fetch(req) {
      const url = new URL(req.url)

      const key = process.env.SUBBY_KEY
      if (key && req.headers.get("authorization") !== `Bearer ${key}`) {
        return errorResponse(401, "set Authorization: Bearer $SUBBY_KEY")
      }

      try {
        if (req.method === "POST" && (url.pathname === "/v1/responses" || url.pathname === "/responses")) {
          const mediaType = req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
          if (mediaType !== "application/json") return errorResponse(415, "content-type must be application/json")
          return await handleResponses(req)
        }
        if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
          return await handleModels(req.signal)
        }
        if (req.method === "GET") {
          const match = url.pathname.match(/^\/(?:v1\/)?models\/(.+)$/)
          if (match) return await handleModel(decodeURIComponent(match[1]!), req.signal)
        }
        return errorResponse(404, `subby proxy: unknown route ${req.method} ${url.pathname}`)
      } catch (e) {
        if (e instanceof ApiError) return errorResponse(e.status, e.message)
        return errorResponse(500, e instanceof Error ? e.message : String(e))
      }
    },
  })
  state.host = host
  state.port = state.server.port ?? 0
}

export function stopProxy(): void {
  state.server?.stop(true)
  state.server = null
  state.port = 0
  state.currentId = null
}
