<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/brand/lockup.svg">
    <source media="(prefers-color-scheme: light)" srcset="apps/web/public/brand/lockup-light.svg">
    <img alt="AcruxCore" src="apps/web/public/brand/lockup-light.svg" width="420">
  </picture>
</p>

<p align="center"><b>Prompt management, an AI gateway, tracing, a tool catalog, evaluation, and an audit trail<br>— one platform for teams shipping LLM products.</b></p>

<p align="center">
  <a href="https://acruxcore.com">Website</a> ·
  <a href="https://docs.acruxcore.com">Docs</a> ·
  <a href="https://docs.acruxcore.com/blog">Blog</a> ·
  <a href="https://docs.acruxcore.com/changelog">Changelog</a> ·
  <a href="#-self-hosting">Self-hosting</a>
</p>

<p align="center">
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache%202.0-blue"></a>
  <a href="https://www.npmjs.com/package/@acruxcoreai/sdk"><img alt="npm" src="https://img.shields.io/npm/v/@acruxcoreai/sdk?label=npm%20sdk"></a>
  <a href="https://pypi.org/project/acruxcore/"><img alt="PyPI" src="https://img.shields.io/pypi/v/acruxcore?label=pypi%20sdk"></a>
</p>

---

<p align="center">
  <img src="product-demo.gif" width="820" alt="The AcruxCore dashboard: creating a prompt, committing a version, attaching a tool, running it through the gateway on a real model, and opening the resulting trace">
</p>

<p align="center">
  <sub>Create a prompt · commit a version · attach a tool · run it on a real model · open the trace — one task, start to finish.</sub>
</p>

---

## ⭐ Why AcruxCore

Most teams end up gluing together a prompt spreadsheet, a logging library, and a one-off eval script. AcruxCore covers the whole loop as one platform instead:

- 📝 **Prompt management** — version every prompt, diff any two versions, promote to production, render with Jinja2-style templating
- 🌐 **AI gateway** — one endpoint in front of OpenAI, Anthropic, Gemini and more, with routing, caching and retries
- 🔍 **Tracing** — every gateway request lands as a trace automatically, tool spans included, no separate instrumentation to wire up
- 🧰 **Tool catalog** — register a tool once, reuse it across prompts and agents
- 📊 **Evaluation** — run a prompt, or a full session, against a dataset and compare scores across runs
- 🧾 **Audit trail** — every recorded change to keys, members, gateway, secrets, prompts and tools, filtered by area, event or person
- 🔓 **Open source, self-hostable** — Apache 2.0, no gated or enterprise-only directory, run it on your own infra against your own Postgres

