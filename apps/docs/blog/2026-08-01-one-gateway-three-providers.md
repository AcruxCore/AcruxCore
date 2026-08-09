---
title: "One gateway, three providers: request shapes compared"
description: The same chat request, translated into Anthropic, Gemini, and OpenAI's own shapes by the gateway's adapters — headers, params, and tool defs, side by side.
slug: one-gateway-three-providers
authors: [acrux]
tags: [gateway, llm-ops]
image: /img/social-card.png
keywords: [anthropic api vs openai api, gemini api shape, llm provider comparison, unified llm api, chat completions translation]
---

Your app sends one `POST /gateway/chat/completions` request with an
OpenAI-shaped body; changing providers is a one-field edit to `model`. What
that field hides is more interesting: underneath, Anthropic, OpenAI, and
Gemini each expect a genuinely different request — a different auth header,
different sampling-param nesting, and a different key for the same tool
definition. We took one fixed request — a system message, a user message, and
one tool definition — and traced it through all three adapters that ship
today to show exactly what each one rewrites and why the gateway needs to do
it at all.

<!-- truncate -->

## The one request every path starts from

```json
{
  "model": "demo-model",
  "messages": [
    { "role": "system", "content": "You are a concise, friendly support agent." },
    { "role": "user", "content": "My order has not arrived yet — can you look it up?" }
  ],
  "temperature": 0.2,
  "max_tokens": 200,
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "lookup_order",
        "description": "Look up an order by its id.",
        "parameters": { "type": "object", "properties": { "orderId": { "type": "string" } }, "required": ["orderId"] }
      }
    }
  ],
  "tool_choice": "auto"
}
```

That's the whole client-facing contract, regardless of which model answers
it. Below is what each adapter actually builds from it, captured by running
the gateway's own adapter code directly against this exact request.

## Anthropic: system hoisted out, tools renamed, no `Authorization` header

```json
POST https://api.anthropic.com/v1/messages
x-api-key: <key>
anthropic-version: 2023-06-01

{
  "model": "demo-model",
  "messages": [
    { "role": "user", "content": "My order has not arrived yet — can you look it up?" }
  ],
  "max_tokens": 200,
  "system": "You are a concise, friendly support agent.",
  "temperature": 0.2,
  "tools": [
    { "name": "lookup_order", "description": "Look up an order by its id.", "input_schema": { "type": "object", "properties": { "orderId": { "type": "string" } }, "required": ["orderId"] } }
  ],
  "tool_choice": { "type": "auto" }
}
```

- The `system` message never appears in `messages` at all — it's pulled out
  and joined into a top-level `system` string.
- `max_tokens` is **required**; the adapter defaults it to 1024 if a caller
  omits it, since Anthropic's API rejects a request without one.
- Auth is `x-api-key`, not `Authorization: Bearer` — plus a mandatory
  `anthropic-version` header pinning the API version.
- A tool's `parameters` becomes `input_schema` — same JSON Schema, different
  key.

A live call through the gateway to an Anthropic-backed model with this same
system and user message came back through the same normalization path as
the other two:

```json
{"id":"msg_011CdbQLdD7d1TBhx2cp7izz","model":"claude-haiku-4-5-20251001","object":"chat.completion","created":1785558766,"choices":[{"index":0,"message":{"role":"assistant","content":"I'd be happy to help you look up your order! Could you please provide me with your order ID? You can usually find this in your confirmation email or account."},"finish_reason":"stop"}],"usage":{"prompt_tokens":584,"completion_tokens":37,"total_tokens":621}}
```

## Gemini: model in the URL, messages become `contents`, sampling params nest

```json
POST https://generativelanguage.googleapis.com/v1beta/models/demo-model:generateContent
x-goog-api-key: <key>

{
  "contents": [
    { "role": "user", "parts": [{ "text": "My order has not arrived yet — can you look it up?" }] }
  ],
  "systemInstruction": { "parts": [{ "text": "You are a concise, friendly support agent." }] },
  "generationConfig": { "temperature": 0.2, "maxOutputTokens": 200 },
  "tools": [
    { "functionDeclarations": [{ "name": "lookup_order", "description": "Look up an order by its id.", "parameters": { "type": "object", "properties": { "orderId": { "type": "string" } }, "required": ["orderId"] } }] }
  ],
  "toolConfig": { "functionCallingConfig": { "mode": "AUTO" } }
}
```

- The model name is in the **URL path**, not the request body at all.
- `messages` becomes `contents`, and `assistant` becomes `model` — Gemini
  has no `assistant` role.
