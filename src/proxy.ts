import { createHash } from "node:crypto"
import { loadSubs, saveSubs } from "./store.ts"
import { ensureFreshToken, fetchUsage, TokenRefreshError } from "./codex.ts"
import { cachedResponse, cacheResponse } from "./response-cache.ts"
import type { Sub, Usage } from "./types.ts"

const upstreamBase = () => process.env.SUBBY_CHATGPT_BASE ?? "https://chatgpt.com/backend-api"
const responsesUrl = () => `${upstreamBase()}/codex/responses`
const modelsUrl = () => {
  const url = new URL(`${upstreamBase()}/codex/models`)
  url.searchParams.set("client_version", process.env.SUBBY_CODEX_CLIENT_VERSION ?? "0.147.0")
  return url
}
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
  stickyId: string | null
  exhausted: Map<string, number>
  requests: number
  affinityRequests: number
  requestsBySub: Map<string, number>
  lastRoute: "affinity" | "sticky" | null
  openStreams: Set<symbol>
  rateLimits: number
  lastRateLimitAt: number | null
  lastError: string | null
}

const state: ProxyState = {
  server: null,
  host: "127.0.0.1",
  port: 0,
  currentId: null,
  stickyId: null,
  exhausted: new Map<string, number>(),
  requests: 0,
  affinityRequests: 0,
  requestsBySub: new Map<string, number>(),
  lastRoute: null,
  openStreams: new Set(),
  rateLimits: 0,
  lastRateLimitAt: null,
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

const RATE_LIMIT_WARNING_MS = 60_000

export interface ProxyInfo {
  running: boolean
  host: string
  port: number
  url: string | null
  currentId: string | null
  requests: number
  affinityRequests: number
  requestsBySub: Record<string, number>
  lastRoute: "affinity" | "sticky" | null
  openStreams: number
  rateLimits: number
  lastRateLimitAt: number | null
  rateLimited: boolean
  lastError: string | null
}

export function info(): ProxyInfo {
  const running = isRunning()
  const host = state.host.includes(":") && !state.host.startsWith("[") ? `[${state.host}]` : state.host
  return {
    running,
    host: state.host,
    port: state.port,
    url: running ? `http://${host}:${state.port}/v1` : null,
    currentId: state.currentId,
    requests: state.requests,
    affinityRequests: state.affinityRequests,
    requestsBySub: Object.fromEntries(state.requestsBySub),
    lastRoute: state.lastRoute,
    openStreams: state.openStreams.size,
    rateLimits: state.rateLimits,
    lastRateLimitAt: state.lastRateLimitAt,
    rateLimited: state.lastRateLimitAt !== null && Date.now() - state.lastRateLimitAt < RATE_LIMIT_WARNING_MS,
    lastError: state.lastError,
  }
}

const pendingTokenSaves = new Set<string>()
const credentialGenerations = new Map<string, number>()

function credentialGeneration(id: string): number {
  return credentialGenerations.get(id) ?? 0
}

export function credentialsUpdated(id: string): void {
  credentialGenerations.set(id, credentialGeneration(id) + 1)
  state.exhausted.delete(id)
  pendingTokenSaves.delete(id)
}

function saveRefreshedToken(sub: Sub, previousAccessToken: string, generation: number): void {
  if (generation !== credentialGeneration(sub.id)) return
  if (sub.tokens.access !== previousAccessToken) pendingTokenSaves.add(sub.id)
  if (!pendingTokenSaves.has(sub.id)) return
  persistSubs(getSubs())
  pendingTokenSaves.delete(sub.id)
}

async function refreshExhaustion(sub: Sub, generation: number): Promise<void> {
  const before = sub.tokens.access
  const usage = await fetchUsage(sub, AbortSignal.timeout(usageTimeoutMs())).catch(() => undefined)
  if (!usage || generation !== credentialGeneration(sub.id)) return
  saveRefreshedToken(sub, before, generation)
  exhaust(sub, usage, generation)
}

function exhaust(sub: Sub, usage: Usage | undefined, generation: number): void {
  if (generation !== credentialGeneration(sub.id)) return
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
  if (state.stickyId === sub.id) state.stickyId = null
}

interface SubAffinity {
  key: string
  preferredSubId: string | null
}

function affinitySub(usable: Sub[], affinity: SubAffinity): Sub {
  const preferred = usable.find((sub) => sub.id === affinity.preferredSubId)
  if (preferred) return preferred

  let selected = usable[0]!
  let highest = createHash("sha256").update(affinity.key).update("\0").update(selected.id).digest().readBigUInt64BE()
  for (let i = 1; i < usable.length; i++) {
    const candidate = usable[i]!
    const score = createHash("sha256").update(affinity.key).update("\0").update(candidate.id).digest().readBigUInt64BE()
    if (score <= highest) continue
    selected = candidate
    highest = score
  }
  return selected
}

/**
 * Pick the sub to serve a request without blocking on usage telemetry.
 * Affinity requests use rendezvous hashing; unkeyed requests stay sticky.
 */
function pickSub(affinity: SubAffinity | null): Sub {
  const now = Date.now()
  for (const [id, until] of state.exhausted) if (until <= now) state.exhausted.delete(id)

  const codexSubs = getSubs().filter((s) => s.provider === "codex")
  if (!codexSubs.length) throw new ApiError(503, "no codex subs configured in subby")

  if (!affinity) {
    const current = codexSubs.find((s) => s.id === state.stickyId && !state.exhausted.has(s.id))
    if (current) return current
  }

  const available = codexSubs.filter((s) => !state.exhausted.has(s.id))
  if (!available.length) {
    const soonest = Math.min(...codexSubs.map((s) => state.exhausted.get(s.id) ?? now))
    throw new ApiError(429, `all codex subs are used up; next reset in ${Math.ceil((soonest - now) / 60_000)} min`)
  }

  const selected = affinity ? affinitySub(available, affinity) : available[0]!
  if (!affinity) state.stickyId = selected.id
  state.currentId = selected.id
  return selected
}

async function withAccessToken(sub: Sub, forceFresh: boolean, request: (accessToken: string) => Promise<Response>, generation: number) {
  const before = sub.tokens.access
  try {
    await ensureFreshToken(sub, forceFresh)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    throw new AccountAuthError(message, e instanceof TokenRefreshError && e.permanent)
  }
  saveRefreshedToken(sub, before, generation)

  const accessToken = sub.tokens.access
  return { response: await request(accessToken), accessToken }
}

async function withAuthRetry(sub: Sub, request: (accessToken: string) => Promise<Response>, generation = credentialGeneration(sub.id)): Promise<Response> {
  const first = await withAccessToken(sub, false, request, generation)
  if (first.response.status !== 401) return first.response
  await first.response.text()

  const forceRefresh = sub.tokens.access === first.accessToken
  const retry = await withAccessToken(sub, forceRefresh, request, generation)
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

function forward(sub: Sub, body: string, signal: AbortSignal, generation: number): Promise<Response> {
  return abortable(
    () => withAuthRetry(sub, (accessToken) => {
      const sessionId = crypto.randomUUID()
      return fetch(responsesUrl(), {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "chatgpt-account-id": sub.tokens.accountId ?? "",
          "content-type": "application/json",
          accept: "text/event-stream",
          "openai-beta": "responses=experimental",
          originator: "subby",
          "user-agent": "subby",
          "session-id": sessionId,
          "x-client-request-id": sessionId,
        },
        body,
        signal,
      })
    }, generation),
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

function trackOpenStream(upstream: Response, signal: AbortSignal): Response {
  if (!upstream.body) return upstream

  const reader = upstream.body.getReader()
  const streamId = Symbol()
  let onAbort: (() => void) | null = null
  state.openStreams.add(streamId)
  const close = () => {
    if (!state.openStreams.delete(streamId)) return
    if (onAbort) signal.removeEventListener("abort", onAbort)
  }
  onAbort = () => {
    close()
    void reader.cancel(signal.reason).catch(() => {})
  }
  if (signal.aborted) onAbort()
  else signal.addEventListener("abort", onAbort, { once: true })

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          close()
          controller.close()
        } else {
          controller.enqueue(value)
        }
      } catch (error) {
        close()
        controller.error(error)
      }
    },
    async cancel(reason) {
      close()
      await reader.cancel(reason).catch(() => {})
    },
  })
  return passthrough(upstream, body)
}

