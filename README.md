# subby

TUI for monitoring Claude and Codex subscription usage, with a sticky OpenAI-compatible Codex proxy.

## Run

```bash
bun install
bun run start
```

The proxy starts with the TUI; press **`p`** to stop or restart it. Add Codex subscriptions with **`a`**.

Its OpenAI-compatible base URL is shown in the TUI. By default it listens only on:

```text
http://127.0.0.1:8787/v1
```

## OpenAI-compatible proxy

The proxy implements:

- `POST /v1/responses` (streaming and non-streaming)
- `GET /v1/models`
- `GET /v1/models/:model`

Model endpoints use a five-minute cache of the authenticated Codex model catalog, so newly available models do not require a subby release.

Point an OpenAI Responses API client at it:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
export OPENAI_API_KEY=unused
```

Or use curl:

```bash
curl http://127.0.0.1:8787/v1/responses \
  -H 'Authorization: Bearer unused' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-5.4",
    "input": "Say hello",
    "stream": true
  }'
```

The proxy forces `store: false`, as required by the ChatGPT Codex backend. Responses are stateless, so `previous_response_id` conversation chaining is not supported.

Legacy `POST /v1/chat/completions` is not currently implemented.

## Routing

When the proxy needs an account, it fetches usage for each available Codex subscription and picks the one with the lowest effective usage across its session and weekly windows.

It then stays sticky on that subscription. It only rotates when:

- the Codex backend returns a terminal subscription usage-limit error, or
- the usage endpoint already reports the subscription at 100% while selecting an account.

An exhausted subscription remains skipped until its relevant usage window resets. Transient rate limits and unrelated upstream errors are returned to the client rather than causing account churn.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `SUBBY_HOST` | `127.0.0.1` | Proxy bind address |
| `SUBBY_PORT` | `8787` | Proxy port |
| `SUBBY_KEY` | unset | If set, require `Authorization: Bearer <value>` |
| `SUBBY_CODEX_CLIENT_VERSION` | `0.147.0` | Codex compatibility version sent when fetching the model catalog |

To protect the endpoint with a key:

```bash
SUBBY_KEY=my-local-secret bun run start
```

The proxy binds to localhost by default because it has access to your stored subscription credentials. Do not expose it publicly without authentication and network controls.

## Development

```bash
bun test
bunx tsc --noEmit
```