- `temperature` and `max_tokens` don't pass through directly; they nest
  under `generationConfig` (and `max_tokens` is renamed
  `maxOutputTokens`).
- Tools get wrapped in an extra array: `tools: [{ functionDeclarations: [...] }]`
  — one object holding all your functions, not one array entry per
  function.
- Auth is `x-goog-api-key` — a third distinct header name, and no version
  header.

A live call through the gateway to a Gemini-backed model with this same
system and user message came back through the same normalization path as
the other two:

```json
{"id":"chatcmpl-0c393a95-d15d-4446-8f06-f63f301462fd","model":"gemini-flash-latest","object":"chat.completion","created":1785558362,"choices":[{"index":0,"message":{"role":"assistant","content":"I'd be happy to help check on your order! Could you please provide your order ID?"},"finish_reason":"stop"}],"usage":{"prompt_tokens":70,"completion_tokens":20,"total_tokens":173}}
```

## OpenAI: the gateway's own shape, close to a passthrough

```json
POST https://api.openai.com/v1/chat/completions
Authorization: Bearer <key>

{
  "model": "demo-model",
  "messages": [
    { "role": "system", "content": "You are a concise, friendly support agent." },
    { "role": "user", "content": "My order has not arrived yet — can you look it up?" }
  ],
  "temperature": 0.2,
  "max_tokens": 200,
  "tools": [
    { "type": "function", "function": { "name": "lookup_order", "description": "Look up an order by its id.", "parameters": { "type": "object", "properties": { "orderId": { "type": "string" } }, "required": ["orderId"] } } }
  ],
  "tool_choice": "auto",
  "stream": false
}
```

Because the gateway's own client-facing API already mirrors OpenAI's Chat
Completions shape, this adapter does almost nothing: `messages`, `tools`,
and `tool_choice` pass straight through unchanged, `Authorization: Bearer`
is the standard header, and the only addition is an explicit `stream: false`.
A live call through the gateway to `gpt-4o-mini` with this same system and
user message came back exactly as you'd expect from that passthrough:

```json
{"id":"gen-1785557584-vX8IgUyDLe4W8wtJx8bX","model":"openai/gpt-4o-mini","object":"chat.completion","created":1785557584,"choices":[{"index":0,"message":{"role":"assistant","content":"I'm sorry to hear your order hasn't arrived yet! Unfortunately, I can't look up specific orders. However, I recommend checking your order confirmation email for tracking information or contacting customer support directly for assistance. Let me know if you need help with anything else!"},"finish_reason":"stop"}],"usage":{"prompt_tokens":33,"completion_tokens":54,"total_tokens":87}}
```

## Side by side

| | Anthropic | Gemini | OpenAI |
|---|---|---|---|
| Model name | In body (`model`) | **In URL path** | In body (`model`) |
| System message | Hoisted to top-level `system` string | Hoisted to `systemInstruction.parts` | Stays inline in `messages` |
| `assistant` role | Unchanged | Renamed to `model` | Unchanged |
| Sampling params | Inline (`temperature`, `max_tokens`) | Nested under `generationConfig`, `max_tokens`→`maxOutputTokens` | Inline, unchanged |
| Tool schema field | `input_schema` | `parameters`, wrapped in `functionDeclarations` | `parameters`, unchanged |
| Auth header | `x-api-key` + `anthropic-version` | `x-goog-api-key` | `Authorization: Bearer` |
| `max_tokens` | **Required** — defaults to 1024 if omitted | Optional | Optional |

Whichever model you point at, your code keeps sending the one shape at the
top of this post — the row you never have to write yourself is whichever
one your chosen provider needs.

## What this means for you

- **Switching models is a `model` field change**, not a rewrite — the
  translation in every row above happens inside the gateway, not in your
  code.
- **Anthropic's required `max_tokens`** is the one place a request could
  behave differently across providers if you rely on omitting it — set it
  explicitly if you plan to swap models later.
- **Tool definitions travel as one JSON Schema**, no matter which provider
  answers — you write `parameters` once and never touch `input_schema` or
  `functionDeclarations` yourself.

:::note
Want to reproduce this? Every response above is the real thing — one live
call per provider through the running gateway, to an Anthropic-backed, a
Gemini-backed, and an OpenAI-backed model, all given the exact same system
and user message (only the registered `model` name differed from the
`"demo-model"` placeholder shown in the request bodies above). The request
shapes themselves come from running the gateway's real, unmodified adapter
classes directly against the one request at the top of this post.
:::

Want to try this yourself? The [Quickstart](/docs/getting-started/quickstart)
gets you from sign-up to a traced, gateway-routed call in about ten minutes.
