# Dataset eligibility checks

Two runnable cases that produce a trace which is *hard* to turn into an evaluation
dataset example, so the behaviour can be seen rather than reasoned about. Each script
makes one gateway call and prints its trace id. You then thumbs-down the trace and try
**Observability → Feedback → Create dataset** on it.

A dataset example is **the prompt variables plus the prompt version**, not a transcript.
That is what lets one dataset grade a candidate prompt the run engine has never seen: the
candidate is rendered against those same variables. Everything below follows from that.

| Case | What the run has | What the build does |
|------|------------------|---------------------|
| `01` — system prompt in code | no version, no variables (`null` on the span) | **skipped** — the reason says the call did not use a stored prompt |
| `02` — stored prompt, no placeholders | a version, `variables: {}` | **example built**, with `input: {}` |
| `03` — stored system prompt, live user turn, nothing declared | a version, `variables: null` | **skipped** — a version alone is not enough |
| `04` — stored system prompt, live user turn, declared | a version, `variables: {question}` | **example built**, the question as its input |

Selecting both at once is the clearest way to see it: the build reports *"1 added, 1
skipped"*, and names which row was skipped and why.

Case `02` is the one worth looking at. The prompt is stored, so there *is* a template to
render a candidate against; there is simply nothing to render it with. The example's input
is empty, and that is correct — the criteria still grades the prompt, and the template
varies across candidates even when the input does not. An experiment over such a dataset
runs normally: verified at one cell, `succeeded: 1`, `errored: 0`, judge score 60.

Cases `03` and `04` are the pair worth running back to back, because they differ by one
argument and nothing else. Both store the system prompt as a version and append the user's
question at request time, which is the shape most applications actually have. Case `03`
sends no `variables`, so the span records the version but not what varied, and the row is
skipped. Case `04` passes `variables={"question": ...}` alongside the messages it already
built — the gateway re-renders nothing, it only records the values behind them — and the
row becomes an example an experiment can replay against a candidate system prompt.

Case `01` cannot work at all, and not for want of trying: with no version there is no
template, so there is nothing a candidate could be. See the phase-5 FAQ entry "Should a
trace whose prompt lives in code be able to become a dataset row?" for why falling back to
the raw messages was considered and deferred.

## Running them

```bash
export ACRUXCORE_API_KEY=acx_sk_...
export ACRUXCORE_BASE_URL=http://localhost:3001/api/v1   # omit for production
export MODEL=gpt-4o-mini                                  # must be registered in your team

node   node/01-system-prompt-in-code.mjs
node   node/02-stored-prompt-no-placeholders.mjs
node   node/03-live-user-turn-no-variables.mjs
node   node/04-live-user-turn-with-variables.mjs

python python/01_system_prompt_in_code.py
python python/02_stored_prompt_no_placeholders.py
python python/03_live_user_turn_no_variables.py
python python/04_live_user_turn_with_variables.py
```

`02` creates the prompt `eligibility-check-no-placeholders` on first run and reuses it
after; `03` and `04` share `eligibility-check-live-user-turn` on purpose, so that the only
difference between those two runs is the one argument. All are safe to run repeatedly.

To change what `02`, `03` or `04` sends, edit the `MESSAGES` constant at the top of the
script. It
commits a new version and promotes `production` onto it, so the next trace shows the
edit. Both steps are needed: only a prompt's **first** commit mints the `production` and
`staging` aliases, so a later version that is never promoted stays invisible to
`render(..., "production")`. The scripts also disable the render cache (`cacheTtl: 0` /
`cache_ttl=0`), because they promote and then render again inside one process.

> **These need an unreleased SDK.** `variables` on the gateway call, and
> `RenderResult.variables`, are not in `@acruxcoreai/sdk` 0.12.0 or `acruxcore` 0.11.0
> yet. Until both are published, run against a local build — `npm run build` in
> `packages/sdk` and link it, or `PYTHONPATH=packages/sdk-python/src` for Python.
