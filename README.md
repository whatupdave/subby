# subby

TUI for monitoring Claude and Codex subscription usage, with a sticky OpenAI-compatible Codex proxy.

## Run

```bash
bun install
bun run start
```

The proxy starts with the TUI; press **`p`** to stop or restart it. Add subscriptions with **`a`**. Signing in to an account that already exists refreshes its stored credentials instead of creating a duplicate.

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

Scope either model endpoint to one Codex subscription with its exact label from the TUI or its stable subscription ID:

```bash
curl http://127.0.0.1:8787/v1/models \
  -H 'X-Subby-Subscription: you@example.com'
```

Scoped catalogs have separate five-minute caches and never fall back to another subscription.

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

The Codex backend only streams and requires `store: false`. For non-streaming clients, subby aggregates the upstream SSE events into a JSON Response object.

Subby emulates `previous_response_id` for streaming and non-streaming responses with an on-disk SQLite transcript cache. The cache keeps the 10,000 most recently used responses within a 512 MiB limit by default, so IDs survive process restarts. Chaining from a response interrupted before its terminal event or from an evicted ID returns a clear 400 error.

Legacy `POST /v1/chat/completions` is not currently implemented.

## Routing

Requests with a non-empty `prompt_cache_key` use rendezvous hashing across usable Codex subscriptions. The same key stays on the same subscription, while different keys can use subscriptions in parallel. Subby uses the key only for routing and removes it before forwarding because the ChatGPT Codex backend does not accept it.

`previous_response_id` chains stay on the subscription that served the cached response. If that subscription is exhausted or removed, the chain moves to the next rendezvous candidate.

Requests without a cache key or response chain stay on the current subscription. If none has been selected, subby uses the first available Codex subscription.

Routing never waits for the usage endpoint. A terminal usage-limit response immediately moves the request to another subscription, then subby refreshes the exhausted subscription's reset window in the background. If that refresh fails, subby retries the subscription after five minutes. Transient rate limits and unrelated upstream errors are returned to the client rather than causing account churn.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `SUBBY_HOST` | `127.0.0.1` | Proxy bind address |
| `SUBBY_PORT` | `8787` | Proxy port |
| `SUBBY_KEY` | unset | If set, require `Authorization: Bearer <value>` |
| `SUBBY_CODEX_CLIENT_VERSION` | `0.153.2` | Codex compatibility version sent when fetching the model catalog |
| `SUBBY_USAGE_TIMEOUT_MS` | `5000` | Timeout for background usage refresh after a subscription is exhausted |
| `SUBBY_RESPONSE_CACHE_PATH` | `~/.subby/response-cache.sqlite` | Response transcript cache file |
| `SUBBY_RESPONSE_CACHE_MAX_ENTRIES` | `10000` | Maximum cached responses |
| `SUBBY_RESPONSE_CACHE_MAX_BYTES` | `536870912` | Maximum cached transcript bytes |

To protect the endpoint with a key:

```bash
SUBBY_KEY=my-local-secret bun run start
```

The proxy binds to localhost by default because it has access to your stored subscription credentials. Do not expose it publicly without authentication and network controls.

The response cache contains model inputs and outputs. Subby creates its SQLite file with owner-only permissions.

## Development

```bash
bun test
bunx tsc --noEmit
```
