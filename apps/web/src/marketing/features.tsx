import { type ReactNode } from 'react';
import { Ic, DOCS, API_BASE_URL } from './marketing-chrome';

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
  capabilities: Capability[];
  /** The hero code panel. */
  code: { filename: string; lang: string; html: string };
  /** Concrete things the dashboard does for this pillar. */
  dashboard: string[];
  docs: DocLink[];
}

// ── syntax-highlight helpers ────────────────────────────────────────────────
// The code panels ship pre-highlighted HTML rather than running a highlighter in
// the browser, so they cost nothing at render time and prerender to static
// markup. Every string below is authored here — never user input — so the
// `dangerouslySetInnerHTML` in CodeCard has no untrusted path into it.

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
${kw('const')} { messages, tools } = ${kw('await')} hub.${fn('renderPrompt')}(
  ${st("'support-agent'")},
  ${st("'production'")},
  { ticket },
);

${cm('// in the dashboard: commit v8, then point')}
${cm("// 'production' at it. This call renders v8.")}
${cm('// No deploy. No restart. No code change.')}`;

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

const TRACING_CODE = `${cm('// one trace across a multi-turn tool loop')}
${kw('const')} result = ${kw('await')} hub.${fn('runToolLoop')}({
  model: ${st("'gpt-4o'")}, messages, toolDefs: tools, dispatch,
});

${cm('// read it back: spans, tokens, latency, cost')}
${kw('const')} trace = ${kw('await')} hub.${fn('getTrace')}(result.traceId);

${kw('for')} (${kw('const')} span ${kw('of')} trace.spans) {
  console.${fn('log')}(span.name, span.costUsd);
}`;

const TOOLS_CODE = `${cm('# the function IS the tool definition')}
@acrux.${fn('tool')}
${kw('async def')} ${fn('query_database')}(sql: str) -> str:
    ${st('"""Run a read-only SQL query."""')}
    ${kw('return')} json.${fn('dumps')}(db.${fn('run')}(sql))

${cm('# the first run registers it in the catalog')}
result = ${kw('await')} hub.${fn('run_tool_loop')}(
    model=${st('"gpt-4o"')}, messages=messages,
    tools=[query_database],
)

${cm('# name, description and argument schema all')}
${cm('# came from the function — nothing to sync')}`;

const EVALUATION_CODE = `${cm('# sweep a dataset across two versions')}
${fn('curl')} -X POST $ACRUX/experiments \\
  -H ${st('"Authorization: Bearer $API_KEY"')} \\
  -H ${st('"Content-Type: application/json"')} \\
  -d ${st(`'{
    "dataset_id": "…",
    "prompt_version_ids": ["v7", "v8"],
    "models": ["gpt-4o-mini"]
  }'`)}

