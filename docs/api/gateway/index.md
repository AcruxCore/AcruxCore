---
title: "Gateway Chat Completions"
description: "Call the OpenAI-compatible gateway endpoint with raw messages or a stored-prompt reference."
---

# Gateway API — Chat Completions

Phase 2 AI Gateway. Base path: `/api/v1/gateway`. An OpenAI client points its
`baseURL` at `https://<host>/api/v1/gateway`.

Related references: [provider connections](connections.md),
[virtual keys](keys.md), [budgets](budgets.md),
[usage analytics](usage.md).

Auth for `POST /chat/completions` (`gatewayAuth`): a virtual key
(`Authorization: Bearer agh_sk_…`) is the primary machine path; a session cookie or
personal/team API key also works but requires role `owner`/`admin`/`editor`
(viewers get 403). Response metadata is returned in `x-gateway-*` headers.

All examples below were verified with real curl output against a running server
using live OpenAI and Gemini connections.

---

### POST /api/v1/gateway/chat/completions (non-streaming)

OpenAI-compatible chat completion. The gateway resolves the team's connection for
the model's provider, calls it, prices the call, and records a request-log row.

```bash
curl -X POST $ACRUXCORE_BASE_URL/gateway/chat/completions \
  -H "Content-Type: application/json" \
  --cookie "connect.sid=<session>" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Say hi in one word."}],"max_tokens":10}'
```

Response headers (status 200):

```text
x-gateway-request-id: 561e701d-d775-44b8-ab85-f9a7e75b3b3b
x-gateway-provider: openai
x-gateway-model: gpt-4o-mini-2024-07-18
x-gateway-cost-usd: 0.00000315
x-gateway-cache: miss
```

Response body (status 200):

```json
{
  "id": "chatcmpl-DxoMTfx6c4OtbeOrvFXf9m6qKi2P6",
  "model": "gpt-4o-mini-2024-07-18",
  "object": "chat.completion",
  "created": 1783147313,
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "Hello!" },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 13, "completion_tokens": 2, "total_tokens": 15 }
}
```

---

### POST /api/v1/gateway/chat/completions (Gemini — multi-provider routing)

The same endpoint routes to Gemini when the model belongs to a `gemini` connection.
Note `x-gateway-cost-usd` is empty when the model has no configured price.

```bash
curl -X POST $ACRUXCORE_BASE_URL/gateway/chat/completions \
  -H "Content-Type: application/json" \
  --cookie "connect.sid=<session>" \
  -d '{"model":"gemini-2.5-flash-lite","messages":[{"role":"user","content":"Say hi in one word."}],"max_tokens":10}'
```

Response headers (status 200):

```text
x-gateway-request-id: ae680e52-1d75-4ceb-9447-b6d69312e00c
x-gateway-provider: gemini
x-gateway-model: gemini-2.5-flash-lite
x-gateway-cost-usd:
x-gateway-cache: miss
```

Response body (status 200):

```json
{
  "id": "chatcmpl-eaa42e14-7bf5-4c5f-ad95-7ae5df61ccc8",
  "model": "gemini-2.5-flash-lite",
  "object": "chat.completion",
  "created": 1783147330,
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "Hello" },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 7, "completion_tokens": 1, "total_tokens": 8 }
}
```

---

### POST /api/v1/gateway/chat/completions (via virtual key)

Machine credential path — authenticate with a virtual key instead of a session.
The virtual key was created via [POST /gateway/keys](keys.md); it is shown
here redacted as `agh_sk_...REDACTED` (the real key was used and worked).

```bash
curl -X POST $ACRUXCORE_BASE_URL/gateway/chat/completions \
  -H "Authorization: Bearer agh_sk_...REDACTED" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Say hi in one word."}],"max_tokens":10}'
```

Response headers (status 200):

```text
x-gateway-request-id: be005d49-e3b1-4611-82c2-b568ddc9a083
x-gateway-provider: openai
x-gateway-model: gpt-4o-mini-2024-07-18
x-gateway-cost-usd: 0.00000315
x-gateway-cache: miss
```

Response body (status 200):

