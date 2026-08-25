import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import * as proxy from "./src/proxy.ts"
import type { Sub } from "./src/types.ts"

const hits: string[] = []
let lastAccept: string | null = null
let lastBody: Record<string, unknown> | null = null
let refreshHits = 0
let modelHits = 0
let modelClientVersion: string | null = null

function freshAccessToken(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3_600 })).toString("base64url")
  return `header.${payload}.signature`
}

const upstream = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    const acct = req.headers.get("chatgpt-account-id")
    if (url.pathname === "/oauth/token") {
      refreshHits++
      const params = new URLSearchParams(await req.text())
      if (params.get("refresh_token") === "transient-K") return new Response("unavailable", { status: 503 })
      return Response.json({ access_token: freshAccessToken(), refresh_token: "rotated" })
    }
    if (url.pathname === "/codex/models") {
      modelHits++
      modelClientVersion = url.searchParams.get("client_version")
      if (acct === "A") return new Response("forbidden", { status: 403 })
      return Response.json({ models: [{ slug: "gpt-5.6-sol" }, { slug: "gpt-dynamic" }] })
    }
    if (url.pathname === "/wham/usage") {
      if (acct === "D") return new Response("usage unavailable", { status: 503 })
      if (acct === "H") {
        await Bun.sleep(1_000)
        return Response.json({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 0 } } })
      }
      const used = acct === "A" || acct === "E" ? 100 : acct === "B" ? 40 : acct === "C" || acct === "G" || acct === "I" ? 10 : 0
      return Response.json({
        plan_type: "plus",
        rate_limit: { primary_window: { used_percent: used, limit_window_seconds: 5 * 3600, reset_at: Math.ceil(Date.now() / 1000) + 3600 } },
      })
    }
    if (url.pathname === "/codex/responses") {
      hits.push(acct!)
      lastAccept = req.headers.get("accept")
      const body = (await req.json()) as Record<string, unknown>
      lastBody = body
      if (acct === "A") return Response.json({ error: { message: "Monthly usage limit reached (GoUsageLimitError)" } }, { status: 429 })
      if (acct === "B" && body.fail) return Response.json({ error: { message: "Monthly usage limit reached" } }, { status: 429 })
      if (acct === "F" || (acct === "J" && req.headers.get("authorization") === "Bearer tok-J")) {
        return Response.json({ error: { message: "unauthorized" } }, { status: 401 })
      }
      if (!body.stream) return Response.json({ detail: "Stream must be set to true" }, { status: 400 })
      const response = { id: "resp_1", account: acct, store: body.store, model: body.model, output: [] }
      const events = [
        `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", account: acct } })}`,
        `data: ${JSON.stringify({ type: "response.completed", response })}`,
        "data: [DONE]",
      ]
      return new Response(`${events.join("\n\n")}\n\n`, { headers: { "content-type": "text/event-stream" } })
    }
    return new Response("not found", { status: 404 })
  },
})

function makeSub(id: string): Sub {
  return {
    id,
    provider: "codex",
    label: `sub-${id}`,
    tokens: { access: `tok-${id}`, refresh: "", expiresAt: Date.now() + 24 * 3600_000, accountId: id },
  }
}

let base = ""

beforeAll(() => {
  process.env.SUBBY_CHATGPT_BASE = `http://127.0.0.1:${upstream.port}`
  process.env.SUBBY_OPENAI_TOKEN_URL = `http://127.0.0.1:${upstream.port}/oauth/token`
  proxy.setSubSource(() => [makeSub("A"), makeSub("B"), makeSub("C")])
  proxy.setSubSaver(() => {})
  proxy.startProxy(0)
  base = `http://127.0.0.1:${proxy.info().port}`
})

afterAll(() => {
  proxy.stopProxy()
  proxy.setSubSaver(null)
  delete process.env.SUBBY_CHATGPT_BASE
  delete process.env.SUBBY_OPENAI_TOKEN_URL
  upstream.stop(true)
})

async function json(res: Response): Promise<any> {
  return res.json()
}

