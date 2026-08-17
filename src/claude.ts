import { pkce, openBrowser, waitForCode, type CodeWaiter } from "./oauth.ts"
import type { Sub, Usage } from "./types.ts"

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const PORT = 53692
const REDIRECT_URI = `http://localhost:${PORT}/callback`
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
const SCOPE =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"

export function login(): { promise: Promise<Sub>; cancel: () => void } {
  const { verifier, challenge } = pkce()
  const state = verifier // the server expects the PKCE verifier as state (matches pi/Claude Code)
  const url = new URL("https://claude.ai/oauth/authorize")
  url.search = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  }).toString()

  const waiter: CodeWaiter = waitForCode(PORT, "/callback")
  openBrowser(url.toString())

  const promise = waiter.promise.then(async ({ code }) => {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        state,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }),
    })
    if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`)
    const j = (await res.json()) as any
    return {
      id: crypto.randomUUID(),
      provider: "claude" as const,
      label: j.account?.email_address ?? "claude",
      tokens: {
        access: j.access_token,
        refresh: j.refresh_token,
        expiresAt: Date.now() + j.expires_in * 1000,
      },
    }
  })
  return { promise, cancel: waiter.cancel }
}

async function refresh(sub: Sub): Promise<void> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: sub.tokens.refresh,
      client_id: CLIENT_ID,
    }),
  })
  if (!res.ok) throw new Error(`refresh failed: ${res.status}`)
  const j = (await res.json()) as any
  sub.tokens.access = j.access_token
  if (j.refresh_token) sub.tokens.refresh = j.refresh_token
  sub.tokens.expiresAt = Date.now() + j.expires_in * 1000
}

/** Fetch usage; refreshes tokens in place (caller persists subs after polling). */
export async function fetchUsage(sub: Sub): Promise<Usage> {
  if (sub.tokens.refresh && Date.now() > sub.tokens.expiresAt - 60_000) await refresh(sub)
  const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      authorization: `Bearer ${sub.tokens.access}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
  })
  if (!res.ok) return { error: `usage fetch failed: ${res.status}` }
  const j = (await res.json()) as any
  const win = (w: any) =>
    w ? { pct: w.utilization ?? 0, resetsAt: w.resets_at ? Date.parse(w.resets_at) : null } : undefined
  return { session: win(j.five_hour), weekly: win(j.seven_day) }
}
