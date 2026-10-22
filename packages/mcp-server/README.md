# @acruxcoreai/mcp-server

The [Model Context Protocol](https://modelcontextprotocol.io) server for
[AcruxCore](https://acruxcore.com). It turns the platform — the prompt registry, the
versioned tool catalog, the AI gateway, tracing and evaluation — into tools any MCP
client can call, so an assistant can operate AcruxCore instead of being told which HTTP
endpoints to hit.

It also exposes your team's **registry prompts as MCP prompts**, so the prompts your
production traffic renders show up in the client as ready-to-use templates, with the
template variables as typed arguments.

## Two ways to connect

**Hosted — nothing to install.** Point an MCP client that supports remote servers at
your AcruxCore instance:

```
https://api.acruxcore.com/api/v1/mcp
```

with an `Authorization: Bearer acx_sk_…` header. Create the key in the dashboard under
**Settings → API keys**.

**Local — stdio.** For clients that only speak stdio, or when you want to narrow the
tool surface:

```jsonc
{
  "mcpServers": {
    "acruxcore": {
      "command": "npx",
      "args": ["-y", "@acruxcoreai/mcp-server"],
      "env": {
        "ACRUXCORE_API_KEY": "acx_sk_…",
        "ACRUXCORE_BASE_URL": "https://api.acruxcore.com/api/v1"
      }
    }
  }
}
```

In Claude Code, one command does the same thing:

```bash
claude mcp add acruxcore -e ACRUXCORE_API_KEY=acx_sk_… -- npx -y @acruxcoreai/mcp-server
```

For a full walkthrough with a real Claude Code session, see
[Connect Claude to AcruxCore with MCP](https://docs.acruxcore.com/docs/guides/connect-an-mcp-client).
The endpoint reference is at
[docs.acruxcore.com/api-reference/mcp](https://docs.acruxcore.com/api-reference/mcp).

## Configuration

Every option is an environment variable or a CLI flag; the flag wins.

| Env | Flag | Default | Meaning |
|---|---|---|---|
| `ACRUXCORE_API_KEY` | `--api-key` | *required* | Your `acx_sk_…` key. |
| `ACRUXCORE_BASE_URL` | `--base-url` | `https://api.acruxcore.com/api/v1` | Self-hosting? Point it at your instance. `/api/v1` is appended if you leave it off. |
| `ACRUXCORE_MCP_TOOLSETS` | `--toolsets` | all | Comma-separated: `prompts`, `gateway`, `tools`, `traces`, `evaluations`. |
| `ACRUXCORE_MCP_READ_ONLY` | `--read-only` | `false` | Drop every mutating tool from the listing. |
| `ACRUXCORE_MCP_PROMPT_ALIAS` | `--prompt-alias` | `production` | Which alias the prompts primitive exposes. |
| `ACRUXCORE_MCP_MAX_TEXT_BYTES` | `--max-text-bytes` | `40000` | Cap on the size of any single tool result. |
| `ACRUXCORE_MCP_TIMEOUT_MS` | `--timeout-ms` | `60000` | Per-request HTTP timeout. |

### Read-only mode

`--read-only` removes the mutating tools from `tools/list` entirely rather than refusing
them when called. A tool that is absent cannot be chosen by mistake and cannot be talked
into running — which is the point of handing an agent a key it should not write with.

## Tools

**Prompts** — `list_prompts`, `get_prompt`, `render_prompt`, `diff_prompt_versions`,
`create_prompt`, `commit_prompt_version`, `promote_prompt_alias`

**Gateway** — `run_prompt`, `chat_completion`, `list_models`, `get_gateway_usage`, `get_spending_limits`

**Tool catalog** — `list_catalog_tools`, `get_catalog_tool`, `sync_catalog_tool`,
`execute_catalog_tool`

**Traces** — `search_traces`, `get_trace`, `get_trace_analytics`, `list_sessions`,
`get_session`, `submit_trace_feedback`

**Evaluations** — `list_datasets`, `get_dataset`, `create_dataset`,
`add_dataset_example`, `run_experiment`, `list_experiment_runs`, `get_experiment_run`,
`optimize_prompt`, `get_optimize_report`, `promote_optimize_candidate`

Anywhere a tool takes a prompt or a catalog tool, a **name works as well as a UUID**.

## Prompts and resources

Registry prompts appear through MCP's prompts primitive at the configured alias, with
their template variables as arguments. MCP has no system role, so a template's system
message is carried through as the leading `user` message with its text unchanged.

Two resource templates are registered:

- `acruxcore://prompts/{name}/{alias}` — the raw, unrendered template of the version an
  alias points at.
- `acruxcore://traces/{traceId}` — one trace with its full span tree.

## The model behind the tools

Three ideas explain nearly every tool here:

- A **prompt** is a named container. It holds no messages itself.
- A **version** is an immutable commit of that prompt's messages, numbered sequentially.
- An **alias** — `production`, `staging`, anything else — is a moving pointer at one
  version.

Committing a version never moves an alias. `promote_prompt_alias` is what ships a
change, and promoting an earlier version number is how you roll back.

## License

MIT
