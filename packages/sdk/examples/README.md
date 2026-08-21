# SDK examples

Runnable examples for `@acruxcoreai/sdk`. Each file is standalone — set the two
env vars and run it with `tsx`.

```bash
export ACRUXCORE_API_KEY=<your api key>       # personal, team, or virtual gateway key
export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
npx tsx packages/sdk/examples/<file>.ts
```

## Examples

| File | Shows |
|------|-------|
| [`call-with-bound-model.ts`](./call-with-bound-model.ts) | Call the LLM **without naming a model** — the prompt version's bound default model is used (issue #12). |
| [`multi-tool-agent.ts`](./multi-tool-agent.ts) | A small agent with **three tools**, driven by `runToolLoop`. Tool schemas and messages are defined **inline** in the script. |
| [`rest-defined-agent.ts`](./rest-defined-agent.ts) | The same agent, but the **prompt and tool schemas live on the server** — stored via the REST API (tools bound to the prompt), then **fetched together** with one `renderPrompt` call and run. |
| [`stream-a-stored-prompt.ts`](./stream-a-stored-prompt.ts) | Fetch a stored prompt with `renderPrompt`, then **stream** the reply token by token with `chat({ stream: true })`. Reuses the `travel-assistant` prompt from `rest-defined-agent.ts`. |

### `call-with-bound-model.ts`

Bind a default model to a prompt (prompt page → Editor tab → **Default model**,
or the Playground save dialog), then call the gateway with only a `prompt`
reference and no `model`:

```jsonc
POST /api/v1/gateway/chat/completions
{ "prompt": { "name": "summarise-article", "alias": "production", "variables": { ... } } }
```

The gateway resolves the model bound to that version. Precedence: an explicit
request `model` always wins; otherwise the binding is used; if neither exists the
call returns `400 "model is required"`.

> The typed client's `runToolLoop` requires a `model` and sends raw `messages`,
> so it can't drive this prompt-reference path — the example uses a direct
> `fetch` to the gateway, which is the verified working request shape.

### `multi-tool-agent.ts`

An agent given three independent tools (`get_weather`, `convert_currency`,
`get_current_time`) and driven by `runToolLoop`. The tool JSON-schemas and the
chat messages are hardcoded in the script; the tools run locally in a `dispatch`
function. A single model turn can request several tools at once, and the SDK
dispatches them concurrently. The whole run is auto-traced.

### `rest-defined-agent.ts`

The same three-tool agent, but nothing is hardcoded on the run path except the
local `dispatch` logic. It goes **store → fetch → use**:

- **Store** (REST): each tool is created with `POST /tools` + `/tools/:id/versions`
  (schema + a `{ type: 'client' }` executor, meaning your app runs it), and the
  prompt with `POST /prompts` + `/prompts/:id/versions`, then one
  `PUT /prompts/:id/tools/:toolId` per tool to **bind** it to the prompt.
- **Fetch** (SDK): a single `renderPrompt()` returns `{ messages, tools }` — the
  templated messages *and* the bound tool schemas, straight from the framework.
- **Use**: `runToolLoop({ messages, tools })` runs on exactly what was fetched.

The setup is idempotent (find-or-create by name), so it is safe to re-run. Accepts
an optional `ACRUXCORE_MODEL` env var (defaults to `gpt-4o-mini`).

### `stream-a-stored-prompt.ts`

Reuses the `travel-assistant` prompt stored by `rest-defined-agent.ts` (run that
first). It renders the stored prompt, then calls `chat({ stream: true })` and
prints each token as it arrives. It intentionally omits the bound tools so the
streamed output is clean prose — streaming yields text deltas and does not
auto-run tools (use `runToolLoop` for that). Also accepts `ACRUXCORE_MODEL`.