```json
{
  "id": "chatcmpl-DxoN4uwS5rPd9w7RewNVjrDSx7nsD",
  "model": "gpt-4o-mini-2024-07-18",
  "object": "chat.completion",
  "created": 1783147350,
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "Hello!" },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 13, "completion_tokens": 2, "total_tokens": 15 }
}
```

---

### POST /api/v1/gateway/chat/completions (streaming)

Set `"stream": true`. The response is `text/event-stream`: one OpenAI-compatible
`chat.completion.chunk` per `data:` frame, terminated by `data: [DONE]`.
`x-gateway-cost-usd` is intentionally omitted from stream headers (cost is not
known until the stream ends).

```bash
curl --no-buffer -X POST $ACRUXCORE_BASE_URL/gateway/chat/completions \
  -H "Content-Type: application/json" \
  --cookie "connect.sid=<session>" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Count: one two three"}],"max_tokens":20,"stream":true}'
```

Response headers (status 200):

```text
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
x-gateway-request-id: 9777fa85-2ace-4d96-8d97-acf8ac84be04
x-gateway-provider: openai
x-gateway-model: gpt-4o-mini
```

Response body (SSE stream):

```text
data: {"id":"chatcmpl-9777fa85-2ace-4d96-8d97-acf8ac84be04","object":"chat.completion.chunk","created":1783147331,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"One"},"finish_reason":null}]}

data: {"id":"chatcmpl-9777fa85-2ace-4d96-8d97-acf8ac84be04","object":"chat.completion.chunk","created":1783147331,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":","},"finish_reason":null}]}

data: {"id":"chatcmpl-9777fa85-2ace-4d96-8d97-acf8ac84be04","object":"chat.completion.chunk","created":1783147331,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":" two"},"finish_reason":null}]}

data: {"id":"chatcmpl-9777fa85-2ace-4d96-8d97-acf8ac84be04","object":"chat.completion.chunk","created":1783147331,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":","},"finish_reason":null}]}

data: {"id":"chatcmpl-9777fa85-2ace-4d96-8d97-acf8ac84be04","object":"chat.completion.chunk","created":1783147331,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":" three"},"finish_reason":null}]}

data: {"id":"chatcmpl-9777fa85-2ace-4d96-8d97-acf8ac84be04","object":"chat.completion.chunk","created":1783147331,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"."},"finish_reason":null}]}

data: {"id":"chatcmpl-9777fa85-2ace-4d96-8d97-acf8ac84be04","object":"chat.completion.chunk","created":1783147331,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: {"id":"chatcmpl-9777fa85-2ace-4d96-8d97-acf8ac84be04","object":"chat.completion.chunk","created":1783147331,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{},"finish_reason":null}]}

data: [DONE]
```

---

### Error responses

Enforcement happens before any provider call. Observed shapes:

- **403 `MODEL_NOT_ALLOWED`** — a virtual key with an `allowedModels` allow-list
  called a model outside it. See [virtual keys](keys.md).

  ```json
  { "error": { "code": "MODEL_NOT_ALLOWED", "message": "Model 'gemini-2.5-flash-lite' is not allowed for this key." } }
  ```

- **402 `BUDGET_EXCEEDED`** — the team-wide (or key-scoped) budget cap is reached.
  See [budgets](budgets.md).

  ```json
  { "error": { "code": "BUDGET_EXCEEDED", "message": "Team-wide budget exceeded." } }
  ```

---

## Response Cache (G6)

Per-team exact-match response cache. Opt-in per virtual key via `cacheTtlSeconds`;
only requests with `temperature: 0` are cached. A cache hit returns the stored body
at zero cost with header `x-gateway-cache: hit` and does not increment any budget.
Bypass per call with request header `x-gateway-cache: no-store`.

### DELETE /api/v1/gateway/cache

Flush the calling team's response cache (owner/admin; editors/viewers 403).
Returns the number of rows removed (`0` when nothing was cached).

```bash
curl -X DELETE $ACRUXCORE_BASE_URL/gateway/cache \
  --cookie "connect.sid=<owner/admin session>"
```

Response (status 200):

```json
{ "deleted": 0 }
```
