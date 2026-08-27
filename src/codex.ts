import { pkce, openBrowser, waitForCode, type CodeWaiter } from "./oauth.ts"
import type { Sub, Usage } from "./types.ts"

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const PORT = 1455
const REDIRECT_URI = `http://localhost:${PORT}/auth/callback`
const tokenUrl = () => process.env.SUBBY_OPENAI_TOKEN_URL ?? "https://auth.openai.com/oauth/token"
const apiBase = () => process.env.SUBBY_CHATGPT_BASE ?? "https://chatgpt.com/backend-api"

function jwtClaims(token: string): any {
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString())
}

export function login(): { promise: Promise<Sub>; cancel: () => void } {
  const { verifier, challenge, state } = pkce()
  const url = new URL("https://auth.openai.com/oauth/authorize")
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "openid profile email offline_access",
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
  }).toString()

  const waiter: CodeWaiter = waitForCode(PORT, "/auth/callback")
  openBrowser(url.toString())

  const promise = waiter.promise.then(async ({ code }) => {
    const res = await fetch(tokenUrl(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: verifier,
      }),
    })
    if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`)
    const j = (await res.json()) as any
    const id = jwtClaims(j.id_token)
    const auth = id["https://api.openai.com/auth"] ?? {}
    return {
      id: crypto.randomUUID(),
      provider: "codex" as const,
      label: id.email ?? "codex",
      tokens: {
        access: j.access_token,
        refresh: j.refresh_token,
        expiresAt: jwtClaims(j.access_token).exp * 1000,
        accountId: auth.chatgpt_account_id,
      },
    }
  })
  return { promise, cancel: waiter.cancel }
}

export class TokenRefreshError extends Error {
  constructor(message: string, public permanent: boolean) {
    super(message)
  }
}

async function refresh(sub: Sub): Promise<void> {
  let res: Response
  try {
    res = await fetch(tokenUrl(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: sub.tokens.refresh,
        client_id: CLIENT_ID,
        scope: "openid profile email",
      }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (e) {
    throw new TokenRefreshError(`refresh failed: ${e instanceof Error ? e.message : String(e)}`, false)
  }
  if (!res.ok) {
    const permanent = res.status === 400 || res.status === 401 || res.status === 403
    throw new TokenRefreshError(`refresh failed: ${res.status}`, permanent)
  }
  const j = (await res.json()) as any
  sub.tokens.access = j.access_token
  if (j.refresh_token) sub.tokens.refresh = j.refresh_token
  sub.tokens.expiresAt = jwtClaims(j.access_token).exp * 1000
}

const refreshing = new Map<string, Promise<void>>()

/** Refresh the sub's token if stale (or forced). Deduped per sub so concurrent callers share one refresh. */
export async function ensureFreshToken(sub: Sub, force = false): Promise<void> {
  if (!sub.tokens.refresh) return
  if (!force && Date.now() <= sub.tokens.expiresAt - 60_000) return
  let p = refreshing.get(sub.id)
  if (!p) {
    p = refresh(sub).finally(() => refreshing.delete(sub.id))
    refreshing.set(sub.id, p)
  }
  await p
}

/** Fetch usage; refreshes tokens in place (caller persists subs after polling). */
export async function fetchUsage(sub: Sub, signal = AbortSignal.timeout(10_000)): Promise<Usage> {
  await ensureFreshToken(sub)
  const res = await fetch(`${apiBase()}/wham/usage`, {
    headers: {
      authorization: `Bearer ${sub.tokens.access}`,
      "chatgpt-account-id": sub.tokens.accountId ?? "",
    },
    signal,
  })
  if (!res.ok) return { error: `usage fetch failed: ${res.status}` }
  const j = (await res.json()) as any
  const usage: Usage = { plan: j.plan_type }
  for (const w of [j.rate_limit?.primary_window, j.rate_limit?.secondary_window]) {
    if (!w) continue
    const win = { pct: w.used_percent ?? 0, resetsAt: w.reset_at ? w.reset_at * 1000 : null }
    // 5h session window vs 7-day weekly window, classified by window length
    if (w.limit_window_seconds <= 100_000) usage.session = win
    else usage.weekly = win
  }
  return usage
}
