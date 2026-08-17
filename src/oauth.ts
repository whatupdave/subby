import { createHash, randomBytes } from "node:crypto"

export interface Pkce {
  verifier: string
  challenge: string
  state: string
}

export function pkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge, state: randomBytes(16).toString("base64url") }
}

export function openBrowser(url: string): void {
  Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" })
}

const SUCCESS_HTML = `<html><body style="font-family:sans-serif;text-align:center;padding-top:4rem">
<h2>Signed in</h2><p>You can close this tab and return to subby.</p></body></html>`

export interface CodeWaiter {
  promise: Promise<{ code: string; state: string }>
  cancel: () => void
}

/** Serve one OAuth callback on localhost, resolve with the auth code, then shut down. */
export function waitForCode(port: number, path: string): CodeWaiter {
  let resolve!: (v: { code: string; state: string }) => void
  let reject!: (e: Error) => void
  const promise = new Promise<{ code: string; state: string }>((res, rej) => {
    resolve = res
    reject = rej
  })
  const server = Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== path) return new Response("not found", { status: 404 })
      const code = url.searchParams.get("code")
      if (!code) {
        reject(new Error(url.searchParams.get("error") ?? "login failed"))
        return new Response("login failed", { status: 400 })
      }
      resolve({ code, state: url.searchParams.get("state") ?? "" })
      return new Response(SUCCESS_HTML, { headers: { "content-type": "text/html" } })
    },
  })
  const cleanup = () => setTimeout(() => server.stop(true), 500)
  promise.then(cleanup, cleanup)
  return {
    promise,
    cancel: () => reject(new Error("cancelled")),
  }
}
