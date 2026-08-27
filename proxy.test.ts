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
        if (body.delayAuth) await Bun.sleep(50)
        return Response.json({ error: { message: "unauthorized" } }, { status: 401 })
      }
      if (!body.stream) return Response.json({ detail: "Stream must be set to true" }, { status: 400 })
      if (body.model === "test-rate-limit") return Response.json({ error: { message: "Too many concurrent requests" } }, { status: 429 })
      const status = body.model === "test-incomplete" ? "incomplete" : body.model === "test-failed" ? "failed" : "completed"
      const response = {
        id: "resp_1",
        account: acct,
        store: body.store,
        model: body.model,
        status,
        output: [],
        previous_response_id: null,
        error: status === "failed" ? { code: "server_error", message: "generation failed" } : null,
        incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
      }
      const outputItems = body.model === "test-reversed"
        ? [
            { output_index: 1, item: { type: "message", content: "second" } },
            { output_index: 0, item: { type: "message", content: "first" } },
          ]
        : body.model === "test-reasoning"
          ? [
              { output_index: 0, item: { type: "reasoning", encrypted_content: "encrypted" } },
              { output_index: 1, item: { type: "function_call", call_id: "c1", name: "lookup", arguments: "{}" } },
            ]
          : [{ output_index: 0, item: { type: "message", account: acct } }]
      const events = status === "failed"
        ? []
        : outputItems.map(({ output_index, item }) => `data: ${JSON.stringify({ type: "response.output_item.done", output_index, item })}`)
      events.push(`data: ${JSON.stringify({ type: `response.${status}`, response })}`, "data: [DONE]")
      const separator = body.model === "test-cr-framing" ? "\r\r" : "\r\n\r\n"
      const payload = `${events.join(separator)}${separator}`
      if (body.model === "test-delayed-stream") {
        return new Response(new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder()
            controller.enqueue(encoder.encode(": stream opened\n\n"))
            setTimeout(() => {
              controller.enqueue(encoder.encode(payload))
              controller.close()
            }, 50)
          },
        }), { headers: { "content-type": "text/event-stream" } })
      }
      if (body.model === "test-terminal-open") {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(payload))
          },
        }), { headers: { "content-type": "text/event-stream" } })
      }
      return new Response(payload, { headers: { "content-type": "text/event-stream" } })
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

  test("aggregates SSE into JSON for explicit non-streaming clients", async () => {
    const res = await responses({ model: "gpt-5.4", input: "x", stream: false })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
    expect(lastAccept).toBe("text/event-stream")
    expect(lastBody?.stream).toBe(true)
    const j = await json(res)
    expect(j.id).toBe("resp_1")
    expect(j.output).toHaveLength(1)
  })

  test("preserves incomplete and failed terminal responses", async () => {
    for (const [model, status] of [["test-incomplete", "incomplete"], ["test-failed", "failed"]]) {
      const res = await responses({ model, input: "x" })
      expect(res.status).toBe(200)
      expect((await json(res)).status).toBe(status)
    }
  })

  test("returns after a terminal event without waiting for upstream EOF", async () => {
    const res = await responses({ model: "test-terminal-open", input: "x" })
    expect(res.status).toBe(200)
    expect((await json(res)).status).toBe("completed")
  })

  test("orders aggregated output by output_index", async () => {
    const res = await responses({ model: "test-reversed", input: "x" })
    const output = (await json(res)).output as { content: string }[]
    expect(output.map((item) => item.content)).toEqual(["first", "second"])
  })

  test("accepts CR-only SSE framing", async () => {
    const res = await responses({ model: "test-cr-framing", input: "x" })
    expect(res.status).toBe(200)
    expect((await json(res)).status).toBe("completed")
  })

  test("passes through streaming responses", async () => {
    const res = await responses({ model: "gpt-5.4", input: "x", stream: true })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    expect(lastAccept).toBe("text/event-stream")
    expect(await res.text()).toContain("data: [DONE]")
  })

  test("reports concurrent response streams until they close", async () => {
    const streams = await Promise.all([
      responses({ model: "test-delayed-stream", input: "one", stream: true }),
      responses({ model: "test-delayed-stream", input: "two", stream: true }),
    ])
    expect(streams.every((res) => res.status === 200)).toBe(true)
    expect(proxy.info().openStreams).toBe(2)

    const bodies = await Promise.all(streams.map((res) => res.text()))
    expect(bodies.every((body) => body.includes("data: [DONE]"))).toBe(true)
    expect(proxy.info().openStreams).toBe(0)
  })

  test("reports transient upstream rate limits", async () => {
    const before = proxy.info().rateLimits
    const res = await responses({ model: "test-rate-limit", input: "x" })
    expect(res.status).toBe(429)
    expect(proxy.info().rateLimits).toBe(before + 1)
    expect(proxy.info().rateLimited).toBe(true)
    expect(proxy.info().lastRateLimitAt).toBeNumber()
  })

  test("defaults to aggregated non-streaming when stream is omitted", async () => {
    const res = await responses({ model: "gpt-5.4", input: "x" })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
    expect(lastAccept).toBe("text/event-stream")
    expect(lastBody?.stream).toBe(true)
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

  test("does not requarantine an account when old credentials fail after reauthentication", async () => {
    const rejected = makeSub("F")
    proxy.credentialsUpdated(rejected.id)
    proxy.setSubSource(() => [rejected])
    const oldRequest = responses({ model: "gpt-5.4", input: "reject old credentials", delayAuth: true })
    await Bun.sleep(10)

    const reauthenticated = makeSub("C")
    reauthenticated.id = rejected.id
    proxy.setSubSource(() => [reauthenticated])
    proxy.credentialsUpdated(reauthenticated.id)
    expect((await oldRequest).status).toBe(503)

    const res = await responses({ model: "gpt-5.4", input: "use new credentials" })
    expect(res.status).toBe(200)
    expect((await json(res)).account).toBe("C")
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

  test("rejects chaining off a response it has never served", async () => {
    const res = await responses({ model: "gpt-5.4", input: "x", previous_response_id: "resp_previous" })
    expect(res.status).toBe(400)
    expect((await json(res)).error.message).toMatch(/unknown previous_response_id/i)
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

  test("normalizes regular-API requests for the codex backend", async () => {
    proxy.setSubSource(() => [makeSub("C")])
    const res = await responses({
      model: "gpt-5.5",
      prompt_cache_key: "k",
      prompt_cache_retention: "24h",
      prompt_cache_options: { mode: "explicit" },
      max_output_tokens: 64,
      input: [
        {
          role: "system",
          type: "message",
          prompt_cache_breakpoint: { mode: "explicit" },
          content: [{ type: "input_text", text: "sys", prompt_cache_breakpoint: { mode: "explicit" } }],
        },
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
    })
    expect(res.status).toBe(200)
    expect(lastBody?.prompt_cache_key).toBeUndefined()
    expect(lastBody?.prompt_cache_retention).toBeUndefined()
    expect(lastBody?.prompt_cache_options).toBeUndefined()
    expect(lastBody?.max_output_tokens).toBeUndefined()
    const input = lastBody?.input as Record<string, unknown>[]
    expect(input[0]!.role).toBe("developer")
    expect(input[0]!.prompt_cache_breakpoint).toBeUndefined()
    const part = (input[0]!.content as Record<string, unknown>[])[0]!
    expect(part.prompt_cache_breakpoint).toBeUndefined()
    expect(input[1]!.role).toBe("user")
  })

  test("emulates previous_response_id chaining by inlining the cached transcript", async () => {
    proxy.setSubSource(() => [makeSub("C")])
    const first = await responses({ model: "gpt-5.4", input: "turn one" })
    const firstId = (await json(first)).id
    expect(firstId).toBe("resp_1")

    const res = await responses({
      model: "gpt-5.4",
      previous_response_id: firstId,
      input: [{ type: "function_call_output", call_id: "c1", output: "ok" }],
    })
    expect(res.status).toBe(200)
    expect((await json(res)).previous_response_id).toBe(firstId)
    expect(lastBody?.previous_response_id).toBeUndefined()
    const forwarded = lastBody?.input as Record<string, unknown>[]
    expect(forwarded).toHaveLength(3)
    expect(forwarded[0]).toEqual({ role: "user", content: "turn one" })
    expect(forwarded[1]!.type).toBe("message")
    expect(forwarded[2]!.type).toBe("function_call_output")
  })

  test("preserves previous_response_id in chained streams", async () => {
    const first = await responses({ model: "gpt-5.4", input: "turn one" })
    const firstId = (await json(first)).id

    const res = await responses({
      model: "gpt-5.4",
      previous_response_id: firstId,
      input: "turn two",
      stream: true,
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain(`"previous_response_id":"${firstId}"`)
    expect(lastBody?.previous_response_id).toBeUndefined()
  })

  test("replays encrypted reasoning items when chaining", async () => {
    const first = await responses({
      model: "test-reasoning",
      input: "investigate",
      include: ["reasoning.encrypted_content"],
    })
    const firstId = (await json(first)).id

    const res = await responses({
      model: "test-reasoning",
      previous_response_id: firstId,
      input: [{ type: "function_call_output", call_id: "c1", output: "result" }],
    })
    expect(res.status).toBe(200)
    const forwarded = lastBody?.input as Record<string, unknown>[]
    expect(forwarded[1]).toEqual({ type: "reasoning", encrypted_content: "encrypted" })
    expect(forwarded[2]!.type).toBe("function_call")
    expect(forwarded[3]!.type).toBe("function_call_output")
  })
})
