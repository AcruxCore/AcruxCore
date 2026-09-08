import { type ReactNode } from 'react';
import { Ic, DOCS, API_BASE_URL, type CodeVariant } from './marketing-chrome';

/**
 * The five platform pillars, each with its own public page at
 * `/features/<slug>`. The landing page's pillar grid, the footer Product column,
 * the router, and the prerender manifest are all driven from this one list, so a
 * new pillar cannot appear in one place and be missing from another.
 */
export type FeatureSlug = 'prompts' | 'gateway' | 'tracing' | 'tools' | 'evaluation';

/** One capability card on a feature page. */
interface Capability {
  title: string;
  body: string;
}

/** An outbound documentation link shown in the "Go deeper" strip. */
interface DocLink {
  label: string;
  href: string;
}

/** One card inside a {@link FeatureSection}. */
interface SectionCard {
  title: string;
  body: string;
}

/** A two-column table inside a {@link FeatureSection}. */
interface SectionTable {
  head: [string, string];
  rows: Array<[string, string]>;
}

/**
 * A per-pillar deep-dive section, rendered between the capability cards and the
 * dashboard list.
 *
 * Capability cards are two sentences each — enough to name a capability, not
 * enough to explain one. These sections carry the explanations a reader needs
 * before they can decide anything: how fallbacks behave per failure class, that
 * tracing does not require the gateway, which tool version a prompt alias
 * actually gets, what a judge run costs. `note` is deliberately part of the
 * shape: every one of those explanations has a limit or a prerequisite, and a
 * capability described without its limit is the overclaim we keep fixing.
 */
export interface FeatureSection {
  eyebrow: string;
  title: string;
  lead: string;
  cards?: SectionCard[];
  table?: SectionTable;
  /** The closing qualification — the limit, the prerequisite, or the cost. */
  note?: string;
  /** Contextual documentation links for this section alone. */
  links?: DocLink[];
}

/**
 * The one real product screenshot each page carries, from the same set the docs
 * site uses — never a mockup. Width/height are the file's true pixel dimensions,
 * so the browser reserves the right box and the page does not shift on load.
 */
interface FeatureShot {
  src: string;
  /** What the screenshot shows, written for a reader who cannot see it. */
  alt: string;
  caption: string;
  width: number;
  height: number;
}

/** Everything needed to render one feature page and its cross-links. */
export interface Feature {
  slug: FeatureSlug;
  /** Short label used in the footer, nav, and cross-link cards. */
  name: string;
  /** One-sentence summary used on the landing pillar card and cross-link cards. */
  summary: string;
  /** Uppercase accent label above the page `<h1>`. */
  eyebrow: string;
  /** The page `<h1>`. */
  title: string;
  /** Hero paragraph under the title. */
  lead: string;
  /** `<title>` for the prerendered page. */
  metaTitle: string;
  /** `<meta name="description">` for the prerendered page. */
  metaDescription: string;
  icon: ReactNode;
  /** Heading for the capability grid — names the contents, per pillar. */
  capabilitiesTitle: string;
  capabilities: Capability[];
  /** The hero code panel — one or more language variants. */
  code: CodeVariant[];
  /** Deep-dive sections, in reading order. */
  sections: FeatureSection[];
  shot: FeatureShot;
  /** Concrete things the dashboard does for this pillar. */
  dashboard: string[];
  docs: DocLink[];
  /** The closing call to action — the first concrete action for this pillar. */
  cta: { title: string; body: string };
}

// ── syntax-highlight helpers ────────────────────────────────────────────────
// The code panels ship pre-highlighted HTML rather than running a highlighter in
// the browser, so they cost nothing at render time and prerender to static
// markup. Every string below is authored here — never user input — so the
// `dangerouslySetInnerHTML` in CodeCard has no untrusted path into it.
//
// One consequence worth knowing: a literal `<` in a sample is parsed as a tag
// and swallowed, in the browser and in the prerendered HTML alike. Write shell
// variables (`$RUN_ID`) or escape it as `&lt;` — never a bare `<id>`.

/** Wrap `s` in the keyword color. */
const kw = (s: string): string => `<span style="color:var(--varhi);">${s}</span>`;
/** Wrap `s` in the string-literal color. */
const st = (s: string): string => `<span style="color:var(--str);">${s}</span>`;
/** Wrap `s` in the function/identifier accent color. */
const fn = (s: string): string => `<span style="color:var(--accent);">${s}</span>`;
/** Wrap `s` in the comment color. */
const cm = (s: string): string => `<span style="color:var(--faint);">${s}</span>`;

// Keep every line under ~48 characters: the hero code panel is roughly 430px wide
// at desktop, and longer lines get clipped behind a scrollbar on first paint.
const PROMPTS_CODE = `${cm('// ask for the alias, not a version number')}
${kw('const')} { messages, tools } = ${kw('await')} hub.prompts.${fn('render')}(
  ${st("'support-agent'")},
  ${st("'production'")},
  { ticket },
);`;

const PROMPTS_CODE_PY = `${cm('# ask for the alias, not a version number')}
messages, tools = ${kw('await')} hub.prompts.${fn('render')}(
    ${st('"support-agent"')},
    ${st('"production"')},
    {${st('"ticket"')}: ticket},
)`;

const PROMPTS_CODE_CURL = `${cm('# ask for the alias, not a version number')}
${fn('curl')} $ACRUX/prompts/support-agent/production/render \\
  -H ${st('"Authorization: Bearer $API_KEY"')} \\
  -H ${st('"Content-Type: application/json"')} \\
  -d ${st(`'{
    "variables": { "ticket": "…" }
  }'`)}