async function responses(body: Record<string, unknown>) {
  return fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("subby proxy", () => {
  test("reports the OpenAI-compatible base URL", () => {
    expect(proxy.info().url).toBe(`${base}/v1`)
  })

  test("/v1/models lists the upstream Codex catalog", async () => {
    const res = await fetch(`${base}/v1/models`)
    const j = await json(res)
    expect(res.status).toBe(200)
    expect(j.object).toBe("list")
    expect(j.data.map((m: any) => m.id)).toEqual(["gpt-5.6-sol", "gpt-dynamic"])
    expect(modelClientVersion).toBe("0.147.0")
  })

  test("/v1/models/:model retrieves a model from the cached catalog", async () => {
    const res = await fetch(`${base}/v1/models/gpt-dynamic`)
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ id: "gpt-dynamic", object: "model", created: 0, owned_by: "openai" })
    expect(modelHits).toBe(2)
  })

  test("retrieving an unknown model returns 404", async () => {
    const res = await fetch(`${base}/v1/models/not-a-model`)
    expect(res.status).toBe(404)
    expect((await json(res)).error.message).toMatch(/not found/i)
  })

  test("serves the cached catalog without an available subscription", async () => {
    proxy.setSubSource(() => [])
    try {
      const res = await fetch(`${base}/v1/models`)
      expect(res.status).toBe(200)
      expect((await json(res)).data).toHaveLength(2)
      expect(modelHits).toBe(2)
    } finally {
      proxy.setSubSource(() => [makeSub("A"), makeSub("B"), makeSub("C")])
    }
  })

  test("rotates to most available sub on first request", async () => {
    // A=100% used, B=40%, C=10% → C should win
    const res = await responses({ model: "gpt-5.4", input: "hi" })
    const j = await json(res)
    expect(res.status).toBe(200)
    expect(j.account).toBe("C")
    expect(hits).toEqual(["C"])
  })

  test("stays sticky on the current sub", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await responses({ model: "gpt-5.4", input: "again" })
      expect((await json(res)).account).toBe("C")
    }
    expect(hits.every((h) => h === "C")).toBe(true)
  })

  test("forces store:false like the codex backend requires", async () => {
    const res = await responses({ model: "gpt-5.4", input: "x", store: true })
    const j = await json(res)
    expect(j.store).toBe(false)
  })

  test("strips prompt_cache_options some codex accounts reject", async () => {
    const res = await responses({ model: "gpt-5.4", input: "x", prompt_cache_key: "k", prompt_cache_options: { ttl: "1h" } })
    expect(res.status).toBe(200)
    expect(lastBody).not.toHaveProperty("prompt_cache_options")
    expect(lastBody?.prompt_cache_key).toBe("k")
  })

  test("strips prompt_cache_breakpoint markers from input items", async () => {
    const res = await responses({
      model: "gpt-5.4",
      input: [
        { role: "user", type: "message", content: "x", prompt_cache_breakpoint: { mode: "explicit" } },
        { role: "system", type: "message", content: [{ type: "input_text", text: "y", prompt_cache_breakpoint: { mode: "explicit" } }] },
      ],
    })
    expect(res.status).toBe(200)
    const items = lastBody?.input as Record<string, unknown>[]
    expect(items[0]).not.toHaveProperty("prompt_cache_breakpoint")
    expect(items[0]?.content).toBe("x")
    const parts = items[1]?.content as Record<string, unknown>[]
    expect(parts[0]).not.toHaveProperty("prompt_cache_breakpoint")
    expect(parts[0]?.text).toBe("y")
    // system role rewritten to developer (backend rejects system)
    expect(items[1]?.role).toBe("developer")
  })

  test("aggregates SSE into JSON for non-streaming clients", async () => {
    const res = await responses({ model: "gpt-5.4", input: "x", stream: false })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
    // upstream acceptance of non-SSE varies by account: always stream up
    expect(lastAccept).toBe("text/event-stream")
    expect(lastBody?.stream).toBe(true)
    const j = await json(res)
    expect(j.id).toBe("resp_1")
    expect(j.output).toHaveLength(1)
  })

  test("passes through streaming responses", async () => {
    const res = await responses({ model: "gpt-5.4", input: "x", stream: true })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    expect(lastAccept).toBe("text/event-stream")
    expect(await res.text()).toContain("data: [DONE]")
  })

  test("emulates response chaining across stateless upstream", async () => {
    const first = await responses({ model: "gpt-5.4", input: [{ role: "user", type: "message", content: "hi" }] })
    expect((await json(first)).id).toBe("resp_1")
    const second = await responses({
      model: "gpt-5.4",
      previous_response_id: "resp_1",
      input: [{ type: "custom_tool_call_output", call_id: "call_1", output: "done" }],
    })
    expect(second.status).toBe(200)
    const sent = lastBody?.input as Record<string, unknown>[]
    // full history: original user item + replayable output item + the tail
    expect(sent.map((i) => i.type ?? i.role)).toEqual(["message", "message", "custom_tool_call_output"])
    expect(lastBody).not.toHaveProperty("previous_response_id")
  })

  test("unknown previous_response_id is a clear 400", async () => {
    const res = await responses({ model: "gpt-5.4", previous_response_id: "resp_nope", input: [] })
    expect(res.status).toBe(400)
    expect(((await json(res)).error as { message: string }).message).toContain("unknown previous_response_id")
  })

  test("defaults to aggregated non-streaming when stream is omitted", async () => {
    const res = await responses({ model: "gpt-5.4", input: "x" })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
    expect(lastAccept).toBe("text/event-stream")
    expect((await json(res)).id).toBe("resp_1")
  })

  test("uses an account with unknown usage when confirmed accounts are exhausted", async () => {
    proxy.setSubSource(() => [makeSub("E"), makeSub("D")])
    const res = await responses({ model: "gpt-5.4", input: "usage fallback" })
    expect(res.status).toBe(200)
    expect((await json(res)).account).toBe("D")
  })

  test("does not let a hung usage request block a healthy account", async () => {
    process.env.SUBBY_USAGE_TIMEOUT_MS = "20"
    proxy.setSubSource(() => [makeSub("H"), makeSub("I")])
    try {
      const res = await responses({ model: "gpt-5.4", input: "usage timeout" })
      expect(res.status).toBe(200)
      expect((await json(res)).account).toBe("I")
    } finally {
      delete process.env.SUBBY_USAGE_TIMEOUT_MS
    }
  })

  test("deduplicates concurrent refreshes after 401 responses", async () => {
    const sub = makeSub("J")
    sub.tokens.refresh = "refresh-J"
    proxy.setSubSource(() => [sub])
    refreshHits = 0

    const results = await Promise.all([
      responses({ model: "gpt-5.4", input: "concurrent one" }),
      responses({ model: "gpt-5.4", input: "concurrent two" }),
    ])
    expect(results.map((res) => res.status)).toEqual([200, 200])
    expect(refreshHits).toBe(1)
  })

  test("does not quarantine accounts after transient refresh failures", async () => {
    const sub = makeSub("K")
    proxy.setSubSource(() => [sub])
    expect((await json(await responses({ model: "gpt-5.4", input: "establish sticky account" }))).account).toBe("K")

    sub.tokens.refresh = "transient-K"
    sub.tokens.expiresAt = 0
    expect((await responses({ model: "gpt-5.4", input: "transient failure" })).status).toBe(502)

    sub.tokens.refresh = ""
    sub.tokens.expiresAt = Date.now() + 3_600_000
    const recovered = await responses({ model: "gpt-5.4", input: "retry" })
    expect(recovered.status).toBe(200)
    expect((await json(recovered)).account).toBe("K")
  })

  test("fails over after persistent account authorization errors", async () => {
    proxy.setSubSource(() => [makeSub("F"), makeSub("G")])
    hits.length = 0
    const res = await responses({ model: "gpt-5.4", input: "auth fallback" })
    expect(res.status).toBe(200)
    expect((await json(res)).account).toBe("G")
    expect(hits).toEqual(["F", "F", "G"])
  })

  test("fails over when the sticky sub is used up", async () => {
    proxy.setSubSource(() => [makeSub("A"), makeSub("B")])
    hits.length = 0
    const res = await responses({ model: "gpt-5.4", input: "y" })
    expect((await json(res)).account).toBe("B")
    expect(hits).toEqual(["B"])
    const res2 = await responses({ model: "gpt-5.4", input: "z", fail: true })
    expect(res2.status).toBe(429)
    const j2 = await json(res2)
    expect(j2.error.message).toMatch(/used up/i)
  })

  test("chaining to an unknown response id is rejected", async () => {
    const res = await responses({ model: "gpt-5.4", input: "x", previous_response_id: "resp_previous" })
    expect(res.status).toBe(400)
    expect(((await json(res)).error as { message: string }).message).toContain("unknown previous_response_id")
  })

  test("rejects browser-safelisted content types", async () => {
    const before = hits.length
    const res = await fetch(`${base}/v1/responses`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })
    expect(res.status).toBe(415)
    expect(hits).toHaveLength(before)
  })

  test("rejects invalid media types and non-object JSON", async () => {
    const badMediaType = await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json-whoops" },
      body: "{}",
    })
    expect(badMediaType.status).toBe(415)

    const nonObject = await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: "null",
    })
    expect(nonObject.status).toBe(400)
  })

  test("unknown route 404s", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, { method: "POST", body: "{}" })
    expect(res.status).toBe(404)
  })
})
