---
title: API Reference
description: The AcruxCore REST API — every endpoint is curl-verified. Authentication, prompts and versions, the gateway, tracing, tools, and evaluation.
hide_table_of_contents: false
---

# API Reference

The AcruxCore REST API is organized by domain. **Every endpoint below is
curl-verified** — the examples are copied from real requests against a running
server, not written from a spec.

All routes are under `/api/v1` and authenticate with a Bearer API key:
`Authorization: Bearer $ACRUXCORE_API_KEY`. See
[Authentication](/api-reference/authentication) for how to generate one.

## Identity

- [Authentication](/api-reference/authentication) — generate and use a Bearer token
- [API keys](/api-reference/api-keys) — create, list, revoke
- [Audit](/api-reference/audit) — audit log

## Prompts

- [Prompts](/api-reference/prompts) — read, search, resolve (create/edit/delete are dashboard-only)
- [Versions](/api-reference/prompts/versions) — commit immutable versions
- [Aliases](/api-reference/prompts/aliases) — promote `production` / `staging`
- [Diff](/api-reference/prompts/diff) · [Import](/api-reference/import) · [Export](/api-reference/export)

## Gateway

- [Gateway](/api-reference/gateway) — OpenAI-compatible chat completions
- [Connections](/api-reference/gateway/connections) — provider credentials (BYOK)
- [Models](/api-reference/gateway/models) — public model names
- [Virtual keys](/api-reference/gateway/keys) · [Budgets](/api-reference/gateway/budgets) · [Usage](/api-reference/gateway/usage)

## Tools

- [Tools](/api-reference/tools) · [Tool versions](/api-reference/tools/versions) · [Tool aliases](/api-reference/tools/aliases)
- [Tool execute](/api-reference/tools/execute) · [Tool analytics](/api-reference/tools/analytics)

## Observability

- [Traces](/api-reference/traces) — ingest and query
- [Trace analytics](/api-reference/traces/analytics) · [Feedback](/api-reference/traces/feedback) · [Settings](/api-reference/traces/settings)
- [Sessions](/api-reference/traces/sessions)

## Evaluation

- [Datasets](/api-reference/datasets) · [Experiments](/api-reference/experiments) · [Optimize](/api-reference/optimize)