${cm('# then read per-cell scores, side by side')}`;

/** The pillar definitions, in the order they appear everywhere on the site. */
export const FEATURES: Record<FeatureSlug, Feature> = {
  prompts: {
    slug: 'prompts',
    name: 'Prompts',
    summary:
      'Versioned, templated message sets. Move a production alias between versions without redeploying your app.',
    eyebrow: 'Prompt management',
    title: 'Prompts are versioned data, not code.',
    lead: 'Store every prompt as an immutable, templated message set. Move the production alias to a new version and the next call picks it up — no redeploy, no release, no code change.',
    metaTitle: 'Prompt management & versioning — Acrux Core',
    metaDescription:
      'Store prompts as immutable, templated versions with named aliases. Promote production to a new version without a redeploy, diff any two versions, and read the full audit trail.',
    icon: (
      <Ic>
        <path d="M4 6h16" />
        <path d="M4 12h16" />
        <path d="M4 18h10" />
      </Ic>
    ),
    capabilities: [
      {
        title: 'Immutable versions',
        body: 'Every save commits a new numbered version. Nothing is overwritten, so you can always read back, compare, or return to exactly what shipped last Tuesday.',
      },
      {
        title: 'Named aliases',
        body: 'production and staging are pointers, not copies. Promote a version to an alias and every SDK cache refreshes in the background while your app keeps asking for the same name.',
      },
      {
        title: 'Server-side templating',
        body: 'Message sets take {{ variables }} and render on the server, so the same prompt serves every caller and no client is left string-building its own copy.',
      },
      {
        title: 'Diff and audit trail',
        body: 'A unified diff between any two versions, plus a newest-first record of who changed what and when — so a regression has a paper trail.',
      },
    ],
    code: { filename: 'render.ts', lang: 'TypeScript', html: PROMPTS_CODE },
    dashboard: [
      'Edit a prompt and commit a new version straight from the browser.',
      'Set a default model per prompt so callers never have to pass one.',
      'Attach tools from the catalog — render returns them alongside the messages.',
      'Promote or roll back an alias in one click, written to the audit log.',
      'Export a version as portable JSON, and import it back into another team.',
    ],
    docs: [
      { label: 'Guide: version a prompt', href: DOCS.versionPrompt },
      { label: 'API: prompts & versions', href: DOCS.promptsApi },
      { label: 'Core concepts', href: DOCS.coreConcepts },
    ],
  },

  gateway: {
    slug: 'gateway',
    name: 'Gateway',
    summary:
      'One OpenAI-compatible endpoint in front of every provider. Bring your own keys; get routing, cost, and caching.',
    eyebrow: 'AI gateway',
    title: 'One endpoint in front of every provider.',
    lead: 'Point your existing OpenAI client at the gateway and keep your code. Acrux Core resolves the provider, calls it with your key, prices the result, and records the request — streaming included.',
    metaTitle: 'OpenAI-compatible AI gateway — Acrux Core',
    metaDescription:
      'A drop-in OpenAI-compatible gateway in front of OpenAI, Anthropic, Gemini, and any compatible provider. Bring your own keys, issue scoped virtual keys, cap spend with budgets, and get cost on every response.',
    icon: (
      <Ic>
        <path d="M3 8h6l3 8h9" />
        <path d="M17 4l3 4-3 4" />
        <path d="M3 16h4" />
      </Ic>
    ),
    capabilities: [
      {
        title: 'Drop-in compatible',
        body: 'POST /gateway/chat/completions speaks the OpenAI wire format, streaming included. Swap the base URL and your current client, retries, and code paths all stay put.',
      },
      {
        title: 'Bring your own keys',
        body: 'Store OpenAI, Anthropic, Gemini, or any OpenAI-compatible credential, encrypted at rest. We sit in front of your provider account and never take it over.',
      },
      {
        title: 'Virtual keys and budgets',
        body: 'Issue scoped keys that never expose a provider credential, then cap spend team-wide or per key by day, week, month, or total — so you get cut off, not surprised.',
      },
      {
        title: 'Cost on every response',
        body: 'x-gateway-* headers return the request id, the provider that served it, the priced cost, and whether it was a cache hit. Accounting is not a batch job you run later.',
      },
    ],
    code: { filename: 'gateway.sh', lang: 'curl', html: GATEWAY_CODE },
    dashboard: [
      'Register a public model name that maps to a credential and an upstream model.',
      'Try any registered model in the Playground before it reaches your app.',
      'Read request logs with the exact prompt version that produced each call.',
      'Watch spend against a budget, per key or across the whole team.',
      'Rotate a provider credential without touching a line of application code.',
    ],
    docs: [
      { label: 'Guide: route calls through the gateway', href: DOCS.useGateway },
      { label: 'API: gateway chat completions', href: DOCS.gatewayApi },
      { label: 'API: connections, keys & budgets', href: DOCS.apiReference },
    ],
  },

  tracing: {
    slug: 'tracing',
    name: 'Tracing',
    summary: 'Every call recorded as a trace with spans: model, tokens, latency, cost.',
    eyebrow: 'Tracing & observability',
    title: 'Every call is a trace you can open.',
    lead: 'The gateway records each request as a trace with spans for model, tokens, latency, and cost. There is nothing to instrument — it is already on by the time your first call lands.',
    metaTitle: 'LLM tracing & observability — Acrux Core',
    metaDescription:
      'Every gateway call becomes a trace with spans for model, tokens, latency, and cost. Group traces into sessions, attach human feedback to any span, and control payload capture per team.',
    icon: (
      <Ic>
        <circle cx={11} cy={11} r={7} />
        <path d="m21 21-4.3-4.3" />
      </Ic>
    ),
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
    code: { filename: 'trace.ts', lang: 'TypeScript', html: TRACING_CODE },
    dashboard: [
      'Walk a span tree and see the input and output of each step.',
      'Filter traces by model, status, cost, or latency to find the slow tail.',
      'Rate a span that missed, then jump to the prompt version behind it.',
      'Read time-series analytics over every span the gateway or SDK ingested.',
      'Turn payload capture on or off for the whole team in one setting.',
    ],
    docs: [
      { label: 'Guide: trace an LLM call', href: DOCS.traceCall },
      { label: 'Guide: sessions and traces', href: DOCS.sessionsTraces },
      { label: 'API: traces & feedback', href: DOCS.tracesApi },
    ],
  },

  tools: {
    slug: 'tools',
    name: 'Tools',
    summary: 'Callable functions, versioned like prompts, attached to a prompt and handed to the model.',
    eyebrow: 'Tool catalog',
    title: 'Tools, versioned like prompts.',
    lead: 'Define a callable function once, version it, and attach it to a prompt. Rendering that prompt hands the model its tools — and you choose whether the call runs in your process or server-side over HTTP.',
    metaTitle: 'Tool catalog for LLM function calling — Acrux Core',
    metaDescription:
      'Version tool definitions the same way as prompts, attach them to a prompt so render returns both, and execute them either in your own process or server-side over HTTP with recorded analytics.',
    icon: (
      <Ic>
        <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.4 2.4-2-2 2.4-2.4Z" />
      </Ic>
    ),
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
        title: 'Attached to prompts',
        body: 'A tool belongs to the prompt that uses it. One render call returns the messages and the tool schemas together, so the two can never drift apart.',
      },
      {
        title: 'Execution analytics',
        body: 'Every tool call is recorded as a span with its input, output, and duration — so a flaky tool is visible instead of hiding inside a model answer.',
      },
    ],
    code: { filename: 'agent.py', lang: 'Python', html: TOOLS_CODE },
    dashboard: [
      'Define a tool and its JSON-schema parameters without writing boilerplate.',
      'Attach a tool to any prompt and pick which version the alias points at.',
      'Store credentials for HTTP tools as secrets, never in the tool definition.',
      'Transform an HTTP response before the model sees it.',
      'Read per-tool usage analytics to find the calls that fail or run long.',
    ],
    docs: [
      { label: 'Guide: build and attach a tool', href: DOCS.attachTool },
      { label: 'Guide: a tool-calling agent in Python', href: DOCS.pySdk },
      { label: 'API: tools & execution', href: DOCS.toolsApi },
    ],
  },

  evaluation: {
    slug: 'evaluation',
    name: 'Evaluation',
    summary: 'Build datasets from real feedback and run experiments to compare prompt or model versions on quality.',
    eyebrow: 'Evaluation',
    title: 'Prove the new prompt is actually better.',
    lead: 'Build a dataset out of the traces and feedback you already have, sweep it across prompt versions and models, and read the results cell by cell — before you move the production alias.',
    metaTitle: 'LLM evaluation & experiments — Acrux Core',
    metaDescription:
      'Build evaluation datasets from real traces and feedback, sweep them across prompt versions and models as experiments, and read per-cell results before promoting a prompt to production.',
    icon: (
      <Ic>
        <rect x={4} y={12} width={4} height={8} rx={1} />
        <rect x={10} y={7} width={4} height={13} rx={1} />
        <rect x={16} y={3} width={4} height={17} rx={1} />
      </Ic>
    ),
    capabilities: [
      {
        title: 'Datasets from real traffic',
        body: 'The examples you evaluate against come from traces and the feedback your team already left — not from a synthetic file someone wrote once and forgot.',
      },
      {
        title: 'Experiments as sweeps',
        body: 'An experiment is a dataset crossed with prompt versions and models. Ask "does v8 beat v7 on the cheaper model?" and get a grid instead of an opinion.',
      },
      {
        title: 'Per-cell results',
        body: 'Read every combination back individually — scores, outputs, and the run report — so a win in the aggregate cannot hide a regression on the cases you care about.',
      },
      {
        title: 'The optimize loop',
        body: 'Have the platform draft candidate rewrites, score them against a dataset, and promote the one that wins. You stay the approver, not the copywriter.',
      },
    ],
    code: { filename: 'experiment.sh', lang: 'curl', html: EVALUATION_CODE },
    dashboard: [
      'Build a dataset from traces you have already collected.',
      'Configure a run across prompt versions and models in one form.',
      'Watch the run progress as the worker processes each cell.',
      'Compare outputs side by side in the run report.',
      'Promote the winning version to production the moment you are convinced.',
    ],
    docs: [
      { label: 'Guide: evaluate a prompt', href: DOCS.evaluatePrompt },
      { label: 'API: datasets', href: DOCS.datasetsApi },
      { label: 'API: experiments & runs', href: `${DOCS.apiReference}/experiments` },
    ],
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
