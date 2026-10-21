# Changelog

All notable changes to `@acruxcoreai/mcp-server` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- **`get_spending_limits`** (`gateway` toolset, read-only). Lists every budget with its
  period, limit, live spend, `remainingUsd`, `exhausted` and reset time, names the virtual
  key a budget belongs to, and lists the keys masked to their last four characters.

### Changed

- `run_prompt` and `chat_completion` now name the trace id on their summary line, as
  `trace_id <uuid>`. The JSON part also carries `request-id`, another UUID, and a client
  that took the first UUID it saw passed that one to `get_trace` and got a 404.

## 0.1.0 — 2026-10-18


First release.

### Added

- **Model Context Protocol server for AcruxCore**, shipped two ways: a stdio binary
  (`npx @acruxcoreai/mcp-server`) and a hosted Streamable HTTP endpoint at
  `POST /api/v1/mcp` on any AcruxCore instance. Both register the same tools, so a tool
  added once appears on both.
- **28 tools across five toolsets.** `prompts` — `list_prompts`, `get_prompt`,
  `render_prompt`, `diff_prompt_versions`, `create_prompt`, `commit_prompt_version`,
  `promote_prompt_alias`. `gateway` — `run_prompt`, `chat_completion`, `list_models`,
  `get_gateway_usage`. `tools` — `list_catalog_tools`, `get_catalog_tool`,
  `sync_catalog_tool`, `execute_catalog_tool`. `traces` — `search_traces`, `get_trace`,
  `get_trace_analytics`, `list_sessions`, `get_session`, `submit_trace_feedback`.
  `evaluations` — `list_datasets`, `get_dataset`, `create_dataset`,
  `add_dataset_example`, `run_experiment`, `list_experiment_runs`, `get_experiment_run`.
- **Registry prompts as MCP prompts.** Every prompt in the team's registry is exposed
  through MCP's prompts primitive at the `production` alias, with the version's template
  variables as typed arguments. `ACRUXCORE_MCP_PROMPT_ALIAS` selects a different alias.
- **`acruxcore://` resources.** `acruxcore://prompts/{name}/{alias}` reads back the raw,
  unrendered template of the version an alias points at;
  `acruxcore://traces/{traceId}` reads one trace with its full span tree.
- **Names work wherever ids do.** Any tool taking a prompt or a catalog tool accepts the
  name or the UUID, and an unknown name comes back as a `NOT_FOUND` listing the closest
  matches rather than a silent near-miss.
- **`--read-only` removes mutating tools from the listing** rather than refusing them
  when called, so a model cannot choose a tool it never sees.
- **`--toolsets`** narrows the surface to any subset of the five.
- Configuration by environment variable or CLI flag, the flag winning:
  `ACRUXCORE_API_KEY`, `ACRUXCORE_BASE_URL`, `ACRUXCORE_MCP_TOOLSETS`,
  `ACRUXCORE_MCP_READ_ONLY`, `ACRUXCORE_MCP_PROMPT_ALIAS`,
  `ACRUXCORE_MCP_MAX_TEXT_BYTES`, `ACRUXCORE_MCP_TIMEOUT_MS`.
- **`initialize` instructions follow the registered tools.** A `--read-only` server
  tells the model the connection is read-only and never names a tool it lacks.
- **`diff_prompt_versions` says when two versions have identical messages**, and points
  to `get_prompt` for comparing the bound models and settings.