interface CompletedResponse {
  id?: unknown
  output?: unknown[]
  [key: string]: unknown
}

interface ResponseStreamState {
  terminal?: CompletedResponse
  error?: unknown
  items: Map<number, unknown>
  nextItemIndex: number
  remembered?: boolean
}

const SSE_EVENT_SEPARATOR = /(?:\r\n|\r|\n){2}/

function consumeSseEvent(chunk: string, state: ResponseStreamState): void {
  const payload = chunk
    .split(/\r\n|\r|\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim()
  if (!payload || payload === "[DONE]") return

  let event: { type?: string; response?: unknown; item?: unknown; output_index?: unknown }
  try {
    event = JSON.parse(payload)
  } catch {
    return
  }
  if (event.type === "response.output_item.done" && event.item !== undefined) {
    const index = typeof event.output_index === "number" && Number.isInteger(event.output_index) && event.output_index >= 0
      ? event.output_index
      : state.nextItemIndex
    state.items.set(index, event.item)
    state.nextItemIndex = Math.max(state.nextItemIndex, index + 1)
  }
  if (
    (event.type === "response.completed" || event.type === "response.incomplete" || event.type === "response.failed") &&
    event.response &&
    typeof event.response === "object"
  ) {
    state.terminal = event.response as CompletedResponse
  }
  if (event.type === "error") state.error = event
}

function rememberTerminalResponse(state: ResponseStreamState, input: unknown[], subId: string): void {
  const terminal = state.terminal
  if (!terminal || state.remembered) return
  if (!terminal.output?.length) terminal.output = [...state.items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item)
  rememberResponse(terminal, input, subId)
  state.remembered = true
}

async function aggregateResponse(upstream: Response, input: unknown[], previousResponseId: string | null, subId: string): Promise<Response> {
  if (!upstream.body) return errorResponse(502, "upstream returned an empty response stream")
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  const state: ResponseStreamState = { items: new Map(), nextItemIndex: 0 }
  let buffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let separator = SSE_EVENT_SEPARATOR.exec(buffer)
      while (separator?.index !== undefined) {
        consumeSseEvent(buffer.slice(0, separator.index), state)
        buffer = buffer.slice(separator.index + separator[0].length)
        if (state.terminal) break
        separator = SSE_EVENT_SEPARATOR.exec(buffer)
      }
      if (state.terminal) {
        await reader.cancel().catch(() => {})
        break
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) consumeSseEvent(buffer, state)
  } catch (error) {
    return errorResponse(502, `upstream response stream failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  const terminal = state.terminal
  if (!terminal) {
    const detail = state.error ? `: ${JSON.stringify(state.error).slice(0, 300)}` : ""
    return errorResponse(502, `upstream stream ended without a terminal response event${detail}`)
  }
  rememberTerminalResponse(state, input, subId)
  if (previousResponseId) terminal.previous_response_id = previousResponseId
  return Response.json(terminal)
}

function rewriteSsePreviousResponseId(frame: string, previousResponseId: string): string {
  const lines = frame.split(/\r\n|\r|\n/)
  const payload = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim()
  if (!payload || payload === "[DONE]") return frame

  let event: { response?: unknown }
  try {
    event = JSON.parse(payload)
  } catch {
    return frame
  }
  if (!event.response || typeof event.response !== "object") return frame
  const response = event.response as Record<string, unknown>
  response.previous_response_id = previousResponseId

  let replaced = false
  return lines
    .filter((line) => {
      if (!line.startsWith("data:")) return true
      if (replaced) return false
      replaced = true
      return true
    })
    .map((line) => line.startsWith("data:") ? `data: ${JSON.stringify(event)}` : line)
    .join("\n")
}

function captureStream(upstream: Response, input: unknown[], previousResponseId: string | null, subId: string): Response {
  if (!upstream.body) return passthrough(upstream)
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const state: ResponseStreamState = { items: new Map(), nextItemIndex: 0 }
  let buffer = ""
  const body = upstream.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      let separator = SSE_EVENT_SEPARATOR.exec(buffer)
      while (separator?.index !== undefined) {
        const frame = buffer.slice(0, separator.index)
        buffer = buffer.slice(separator.index + separator[0].length)
        consumeSseEvent(frame, state)
        rememberTerminalResponse(state, input, subId)
        if (previousResponseId) {
          controller.enqueue(encoder.encode(`${rewriteSsePreviousResponseId(frame, previousResponseId)}\n\n`))
        }
        separator = SSE_EVENT_SEPARATOR.exec(buffer)
      }
      if (!previousResponseId) controller.enqueue(chunk)
    },
    flush(controller) {
      buffer += decoder.decode()
      if (!buffer) return
      consumeSseEvent(buffer, state)
      rememberTerminalResponse(state, input, subId)
      if (previousResponseId) controller.enqueue(encoder.encode(rewriteSsePreviousResponseId(buffer, previousResponseId)))
    },
  }))
  return passthrough(upstream, body)
}

function responseInputItems(input: unknown): unknown[] {
  if (Array.isArray(input)) return input
  if (input === undefined || input === null) return []
  if (typeof input === "string") {
    return [{ role: "user", content: [{ type: "input_text", text: input }] }]
  }
  return [input]
}

function rememberResponse(completed: CompletedResponse, input: unknown[], subId: string): void {
  if (typeof completed.id !== "string" || !Array.isArray(completed.output)) return
  try {
    cacheResponse(completed.id, input, completed.output, subId)
  } catch (error) {
    state.lastError = `response cache write failed: ${error instanceof Error ? error.message : String(error)}`
  }
}

function inlinePreviousResponse(parsed: Record<string, unknown>): { id: string; subId: string } | string | null {
  if (parsed.previous_response_id === undefined || parsed.previous_response_id === null) return null
  const id = String(parsed.previous_response_id)
  const prior = cachedResponse(id)
  if (!prior) return "unknown previous_response_id: subby has no cached response with that id"
  parsed.input = [...prior.input, ...prior.output, ...responseInputItems(parsed.input)]
  delete parsed.previous_response_id
  return { id, subId: prior.subId }
}

function normalizeForCodexBackend(parsed: Record<string, unknown>): void {
  delete parsed.prompt_cache_key
  delete parsed.prompt_cache_retention
  delete parsed.prompt_cache_options
  delete parsed.max_output_tokens
  if (typeof parsed.input === "string") parsed.input = responseInputItems(parsed.input)
  if (!Array.isArray(parsed.input)) return
  for (const item of parsed.input) {
    if (!item || typeof item !== "object") continue
    const message = item as Record<string, unknown>
    if (message.role === "system") message.role = "developer"
    delete message.prompt_cache_breakpoint
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part && typeof part === "object") delete (part as Record<string, unknown>).prompt_cache_breakpoint
    }
  }
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
  const previous = inlinePreviousResponse(parsed)
  if (typeof previous === "string") return errorResponse(400, previous)
  const promptCacheKey = typeof parsed.prompt_cache_key === "string" && parsed.prompt_cache_key
    ? parsed.prompt_cache_key
    : null
  const affinity: SubAffinity | null = promptCacheKey || previous
    ? { key: promptCacheKey ?? previous!.id, preferredSubId: previous?.subId ?? null }
    : null
  parsed.store = false
  normalizeForCodexBackend(parsed)
  // The ChatGPT Codex backend only serves SSE ("Stream must be set to true"),
  // so always stream upstream and aggregate for non-streaming clients.
  const clientStream = parsed.stream === true
  parsed.stream = true
  const body = JSON.stringify(parsed)

  const attempts = Math.max(1, getSubs().filter((s) => s.provider === "codex").length)
  let terminalStatus = 429

  for (let i = 0; i < attempts; i++) {
    const sub = pickSub(affinity)
    const generation = credentialGeneration(sub.id)
    let res: Response
    try {
      res = await forward(sub, body, req.signal, generation)
    } catch (e) {
      state.lastError = e instanceof Error ? e.message : String(e)
      if (e instanceof AccountAuthError) {
        if (!e.permanent) return errorResponse(502, `token refresh failed: ${state.lastError}`)
        exhaust(sub, undefined, generation)
        terminalStatus = 503
        continue
      }
      return errorResponse(502, `upstream request failed: ${state.lastError}`)
    }

    if (res.ok) {
      state.requests++
      if (affinity) state.affinityRequests++
      state.requestsBySub.set(sub.id, (state.requestsBySub.get(sub.id) ?? 0) + 1)
      state.lastRoute = affinity ? "affinity" : "sticky"
      state.lastError = null
      const tracked = trackOpenStream(res, req.signal)
      const input = responseInputItems(parsed.input)
      if (clientStream) return captureStream(tracked, input, previous?.id ?? null, sub.id)
      return await aggregateResponse(tracked, input, previous?.id ?? null, sub.id)
    }

    const text = await res.text()

    // sub is used up — mark exhausted and fail over to the next one
    if (isUsageLimitError(res.status, text)) {
      exhaust(sub, undefined, generation)
      void refreshExhaustion(sub, generation).catch(() => {})
      state.lastError = `${sub.label} used up, failing over`
      continue
    }

    // Anything else is a real upstream error — pass it through. Keep transient
    // 429 telemetry separate from terminal subscription usage limits above.
    if (res.status === 429) {
      state.rateLimits++
      state.lastRateLimitAt = Date.now()
    }
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
    const generation = credentialGeneration(sub.id)
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
          generation,
        ),
        requestSignal,
      )
    } catch (e) {
      if (e instanceof AccountAuthError) {
        failure = new ApiError(e.permanent ? 503 : 502, `token refresh failed: ${e.message}`)
        if (e.permanent) exhaust(sub, undefined, generation)
      } else {
        failure = new ApiError(502, `models request failed: ${e instanceof Error ? e.message : String(e)}`)
      }
      continue
    }
    if (res.status === 403) {
      await res.text()
      exhaust(sub, undefined, generation)
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
      if (generation !== credentialGeneration(sub.id)) return modelIds(signal)
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
  state.stickyId = null
  state.openStreams.clear()
}
