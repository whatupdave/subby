import { pkce, openBrowser, waitForCode, type CodeWaiter } from "./oauth.ts"
import type { Sub, Usage } from "./types.ts"

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const PORT = 1455
const REDIRECT_URI = `http://localhost:${PORT}/auth/callback`
const TOKEN_URL = "https://auth.openai.com/oauth/token"

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
    const res = await fetch(TOKEN_URL, {
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

async function refresh(sub: Sub): Promise<void> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: sub.tokens.refresh,
      client_id: CLIENT_ID,
      scope: "openid profile email",
    }),
  })
  if (!res.ok) throw new Error(`refresh failed: ${res.status}`)
  const j = (await res.json()) as any
  sub.tokens.access = j.access_token
  if (j.refresh_token) sub.tokens.refresh = j.refresh_token
  sub.tokens.expiresAt = jwtClaims(j.access_token).exp * 1000
}

/** Fetch usage; refreshes tokens in place (caller persists subs after polling). */
export async function fetchUsage(sub: Sub): Promise<Usage> {
  if (sub.tokens.refresh && Date.now() > sub.tokens.expiresAt - 60_000) await refresh(sub)
  const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    headers: {
      authorization: `Bearer ${sub.tokens.access}`,
      "chatgpt-account-id": sub.tokens.accountId ?? "",
    },
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
  if (j.email) usage.plan = `${j.plan_type} · ${j.email}`
  return usage
}
