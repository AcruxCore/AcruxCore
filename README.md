<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/brand/lockup.svg">
    <source media="(prefers-color-scheme: light)" srcset="apps/web/public/brand/lockup-light.svg">
    <img alt="AcruxCore" src="apps/web/public/brand/lockup-light.svg" width="420">
  </picture>
</p>

<p align="center"><b>Prompt management, an AI gateway, tracing, a tool catalog, and evaluation<br>— one platform for teams shipping LLM products.</b></p>

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

## ⭐ Why AcruxCore

Most teams end up gluing together a prompt spreadsheet, a logging library, and a one-off eval script. AcruxCore covers the whole loop as one platform instead:

- 📝 **Prompt management** — version every prompt, diff any two versions, promote to production, render with Jinja2-style templating
- 🌐 **AI gateway** — one endpoint in front of OpenAI, Anthropic, Gemini and more, with routing, caching and retries
- 🔍 **Tracing** — every gateway request lands as a trace automatically, tool spans included, no separate instrumentation to wire up
- 🧰 **Tool catalog** — register a tool once, reuse it across prompts and agents
- 📊 **Evaluation** — run a prompt, or a full session, against a dataset and compare scores across runs
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