${cm('# response: rendered messages + attached tools')}`;

const GATEWAY_CODE = `${cm('# ACRUX=' + API_BASE_URL)}
${cm('# OpenAI-compatible — point any client here')}
${fn('curl')} $ACRUX/gateway/chat/completions \\
  -H ${st('"Authorization: Bearer $GATEWAY_KEY"')} \\
  -H ${st('"Content-Type: application/json"')} \\
  -d ${st(`'{
    "model": "gpt-4o",
    "messages": [{"role":"user","content":"Hi"}]
  }'`)}

${cm('# response headers carry the accounting:')}
${cm('# request-id · provider · cost · cache hit')}`;

const GATEWAY_CODE_TS = `${cm('// routes, prices & traces the call')}
${kw('const')} result = ${kw('await')} hub.gateway.${fn('chat')}({
  model: ${st("'gpt-4o'")},
  messages: [{ role: ${st("'user'")}, content: ${st("'Hi'")} }],
});

console.${fn('log')}(result.content);
console.${fn('log')}(result.gateway.cost);`;

const GATEWAY_CODE_PY = `${cm('# routes, prices & traces the call')}
result = ${kw('await')} hub.gateway.${fn('chat')}(
    ${st("'gpt-4o'")},
    [{${st('"role"')}: ${st('"user"')}, ${st('"content"')}: ${st('"Hi"')}}],
)

${fn('print')}(result.content)
${fn('print')}(result.gateway.cost)`;

const TRACING_CODE_TS = `${cm('// a gateway call is traced on the way through')}
${kw('const')} result = ${kw('await')} hub.gateway.${fn('chat')}({
  model: ${st("'gpt-4o'")}, messages,
  trace: { sessionId: ${st("'support-1234'")} },
});

${cm('// read traces back by session')}
${kw('const')} { data } = ${kw('await')} hub.traces.${fn('list')}({
  sessionId: ${st("'support-1234'")},
});

console.${fn('log')}(data.length + ${st("' traces'")});`;

const TRACING_CODE_PY = `${cm('# not using the gateway? export over OTel')}
${cm("# pip install 'acruxcore[otel]'")}
${kw('from')} acruxcore.otel ${kw('import')} register

${fn('register')}(
    service_name=${st('"support-api"')},
    instrument=[${st('"openai"')}, ${st('"langchain"')}],
)

${cm('# your own provider calls now land as traces')}`;

const TRACING_CODE_CURL = `${cm('# read traces back by session')}
${fn('curl')} ${st('"$ACRUX/traces?sessionId=support-1234"')} \\
  -H ${st('"Authorization: Bearer $API_KEY"')}

${cm('# response: trace list with spans, cost')}
${cm('# and latency per call')}`;

const TOOLS_CODE = `${cm('# the function IS the tool definition')}
@acrux.${fn('tool')}
${kw('async def')} ${fn('query_database')}(sql: str) -> str:
    ${st('"""Run a read-only SQL query."""')}
    ${kw('return')} json.${fn('dumps')}(db.${fn('run')}(sql))

${cm('# the first run registers it in the catalog')}
result = ${kw('await')} hub.gateway.${fn('run_tool_loop')}(
    model=${st('"gpt-4o"')}, messages=messages,
    tools=[query_database],
)

${cm('# name, description and argument schema all')}
${cm('# came from the function — nothing to sync')}`;

const TOOLS_CODE_TS = `${cm('// define the tool with acrux.tool')}
${kw('const')} queryDatabase = ${fn('acrux')}.${fn('tool')}(
  { name: ${st("'query_database'")} },
  ${kw('async')} ({ sql }) => {
    ${kw('return')} JSON.${fn('stringify')}(db.${fn('run')}(sql));
  },
);

${cm('// first call registers it in the catalog')}
${kw('const')} result = ${kw('await')} hub.gateway.${fn('runToolLoop')}({
  model: ${st("'gpt-4o'")}, messages,
  tools: [queryDatabase],
});

${cm('// name, description and argument schema')}
${cm('// came from the function — nothing to sync')}`;

// Every id in this sample is a UUID. The shortened literals below say so at a
// glance, and `$EXP_ID` / `$RUN_ID` are read from the previous response — the
// earlier version used `v7`/`v8` (rejected by the API, which validates
// `version_ids` as UUIDs) and bare `<id>` placeholders (swallowed as HTML).
const EVALUATION_CODE = `${cm('# every id here is a UUID, not a version number')}
${fn('curl')} -X POST $ACRUX/experiments \\
  -H ${st('"Authorization: Bearer $API_KEY"')} \\
  -H ${st('"Content-Type: application/json"')} \\
  -d ${st(`'{
    "dataset_id": "b7f1c0e2-…",
    "prompt_id": "4d9a7c18-…",
    "version_ids": ["e21c8a5f-…", "9c3b6d40-…"],
    "models": ["gpt-4o-mini"]
  }'`)}
${cm('# → 201 { "id": … }  ← that is $EXP_ID')}

${cm('# start a run (async, returns 202 + run_id)')}
${fn('curl')} -X POST $ACRUX/experiments/$EXP_ID/runs \\
  -H ${st('"Authorization: Bearer $API_KEY"')}

${cm('# poll until succeeded, then read the report')}
${fn('curl')} $ACRUX/runs/$RUN_ID/report \\
  -H ${st('"Authorization: Bearer $API_KEY"')}
${cm('# → per-cell avgScore, passRate, deltaVsBaseline')}

${cm('# drill into one cell (label|model, encoded)')}
${fn('curl')} $ACRUX/runs/$RUN_ID/cells/v2%7Cgpt-4o-mini \\
  -H ${st('"Authorization: Bearer $API_KEY"')}