Hosted at [acruxcore.com](https://acruxcore.com) — or self-host it, below.

## 🚀 Quickstart (30 seconds)

Postgres, Redis, the API, the worker and the web app all come up from one file:

```bash
git clone https://github.com/AcruxCore/AcruxCore.git && cd AcruxCore
cp .env.local.example .env
docker compose -f docker-compose.local.yml up --build
```

Open **http://localhost:8080**, sign up, and you're in.

## 📊 How it compares

Checked by hand against each project's own docs and a live self-hosted instance of every one of them, in **August–September 2026** — except the prompt-optimizer row, checked against each project's docs and source on 10 September 2026. Columns are alphabetical after ours; the rows we lose are in the table too, and the full write-ups are linked below it.

| # | | **AcruxCore** | Helicone | Langfuse | Laminar | MLflow | Opik | Phoenix |
|---|---|---|---|---|---|---|---|---|
| 1 | License | Apache 2.0 | Apache 2.0 | MIT, some parts paid-only | Apache 2.0 | Apache 2.0 | Apache 2.0 | Elastic 2.0 |
| 2 | Self-host | ✅ 1 command | ✅ 1 command | ✅ 1 command | ✅ 1 command | ✅ 1 command | ✅ 1 command | ✅ 1 command |
| 3 | Gateway in the request path | ✅ | ✅ | ❌ ingest-only | ❌ ingest-only | ✅ + guardrails | ❌ ingest-only | ❌ ingest-only |
| 4 | Versioned, executed tool catalog | ✅ | ❌ | ⚠️ schema only | ⚠️ schema only | ⚠️ MCP servers | ❌ | ❌ |
| 5 | `{% if %}` / `{% for %}` in prompts | ✅ | ❌ substitution | ❌ substitution | ❌ no registry | ✅ full Jinja2 | ⚠️ SDK only | ❌ substitution |
| 6 | Prompt optimizer (auto-rewrite from eval results) | ✅ | ❌ | ❌ | ❌ | ✅ SDK, experimental | ✅ SDK | ⚠️ separate repo |
| 7 | Audit log without paying | ✅ | ❌ | ❌ Enterprise | ❌ | ❌ | ❌ | ❌ |
| 8 | Built-in guardrails (PII / safety) | ❌ | ✅ | ⚠️ SDK hook | ✅ PII only | ✅ | ✅ | ❌ 3rd-party |
| 9 | Alerts to Slack or webhooks | ❌ email only | ✅ | ✅ | ✅ | ✅ spend only | ✅ | ❌ paid AX only |
| 10 | Human labeling queue | ❌ | ❌ | ✅ | ✅ | ❌ paid host only | ✅ | ⚠️ no queue |
| 11 | Organization → project hierarchy | ❌ single team | ⚠️ org only | ✅ | ✅ workspace | ❌ | ❌ | ❌ |
| 12 | GitHub stars | new project | 6.1k | 34.3k | 3.2k | 27.8k | 21.8k | 11.3k |

**Where they beat us.** Four rows go the other way. We ship no built-in guardrails, while Helicone, MLflow, Opik and Laminar (PII only) all do. Our alerts are email only — every platform except Phoenix can post to Slack or a webhook. There is no human labeling queue; Langfuse, Laminar and Opik have one. And there is no organization layer above the team, which Langfuse and Laminar both have. MLflow also matches us on two of our own rows: its gateway sits in the request path, and its prompt registry renders full Jinja2. Every project here is older than us and has a much larger community.

**Where we're different.** The gateway sits *in* the request path, so routing, caching, budgets and virtual keys apply before the provider is called, and a trace is written without separate instrumentation — only Helicone and MLflow do the same. Tools are a persistent versioned catalog the gateway actually executes, which no other platform in the table has. Prompts are real templates with conditionals and loops, and a failing eval run can be turned straight into candidate rewrites that are scored and promoted from the dashboard — of the six, only Opik and MLflow ship an optimizer of their own, both SDK-only, and Phoenix's lives in a separate Arize repo rather than in the product. And the audit log is on by default rather than behind an upgrade — that row is ours alone.

Full hands-on comparisons, each built by running the same prompt on both platforms: **[Helicone](https://docs.acruxcore.com/blog/acruxcore-vs-helicone)** · **[Langfuse](https://docs.acruxcore.com/blog/acruxcore-vs-langfuse)** · **[Laminar](https://docs.acruxcore.com/blog/acruxcore-vs-laminar)** · **[MLflow](https://docs.acruxcore.com/blog/acruxcore-vs-mlflow)** · **[Opik](https://docs.acruxcore.com/blog/acruxcore-vs-opik)** · **[Phoenix](https://docs.acruxcore.com/blog/acruxcore-vs-phoenix)** — or the [side-by-side matrix](https://acruxcore.com/compare).

## 🏠 Self-hosting

Two Compose files, for two different jobs:

- **`docker-compose.local.yml`** — the quickstart above. Every value already has a working default, nothing to fill in.
- **`docker-compose.yml`** — the production shape. Bring your own Postgres and reverse proxy; every secret is required, none are defaulted. This is what `acruxcore.com` itself runs on a VPS.

```bash
cp .env.docker.example .env
openssl rand -base64 32   # → paste as GATEWAY_ENCRYPTION_KEY in .env
# set DATABASE_URL, DIRECT_URL and the other required secrets in .env
docker compose up --build
```

Auth is in-app (Better Auth) — accounts, sessions and password hashes all live in your own Postgres. There's no identity vendor to sign up for, and the API applies pending migrations on boot.

## 🧑‍💻 Contributing

Working on AcruxCore itself rather than just running it? See [CONTRIBUTING.md](./CONTRIBUTING.md) for the npm-workspaces setup, running the app from source, and tests — and [CLA.md](./CLA.md) before opening a pull request.

## 📄 License

[Apache License 2.0](./LICENSE) — permissive, OSI-approved, no gated or enterprise-only directory.

`packages/sdk` and `packages/sdk-python` ship under their own **MIT** license, standard for published client libraries. Both are permissive; the split is convention, not restriction.

The **AcruxCore** name and logo are trademarks, licensed separately — see [TRADEMARK.md](./TRADEMARK.md).