${cm('# → per-example output, score, judge reason')}`;

const EVALUATION_CODE_TS = `${cm('// sweep a dataset across two committed versions')}
${kw('const')} exp = ${kw('await')} hub.experiments.${fn('create')}({
  datasetId: dataset.id,
  promptId: prompt.id,
  versionIds: [v1.id, v2.id],
  models: [${st("'gpt-4o-mini'")}],
});

${cm('// start a run (async, returns queued)')}
${kw('const')} run = ${kw('await')} hub.experiments.${fn('startRun')}(exp.id);

${cm('// poll until succeeded, then read the report')}
${kw('const')} report = ${kw('await')} hub.runs.${fn('getReport')}(run.runId);
console.${fn('log')}(report.winner);

${cm('// drill into one cell')}
${kw('const')} cell = ${kw('await')} hub.runs.${fn('getCell')}(
  run.runId, ${st("'v2|gpt-4o-mini'")},
);
console.${fn('log')}(cell.examples[0].score);`;

const EVALUATION_CODE_PY = `${cm('# sweep a dataset across two committed versions')}
exp = ${kw('await')} hub.experiments.${fn('create')}(
    dataset_id=dataset.id,
    prompt_id=prompt.id,
    version_ids=[v1.id, v2.id],
    models=[${st('"gpt-4o-mini"')}],
)

${cm('# start a run (async, returns queued)')}
run = ${kw('await')} hub.experiments.${fn('start_run')}(exp.id)

${cm('# poll until succeeded, then read the report')}
report = ${kw('await')} hub.runs.${fn('get_report')}(run.run_id)
${fn('print')}(report.winner)

${cm('# drill into one cell')}
cell = ${kw('await')} hub.runs.${fn('get_cell')}(
    run.run_id, ${st('"v2|gpt-4o-mini"')},
)
${fn('print')}(cell.examples[0][${st('"score"')}])`;

/** The pillar definitions, in the order they appear everywhere on the site. */
export const FEATURES: Record<FeatureSlug, Feature> = {
  prompts: {
    slug: 'prompts',
    name: 'Prompts',
    summary:
      'Versioned, templated message sets. Move a production alias between versions without redeploying your app.',
    eyebrow: 'Prompt management',
    title: 'Prompt management with versions, aliases and diffs.',
    lead: 'Prompts are versioned data, not code. Every save commits an immutable version, and the production alias points at whichever one you promote — so shipping a new prompt is a promotion, not a release.',
    metaTitle: 'Prompt management & versioning — AcruxCore',
    metaDescription:
      'Store prompts as immutable, templated versions with named aliases. Promote production without a redeploy, branch with Jinja2-style conditionals and loops, diff any two versions, and read the full audit trail.',
    icon: (
      <Ic>
        <path d="M4 6h16" />
        <path d="M4 12h16" />
        <path d="M4 18h10" />
      </Ic>
    ),
    capabilitiesTitle: 'Versions, aliases, templating and an audit trail.',
    capabilities: [
      {
        title: 'Immutable versions',
        body: 'Every save commits a new numbered version. Nothing is overwritten, so you can always read back, compare, or return to exactly what shipped last Tuesday.',
      },
      {
        title: 'Named aliases',
        body: 'production and staging are pointers, not copies. Promote a version and the next render through the API returns it; SDK callers pick it up within their cache window — 60 seconds by default, and configurable per client.',
      },
      {
        title: 'Server-side templating',
        body: 'Message sets render on the server with nunjucks, the Jinja2-style syntax: {{ variables }}, {% if %} branches, {% for %} loops and filters. No client is left string-building its own copy.',
      },
      {
        title: 'Diff and audit trail',
        body: 'A unified diff between any two versions, plus a newest-first record of who changed what and when — so a regression has a paper trail.',
      },
    ],
    code: [
      { id: 'ts', filename: 'render.ts', label: 'TS', lang: 'TypeScript', html: PROMPTS_CODE },
      { id: 'py', filename: 'render.py', label: 'PY', lang: 'Python', html: PROMPTS_CODE_PY },
      { id: 'curl', filename: 'render.sh', label: 'CURL', lang: 'curl', html: PROMPTS_CODE_CURL },
    ],
    sections: [
      {
        eyebrow: 'Templating',
        title: 'One prompt, every branch of your logic.',
        lead: 'Templating is more than substitution. Because rendering runs nunjucks on the server, a single version can carry the tier-specific paragraph, the optional context block and the list of past tickets — instead of your code assembling three near-identical prompts.',
        cards: [
          {
            title: 'Variables',
            body: '{{ ticket }} takes the value you pass at render time. Every name the template mentions needs a value: a missing one comes back as a 400 that names it, rather than a prompt that silently rendered an empty string.',
          },
          {
            title: 'Conditions',
            body: '{% if plan == "enterprise" %} … {% else %} … {% endif %} keeps one prompt where teams usually keep three. Filters and dotted access work too — {{ user.name | upper }}.',
          },
          {
            title: 'Loops',
            body: '{% for msg in history %} … {% endfor %} walks a list you pass in, and {% for k, v in fields %} destructures pairs. The loop variable counts as a referenced name, so give it any value — the render never reads it.',
          },
        ],
        note: 'The dashboard Preview tab binds every variable as text, so a loop over a real array is exercised against the render endpoint or an SDK rather than in Preview. A conditional-only example works in Preview as it is.',
        links: [{ label: 'Guide: conditional logic in templates', href: DOCS.conditionalTemplates }],
      },
      {
        eyebrow: 'Prompts + gateway',
        title: 'Send the prompt name, not the messages.',
        lead: 'A gateway completion can carry a stored prompt reference in place of a message array. The platform renders the version the alias points at, attaches the tools bound to it, calls the model and records the version behind the answer — in one request.',
        cards: [
          {
            title: 'What you send',
            body: 'A model name, plus prompt: { name, alias, variables }. Which version is live stays out of your code entirely.',
          },
          {
            title: 'What comes back',
            body: 'An ordinary OpenAI-shaped response, with the provider, cost and prompt version on the gateway headers and in the trace.',
          },
          {
            title: 'Or keep the two steps',
            body: 'Render first when your app needs the messages itself — a client-side tool loop, or a provider you call directly. Rendering does not require the gateway at all.',
          },
        ],
        links: [
          { label: 'Reference: gateway completions', href: DOCS.gatewayApi },
          { label: 'Guide: manage prompts from the SDK', href: DOCS.promptsViaSdk },
        ],
      },
    ],
    shot: {
      src: '/img/features/prompt-editor.png',
      alt: 'The AcruxCore prompt editor showing the support-reply prompt with production and staging aliases on v2, a default model, and system and user messages containing template variables.',
      caption: 'The prompt editor: aliases on the left, message set below, and a commit that mints the next version.',
      width: 1280,
      height: 800,
    },
    dashboard: [
      'Edit a prompt and commit a new version straight from the browser.',
      'Preview a render with sample variables before you commit it.',
      'Set a default model per prompt so callers never have to pass one.',
      'Attach tools from the catalog — render returns them alongside the messages.',
      'Promote or roll back an alias in one click, written to the audit log.',
      'Export a version as portable JSON, and import it back into another team.',
    ],
    docs: [
      { label: 'Guide: version a prompt', href: DOCS.versionPrompt },
      { label: 'Guide: conditional logic in templates', href: DOCS.conditionalTemplates },
      { label: 'Guide: diff, export and import', href: DOCS.diffExportImport },
      { label: 'Guide: prompts from the SDK', href: DOCS.promptsViaSdk },
      { label: 'API: prompts & versions', href: DOCS.promptsApi },
      { label: 'Core concepts', href: DOCS.coreConcepts },
    ],
    cta: {
      title: 'Create your first prompt.',
      body: 'Commit a version, point the production alias at it, and render it by name from your app. No credit card required, and the gateway is optional.',
    },
  },

  gateway: {
    slug: 'gateway',
    name: 'Gateway',
    summary:
      'One OpenAI-compatible endpoint in front of the providers you connect. Bring your own keys; get routing, fallbacks, cost and caching.',
    eyebrow: 'AI gateway',
    title: 'An AI gateway that speaks OpenAI to every provider you connect.',
    lead: 'Point your existing OpenAI client at the gateway and keep your code. AcruxCore resolves the model to a provider — OpenAI, Anthropic, Gemini, or any OpenAI-compatible endpoint you register — calls it with your key, prices the result and records the request. Streaming included.',
    metaTitle: 'OpenAI-compatible AI gateway — AcruxCore',
    metaDescription:
      'A drop-in OpenAI-compatible gateway in front of OpenAI, Anthropic, Gemini, and any compatible provider. Bring your own keys, issue scoped virtual keys with rate limits, cap spend with budgets, fall back automatically, and get cost on every response.',
    icon: (
      <Ic>
        <path d="M3 8h6l3 8h9" />
        <path d="M17 4l3 4-3 4" />
        <path d="M3 16h4" />
      </Ic>
    ),
    capabilitiesTitle: 'Compatibility, your own keys, guardrails and cost.',
    capabilities: [
      {
        title: 'Drop-in compatible',
        body: 'POST /gateway/chat/completions speaks the OpenAI wire format, streaming included. Swap the base URL and your current client, retries, and code paths all stay put.',
      },
      {
        title: 'Bring your own keys',
        body: 'Store an OpenAI, Anthropic, Gemini or OpenAI-compatible credential — base URL included — encrypted at rest. We sit in front of your provider account and never take it over.',
      },
      {
        title: 'Virtual keys with guardrails',
        body: 'Issue scoped keys that never expose a provider credential. Restrict one to named models or providers, cap its requests and tokens per minute, and cap spend by day, week, month or total.',
      },
      {
        title: 'Cost on every response',
        body: 'x-gateway-* headers return the request id, the provider that served it, the priced cost, and whether it was a cache hit. Accounting is not a batch job you run later.',
      },
    ],
    code: [
      { id: 'curl', filename: 'gateway.sh', label: 'CURL', lang: 'curl', html: GATEWAY_CODE },
      { id: 'ts', filename: 'gateway.ts', label: 'TS', lang: 'TypeScript', html: GATEWAY_CODE_TS },
      { id: 'py', filename: 'gateway.py', label: 'PY', lang: 'Python', html: GATEWAY_CODE_PY },
    ],
    sections: [
      {
        eyebrow: 'Reliability',
        title: 'Automatic model fallbacks.',
        lead: 'Each model you register carries an ordered list of backups. When a call cannot be served, the gateway walks that chain and answers from the first model that can — the request shape your app sends never changes.',
        table: {
          head: ['What went wrong', 'What the gateway does'],
          rows: [
            [
              'Rate limit, 5xx or network timeout',
              'Retries the same model first, then works down your chain until one answers.',
            ],
            [
              'Bad or revoked credential (401, 403)',
              'Skips the retry — a wrong key will stay wrong — and moves straight to the next model in the chain.',
            ],
            [
              'Malformed request (400)',
              'Comes back to you immediately. A request the provider rejected as invalid is not worth sending anywhere else.',
            ],
          ],
        },
        note: 'A fallback answer is priced, traced and reported like any other, with the provider that actually served it on the response headers. Sending a fallback list replaces the whole ordered chain, so send it as one set.',
        links: [{ label: 'Guide: automatic model fallbacks', href: DOCS.modelFallbacks }],
      },
      {
        eyebrow: 'Cost control',
        title: 'Cache repeated requests.',
        lead: 'Caching is opt-in per virtual key: give a key a TTL and identical requests inside that window are answered from your own team cache instead of the provider.',
        cards: [
          {
            title: 'What counts as identical',
            body: 'A hash of the request parameters — same model, same messages, same settings. Only non-streaming calls that ask for temperature 0 are eligible, because anything else is a request to vary.',
          },
          {
            title: 'What you see',
            body: 'x-gateway-cache: hit or miss on every response, and $0 for a hit. The call is still traced and still written to the usage ledger, so a cached answer is never an invisible one.',
          },
          {
            title: 'What it measured',
            body: 'On one published run — 15 prompts, four repeats each, gpt-4o-mini, a five-minute window — the repeats came back from cache. Your own hit rate depends on how repetitive your traffic really is.',
          },
        ],
        note: 'Caching is per team and per key, never shared between teams. It is a setting you turn on deliberately, not a default that quietly answers for a model.',
        links: [
          { label: 'Benchmark: exact-match gateway caching', href: DOCS.cachingBenchmark },
          { label: 'Guide: scope access with virtual keys', href: DOCS.virtualKeys },
          { label: 'Guide: budgets and rate limits', href: DOCS.budgetsAndRateLimits },
        ],
      },
    ],
    shot: {
      src: '/img/features/gateway-playground.png',
      alt: 'The AcruxCore Playground sending a streaming completion, with a gateway telemetry strip showing provider, model, cost, cache status and latency below the request form.',
      caption: 'The Playground sends a real gateway call and shows the telemetry it returns — provider, cost, cache, latency.',
      width: 1280,
      height: 800,
    },
    dashboard: [
      'Register a public model name that maps to a credential and an upstream model.',
      'Test a registered model in one click before your app depends on it.',
      'Try any model in the Playground — ad-hoc messages, or a stored prompt by name.',
      'Read request logs with the exact prompt version that produced each call.',
      'Watch spend against a budget, per key or across the whole team.',
      'Rotate a provider credential without touching a line of application code.',
    ],
    docs: [
      { label: 'Guide: route calls through the gateway', href: DOCS.useGateway },
      { label: 'Guide: automatic model fallbacks', href: DOCS.modelFallbacks },
      { label: 'Guide: scope access with virtual keys', href: DOCS.virtualKeys },
      { label: 'Guide: budgets and rate limits', href: DOCS.budgetsAndRateLimits },
      { label: 'API: gateway chat completions', href: DOCS.gatewayApi },
      { label: 'API: connections, keys & budgets', href: DOCS.apiReference },
    ],
    cta: {
      title: 'Connect your first model.',
      body: 'Store a provider credential, map a public model name to it, and route one call through the gateway. Your keys stay yours, and no credit card is required.',
    },
  },

  tracing: {
    slug: 'tracing',
    name: 'Tracing',
    summary:
      'Every gateway call recorded as a trace with spans — model, tokens, latency, cost. Or export your own spans over OpenTelemetry.',
    eyebrow: 'Tracing & observability',
    title: 'LLM tracing and observability for every call.',
    lead: 'A call becomes a trace with spans for model, tokens, latency and cost. Route through the gateway and tracing is already on, with nothing to instrument. Keep calling providers directly and the same spans arrive over OpenTelemetry instead.',
    metaTitle: 'LLM tracing & observability — AcruxCore',
    metaDescription:
      'Every gateway call becomes a trace with spans for model, tokens, latency and cost, or send your own spans over OpenTelemetry. Group traces into sessions, filter by tag or metadata, attach human feedback to any span, and control payload capture per team.',
    icon: (
      <Ic>
        <circle cx={11} cy={11} r={7} />
        <path d="m21 21-4.3-4.3" />
      </Ic>
    ),
    capabilitiesTitle: 'Spans, sessions, feedback and payload control.',
    capabilities: [
      {
        title: 'Spans, not log lines',
        body: 'A trace is a tree. A tool-calling loop shows up as the model span, the tool span beneath it, and the follow-up model span — with tokens and cost attributed to each.',
      },
      {
        title: 'Sessions',
        body: 'Group related traces under a shared session id and read a whole conversation or agent run back as one rolled-up view instead of a pile of disconnected requests.',
      },
      {
        title: 'Human feedback',
        body: 'Attach a rating, label, or comment to a trace or to one span inside it. That feedback is what later becomes an evaluation dataset.',
      },
      {
        title: 'Payload capture you control',
        body: 'Metadata is always recorded. Storing full request and response bodies is a per-team switch you own, so sensitive content is only kept when you decide it should be.',
      },
    ],
    code: [
      { id: 'ts', filename: 'trace.ts', label: 'TS', lang: 'TypeScript', html: TRACING_CODE_TS },
      { id: 'py', filename: 'otel.py', label: 'PY', lang: 'Python', html: TRACING_CODE_PY },
      { id: 'curl', filename: 'trace.sh', label: 'CURL', lang: 'curl', html: TRACING_CODE_CURL },
    ],
    sections: [
      {
        eyebrow: 'Integration',
        title: 'Two ways to send traces.',
        lead: 'The gateway is the shortest path to a trace, not the only one. Nothing about tracing requires you to move your model calls behind us.',
        cards: [
          {
            title: 'Through the gateway',
            body: 'Every completion the gateway serves is recorded on the way through — spans, tokens, cost, latency and the prompt version behind the call. There is nothing to instrument and no exporter to run.',
          },
          {
            title: 'Over OpenTelemetry',
            body: 'Keep your current model-calling code and export spans to the OTLP endpoint — JSON or protobuf, gzip fine. Both SDKs ship a one-call helper: register() from @acruxcoreai/sdk/otel in Node, and from acruxcore.otel in Python (the otel extra).',
          },
          {
            title: 'Or post spans yourself',
            body: 'POST /traces takes a trace and its spans as plain JSON, so a language with no SDK still reports. Both clients can buffer that call off your critical path.',
          },
        ],
        note: 'The OpenTelemetry path is instrumentation you set up once — an exporter, plus the framework instrumentors you name. Coverage differs by language: Python instruments crewai, langchain, llama_index, openai and openai_agents; Node instruments openai and openai_agents, with LangChain.js and LlamaIndex.TS wired by hand. Only packages already installed are instrumented.',
        links: [
          { label: 'Guide: send OTel traces with the SDK helper', href: DOCS.otelHelper },
          { label: 'Tutorial: trace a CrewAI trip planner', href: DOCS.crewaiTracing },
        ],
      },
      {
        eyebrow: 'Reading them back',
        title: 'Filter, group and score what you collect.',
        lead: 'A trace list only helps if you can reach the one that went wrong. Everything you attach at call time becomes something you can search on later.',
        cards: [
          {
            title: 'Filter on what you tagged',
            body: 'Narrow by model, status, cost, latency, prompt version or session — and by the tags and metadata you set on the call yourself.',
          },
          {
            title: 'Group into sessions',
            body: 'A session id rolls a conversation or an agent run into one view, with the cost and duration of the whole thing rather than of a single step.',
          },
          {
            title: 'Watch the aggregate',
            body: 'Time-series analytics over every span ingested — volume, latency, cost, error rate — so a regression shows up before someone reports it.',
          },
        ],
        note: 'Payload capture decides how much of a span you can read back: metadata is always stored, full request and response bodies only while your team has capture on.',
        links: [
          { label: 'Guide: tag and filter traces', href: DOCS.tagAndFilterTraces },
          { label: 'Guide: view trace analytics', href: DOCS.traceAnalytics },
          { label: 'Guide: configure payload capture', href: DOCS.payloadCapture },
        ],
      },
    ],
    shot: {
      src: '/img/features/trace-detail.png',
      alt: 'An AcruxCore trace detail page showing a runToolLoop trace with three spans — an LLM span, a get_weather tool span beneath it and a second LLM span — each with duration, plus a feedback panel.',
      caption: 'One trace, three spans: the model call, the tool it called, and the model call that used the result.',
      width: 1280,
      height: 800,
    },
    dashboard: [
      'Walk a span tree and see the input and output of each step.',
      'Filter traces by model, status, cost, latency, tag or metadata to find the slow tail.',
      'Rate a span that missed, then jump to the prompt version behind it.',
      'Read time-series analytics over every span the gateway or SDK ingested.',
      'Turn payload capture on or off for the whole team in one setting.',
    ],
    docs: [
      { label: 'Guide: trace an LLM call', href: DOCS.traceCall },
      { label: 'Guide: send OTel traces with the SDK helper', href: DOCS.otelHelper },
      { label: 'Guide: sessions and traces', href: DOCS.sessionsTraces },
      { label: 'Guide: tag and filter traces', href: DOCS.tagAndFilterTraces },
      { label: 'Guide: view trace analytics', href: DOCS.traceAnalytics },
      { label: 'API: traces & feedback', href: DOCS.tracesApi },
    ],
    cta: {
      title: 'Send your first trace.',
      body: 'Route one call through the gateway, or point an OpenTelemetry exporter at your team and keep the provider calls you already have. No credit card required.',
    },
  },

  tools: {
    slug: 'tools',
    name: 'Tools',
    summary: 'Callable functions, versioned like prompts, bound to a prompt alias and handed to the model.',
    eyebrow: 'Tool catalog',
    title: 'A versioned tool catalog for LLM function calling.',
    lead: 'Define a callable function once, version it, and bind it to a prompt. Rendering that prompt hands the model its tools — and you choose whether the call runs inside your own process or server-side over HTTP.',
    metaTitle: 'Tool catalog for LLM function calling — AcruxCore',
    metaDescription:
      'Version tool definitions the same way as prompts, bind them per prompt alias so staging and production can differ, and execute them either in your own process or server-side over HTTP with recorded analytics.',
    icon: (
      <Ic>
        <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.4 2.4-2-2 2.4-2.4Z" />
      </Ic>
    ),
    capabilitiesTitle: 'Versioning, execution, bindings and analytics.',
    capabilities: [
      {
        title: 'The same versioning model',
        body: 'Tools get immutable numbered versions and named aliases, exactly like prompts. Changing a tool schema is a promotion, not a deploy.',
      },
      {
        title: 'Two ways to execute',
        body: 'Keep the function in your own process and let the SDK dispatch to it, or register an HTTP-backed tool the platform calls server-side and records for you.',
      },
      {
        title: 'Bound per prompt alias',
        body: 'A tool belongs to the prompt that uses it, and the binding is per alias. One render call returns the messages and the tool schemas together, so the two can never drift apart.',
      },
      {
        title: 'Execution analytics',
        body: 'Every tool call is recorded as a span with its input, output, and duration — so a flaky tool is visible instead of hiding inside a model answer.',
      },
    ],
    code: [
      { id: 'py', filename: 'agent.py', label: 'PY', lang: 'Python', html: TOOLS_CODE },
      { id: 'ts', filename: 'agent.ts', label: 'TS', lang: 'TypeScript', html: TOOLS_CODE_TS },
    ],
    sections: [
      {
        eyebrow: 'Staging vs production',
        title: 'Which tool version a prompt actually gets.',
        lead: "Bindings are set per prompt alias, so staging can exercise a new tool schema while production keeps the one it trusts. Each cell in a prompt's Tools grid holds one of four things.",
        table: {
          head: ['The binding says', 'What that prompt alias gets'],
          rows: [
            [
              'production v3',
              "Follows the tool's own alias. Promote a new tool version to production and the prompt picks it up with no prompt change at all.",
            ],
            ['pinned v2', "That exact version, whatever the tool's aliases do next."],
            [
              'inherits',
              "Whatever the prompt's default binding says — the common case, and the reason a newly created alias works with no setup.",
            ],
            ['none', 'Nothing. The tool is withheld from that one alias on purpose.'],
          ],
        },
        note: 'Bindings save immediately and are not part of a prompt version, so changing one is not a commit — and rolling a prompt alias back does not roll a binding back with it.',
        links: [
          { label: 'Guide: connect a tool to a prompt', href: DOCS.connectToolToPrompt },
          { label: 'Guide: tool aliases and usage', href: DOCS.toolAliases },
        ],
      },
      {
        eyebrow: 'Execution',
        title: 'What "no deploy" does and does not cover.',
        lead: 'Schemas and bindings are catalog data — changing them is a promotion, and your app never notices. The code behind a tool is a separate question, and the answer depends on where that code runs.',
        cards: [
          {
            title: 'A tool in your process',
            body: "The SDK dispatches to your function, so the model's arguments reach your own code and your own network. Changing that function body is a change to your application, and it ships when your application ships.",
          },
          {
            title: 'An HTTP-backed tool',
            body: 'The platform calls your endpoint server-side, with credentials held as secrets instead of sitting in the tool definition, and can transform the response before the model sees it.',
          },
          {
            title: 'Recorded either way',
            body: 'Both paths write a tool span with input, output and duration, and both feed per-tool analytics — so a slow or failing tool is visible rather than hidden inside a model answer.',
          },
        ],
        links: [{ label: 'Guide: define a tool in code or in the catalog', href: DOCS.toolInCodeOrCatalog }],
      },
    ],
    shot: {
      src: '/img/features/tool-binding.png',
      alt: 'The Tools tab of an AcruxCore prompt, showing a get_weather tool bound to production v3 as the default, with two aliases inheriting that default.',
      caption: 'The Tools tab of a prompt: one default binding, and a column only for an alias that needs something different.',
      width: 1400,
      height: 900,
    },
    dashboard: [
      'Define a tool and its JSON-schema parameters without writing boilerplate.',
      'Bind a tool to any prompt and pick which version each alias points at.',
      'Store credentials for HTTP tools as secrets, never in the tool definition.',
      'Transform an HTTP response before the model sees it.',
      'Read per-tool usage analytics to find the calls that fail or run long.',
    ],
    docs: [
      { label: 'Guide: build and attach a tool', href: DOCS.attachTool },
      { label: 'Guide: connect a tool to a prompt', href: DOCS.connectToolToPrompt },
      { label: 'Guide: in code or in the catalog', href: DOCS.toolInCodeOrCatalog },
      { label: 'Guide: tool aliases and usage', href: DOCS.toolAliases },
      { label: 'Tutorial: a tool-calling agent in Python', href: DOCS.pySdk },
      { label: 'API: tools & execution', href: DOCS.toolsApi },
    ],
    cta: {
      title: 'Connect your first tool.',
      body: 'Define a tool, bind it to a prompt alias, and let the model call it — in your process or over HTTP. No credit card required.',
    },
  },

  evaluation: {
    slug: 'evaluation',
    name: 'Evaluation',
    summary:
      'Score prompt versions and models against a dataset, judge live traffic on a standing rule, and let the optimizer draft the next version.',
    eyebrow: 'Evaluation & optimization',
    title: 'LLM evaluation, experiments and prompt optimization.',
    lead: 'Prove the new prompt is actually better. Build a dataset from real feedback or by hand, sweep it across prompt versions and models, read the result cell by cell — and let the optimizer draft the candidate rewrites before you move the production alias.',
    metaTitle: 'LLM evaluation & prompt optimization — AcruxCore',
    metaDescription:
      'Build evaluation datasets from feedback or by hand, sweep them across prompt versions and models, score live traffic with standing rules, and let the optimizer draft rewrites you can promote in one click.',
    icon: (
      <Ic>
        <rect x={4} y={12} width={4} height={8} rx={1} />
        <rect x={10} y={7} width={4} height={13} rx={1} />
        <rect x={16} y={3} width={4} height={17} rx={1} />
      </Ic>
    ),
    capabilitiesTitle: 'Datasets, experiments, per-cell results and an optimizer.',
    capabilities: [
      {
        title: 'Datasets, however you start',
        body: 'Examples can come from the feedback your team left on real traces, from rows you write by hand, or from live calls a standing rule already scored badly. Existing traffic helps; it is not a prerequisite.',
      },
      {
        title: 'Experiments as sweeps',
        body: 'An experiment is a dataset crossed with prompt versions and models. Ask "does the new version beat production on the cheaper model?" and get a grid instead of an opinion.',
      },
      {
        title: 'Per-cell results',
        body: 'Read every combination back individually — scores, outputs, and the judge reason — so a win in the aggregate cannot hide a regression on the cases you care about.',
      },
      {
        title: 'An optimizer that drafts the next version',
        body: 'Point an optimize run at a dataset and a model rewrites your live prompt — several candidates, each scored against the same cases as the version in production. Promoting one commits a real version and moves the alias.',
      },
    ],
    code: [
      { id: 'curl', filename: 'experiment.sh', label: 'CURL', lang: 'curl', html: EVALUATION_CODE },
      { id: 'ts', filename: 'experiment.ts', label: 'TS', lang: 'TypeScript', html: EVALUATION_CODE_TS },
      { id: 'py', filename: 'experiment.py', label: 'PY', lang: 'Python', html: EVALUATION_CODE_PY },
    ],
    sections: [
      {
        eyebrow: 'Datasets',
        title: 'Three ways to fill a dataset.',
        lead: 'An example is two things: the prompt variables to render, and the criteria a judge should check. Where those rows come from is up to you — a brand-new prompt with no traffic can still be evaluated today.',
        cards: [
          {
            title: 'From feedback',
            body: 'Pick the traces your team marked wrong and pull them in. Each row brings the variables the call was made with, the comment as its criteria, and the session history behind it.',
          },
          {
            title: 'By hand',
            body: 'New dataset creates an empty one, and Add example writes a row: the variable fields, and what a good answer has to do. This is the path for a prompt that has no traffic yet.',
          },
          {
            title: 'From live scores',
            body: 'A standing evaluation rule collects the calls it scored below your threshold. One action turns that pile into a dataset of real failures, ready to run against.',
          },
        ],
        note: 'A complaint reused word-for-word as a rubric grades correct answers badly, so criteria stays editable in place — rewording it is routine curation, not a rare correction.',
        links: [
          { label: 'Guide: evaluate a prompt', href: DOCS.evaluatePrompt },
          { label: 'Guide: evaluate with conversation history', href: DOCS.evaluateWithHistory },
        ],
      },
      {
        eyebrow: 'Offline and online',
        title: 'Evaluate before deployment, monitor after it.',
        lead: 'The same judge runs in two places: on demand against a fixed dataset, and continuously against traffic that is already live.',
        cards: [
          {
            title: 'Offline experiments',
            body: 'A grid of prompt versions and models over one dataset, run when you ask for it. This is the one that gates a promotion, because every variant sees identical inputs.',
          },
          {
            title: 'Online rules',
            body: 'A standing rule matches live LLM calls and a worker scores them shortly after the response returns. It is a measurement, not a gate — nothing is held back from your user while judging happens.',
          },
          {
            title: 'What judging costs',
            body: 'A rule samples 10% of matching calls and stops at 500 judge calls a day by default. Judge calls run through your own gateway keys, so a breached budget disables the rule and notifies the owners.',
          },
        ],
        note: 'Only LLM calls are ever judged. Tool spans are recorded and visible, but a rule never scores one — so a rule cannot be used to grade a tool result directly.',
        links: [{ label: 'Guide: score live traffic with an evaluation rule', href: DOCS.evaluationRules }],
      },
      {
        eyebrow: 'Optimizer',
        title: 'Let a model draft the next prompt version.',
        lead: 'The hardest failure is the one with no stack trace: the answer came back well formed, your code accepted it, and a human read it and said it was wrong. An optimize run turns that judgment into candidate rewrites and scores them the way a hand-written version would be scored.',
        cards: [
          {
            title: 'What it reads',
            body: 'A dataset, and the version the chosen alias points at — production by default. You pick the model that writes the rewrites, and can swap the built-in instructions for a prompt of your own.',
          },
          {
            title: 'What it produces',
            body: 'Several candidate rewrites, each rendered against the same examples and judged with the same criteria, ranked in one report beside the version that is live.',
          },
          {
            title: 'What you do with it',
            body: "Read the diff and the optimizer's own rationale, then promote the candidate that earned it. Promoting commits an ordinary numbered version and moves the alias — there is no separate optimized-prompt object.",
          },
        ],
        note: 'A rewrite that drops or invents a {{ variable }} is discarded before it is ever scored, so a candidate you can promote is always one your code can still render.',
        links: [{ label: 'Guide: improve a prompt from feedback', href: DOCS.improveFromFeedback }],
      },
    ],
    shot: {
      src: '/img/features/evaluation-report.png',
      alt: 'An AcruxCore run report comparing two variants on one model, with a leaderboard scoring v1 at 80 and production at 70, and a matrix marking the production row as the baseline.',
      caption: 'A run report: the leaderboard, then the grid, with production marked as the baseline everything is measured against.',
      width: 1280,
      height: 800,
    },
    dashboard: [
      'Build a dataset from feedback, or write the first examples by hand.',
      'Configure a run across prompt versions and models in one form.',
      'Watch the run progress as the worker processes each cell.',
      'Compare outputs side by side, then drill into a single cell.',
      "Start an optimize run from a dataset and review each candidate's diff.",
      'Promote the winning version to production the moment you are convinced.',
    ],
    docs: [
      { label: 'Guide: evaluate a prompt', href: DOCS.evaluatePrompt },
      { label: 'Guide: improve a prompt from feedback', href: DOCS.improveFromFeedback },
      { label: 'Guide: score live traffic with a rule', href: DOCS.evaluationRules },
      { label: 'Guide: evaluate with conversation history', href: DOCS.evaluateWithHistory },
      { label: 'API: datasets', href: DOCS.datasetsApi },
      { label: 'API: experiments & runs', href: `${DOCS.apiReference}/experiments` },
    ],
    cta: {
      title: 'Build your first evaluation dataset.',
      body: 'Write two examples by hand or pull them from feedback, then run one prompt across two versions and compare. No credit card required.',
    },
  },
};

/** The pillars as an ordered array — the canonical site-wide ordering. */
export const FEATURE_LIST: Feature[] = [
  FEATURES.prompts,
  FEATURES.gateway,
  FEATURES.tracing,
  FEATURES.tools,
  FEATURES.evaluation,
];
