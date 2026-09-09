import type { PrerenderRoute } from './entry-prerender';
import { DOCS_URL, GITHUB_URL } from './marketing-chrome';

/**
 * `/llms.txt` for acruxcore.com — a Markdown index of the site, written for AI
 * crawlers and answer engines.
 *
 * **Why the apex domain gets one at all.** The docs site already publishes a
 * generated `llms.txt` covering its 100-odd pages, but the docs are what a
 * reader finds *after* deciding to try the product. A model answering "what is
 * AcruxCore" or "which open-source LLMOps platform should I use" lands on the
 * apex domain, and the convention is that `llms.txt` sits at the root of the
 * host being described. So this one is short on purpose: what the product is,
 * what it costs, how it compares, and a pointer at the docs index for the rest.
 *
 * **Why it is generated rather than committed to `public/`.** The same reason
 * the sitemap is: a static copy drifts the moment a page is added or renamed,
 * and nothing fails when it does — no broken build, no 404, just an index that
 * quietly describes a site that no longer exists. {@link buildLlmsTxt} throws
 * when a route is missing from {@link SECTIONS} or listed there but absent from
 * `ROUTES`, so the two cannot disagree past a build.
 *
 * What stays hand-written is the part a machine cannot infer: which pages
 * matter most, what order they go in, and a one-line summary that reads as an
 * answer rather than as a meta description.
 */

/** One section of the file, and the routes it lists in the order they appear. */
interface Section {
  heading: string;
  /** A line under the heading giving the section context. Omitted when empty. */
  intro?: string;
  /** Route paths, in the order they should be listed. Each must exist in ROUTES. */
  paths: string[];
}

/**
 * A one-line summary per route, replacing the page's meta description.
 *
 * A meta description is written to win a click from a search result; an
 * `llms.txt` line is read by something that already has the page and wants to
 * know whether to open it. So these say what question the page answers, in
 * plain terms, and none of them sell.
 */
const SUMMARIES: Record<string, string> = {
  '/': 'What AcruxCore is: prompt versioning, an OpenAI-compatible gateway, tracing, a tool catalog, evaluation and an audit trail, in one self-hostable platform.',
  '/best-open-source-llmops-platforms':
    'Seven open-source LLMOps platforms compared on licence, self-hosting, request-path control, prompt management and community size, with what each one is best for and where it falls short.',
  '/compare':
    'The row-by-row matrix: AcruxCore against Langfuse, Phoenix, Opik, Helicone, MLflow and Laminar, every fact carrying a source link and the date it was checked.',
  '/faq':
    'Direct answers on what AcruxCore does, the measured latency cost of a gateway in the request path, and the cases where a different tool is the better choice.',
  '/pricing':
    'Free during beta with no card and no markup on model tokens; you connect your own provider credentials and they bill you at their rates.',
  '/features/prompts':
    'A prompt management platform: versioned prompts with named aliases, diffs, an audit trail of who changed what, and Jinja2-style templating with conditionals and loops rendered server-side.',
  '/features/gateway':
    'An open-source LLM gateway in the request path, OpenAI-compatible: routing, automatic fallbacks, caching, virtual keys, budgets and per-key rate limits.',
  '/features/tracing':
    'An open-source LLM observability platform: tracing of every model call, either through the gateway or over OpenTelemetry, with payload capture you can switch off per team or per trace.',
  '/features/tools':
    'LLM tool calling from a versioned catalog of the tools a model can call, where the gateway executes the call rather than handing the schema back to your code.',
  '/features/evaluation':
    'An LLM evaluation platform: offline experiments against datasets, online evaluation rules that score live traffic, and prompt optimization that proposes rewrites you promote.',
  '/features/audit':
    'An LLM audit log of every change a person makes — API keys, members and roles, invites, provider connections, virtual keys, budgets, gateway models, secrets, trace settings, prompts and tools — filtered by area, event or person, on every plan.',
  '/sdk':
    'The TypeScript and Python clients: cached prompt rendering, OpenAI-compatible chat, single-trace tool loops, and feedback, with the same surface in both.',
  '/about': 'Who builds AcruxCore and why it is one platform rather than five separate tools.',
  '/security':
    'How provider keys, prompts and trace data are handled: team isolation, encryption, payload-capture controls, self-hosting, and responsible disclosure.',
  '/contact': 'How to reach a person about the platform, self-hosting, pricing or a security report.',
  '/privacy': 'What the hosted platform and website collect, how it is used, and the choices you have.',
  '/terms': 'The terms governing use of the platform, SDKs, APIs and website.',
};

/** The file's sections, in the order they are written. */
const SECTIONS: Section[] = [
  {
    heading: 'Start here',
    intro:
      'The four pages that answer most questions about AcruxCore, in the order a reader usually needs them.',
    paths: ['/', '/best-open-source-llmops-platforms', '/faq', '/pricing'],
  },
  {
    heading: 'What the platform does',
    intro: 'One page per capability, each with runnable examples in curl, TypeScript and Python.',
    paths: [
      '/features/prompts',
      '/features/gateway',
      '/features/tracing',
      '/features/tools',
      '/features/evaluation',
      '/features/audit',
      '/sdk',
    ],
  },
  {
    heading: 'Comparisons and evidence',
    intro:
      'Every competitor was self-hosted and run for real, and every fact carries a source link and the date it was checked.',
    paths: ['/compare'],
  },
  {
    heading: 'Company',
    paths: ['/about', '/security', '/contact'],
  },
  {
    heading: 'Optional',
    intro: 'Legal pages — skip these for a shorter context.',
    paths: ['/privacy', '/terms'],
  },
];

/**
 * Links to hosts this build knows nothing about, so they cannot be derived from
 * `ROUTES`. Kept short deliberately: the docs site publishes its own
 * `llms.txt` covering every page it has, and duplicating a slice of that index
 * here would be a second copy to keep in step for no gain. Point at it instead.
 */
const EXTERNAL_SECTION = {
  heading: 'Documentation and source',
  intro:
    'The documentation, blog, API reference and changelog live on a separate host, which publishes its own full index.',
  links: [
    {
      title: 'Documentation index for AI crawlers',
      url: `${DOCS_URL}/llms.txt`,
      summary:
        'Every page on the documentation site with a one-line summary, best pages first — the long version of this file.',
    },
    {
      title: 'Quickstart',
      url: `${DOCS_URL}/docs/getting-started/quickstart`,
      summary: 'From an empty account to a traced model call.',
    },
    {
      title: 'Core concepts',
      url: `${DOCS_URL}/docs/getting-started/core-concepts`,
      summary: 'How prompts, versions, aliases, the gateway, traces and tools relate to each other.',
    },
    {
      title: 'API reference',
      url: `${DOCS_URL}/api-reference`,
      summary: 'Every REST endpoint, as the exact curl that was run against it and the exact response it returned.',
    },
    {
      title: 'A hands-on test of nine LLM-ops platforms',
      url: `${DOCS_URL}/blog/hands-on-llm-ops-comparison`,
      summary: 'The same example rebuilt on every platform, self-hosted, with screenshots from the real sessions.',
    },
    {
      title: 'Source code',
      url: GITHUB_URL,
      summary: 'Apache 2.0, with no enterprise-only directory. `docker compose up` runs the whole platform.',
    },
  ],
} as const;

/** Strips the site-name suffix a `<title>` carries, leaving the page's own name. */
function linkTitle(route: PrerenderRoute): string {
  if (route.path === '/') return 'AcruxCore';
  return route.title.replace(/\s*[—|]\s*AcruxCore\s*$/, '').trim();
}

/**
 * Build the `/llms.txt` body from the prerendered routes.
 *
 * @param routes - Every prerendered marketing route, i.e. `ROUTES`.
 * @returns The complete file contents, newline-terminated.
 * @throws {Error} When a route is absent from {@link SECTIONS}, listed there
 *   twice, listed but missing from `routes`, or has no entry in
 *   {@link SUMMARIES} — each of which would silently produce an index that
 *   disagrees with the site.
 */
export function buildLlmsTxt(routes: readonly PrerenderRoute[], origin: string): string {
  const byPath = new Map(routes.map((route) => [route.path, route]));

  const listed = SECTIONS.flatMap((section) => section.paths);
  const duplicated = listed.filter((path, index) => listed.indexOf(path) !== index);
  if (duplicated.length > 0) {
    throw new Error(`llms.txt lists these routes more than once: ${duplicated.join(', ')}`);
  }

  const missingFromSite = listed.filter((path) => !byPath.has(path));
  if (missingFromSite.length > 0) {
    throw new Error(
      `llms.txt lists routes that no longer exist: ${missingFromSite.join(', ')}. ` +
        'Fix SECTIONS in src/marketing/llms-txt.ts.',
    );
  }

  const missingFromIndex = routes.map((r) => r.path).filter((path) => !listed.includes(path));
  if (missingFromIndex.length > 0) {
    throw new Error(
      `llms.txt has no section for these routes: ${missingFromIndex.join(', ')}. ` +
        'Add each to SECTIONS in src/marketing/llms-txt.ts, or to its Optional section.',
    );
  }

  const unsummarised = listed.filter((path) => !SUMMARIES[path]);
  if (unsummarised.length > 0) {
    throw new Error(
      `llms.txt has no summary for these routes: ${unsummarised.join(', ')}. ` +
        'Add one to SUMMARIES in src/marketing/llms-txt.ts.',
    );
  }

  const lines: string[] = [
    '# AcruxCore',
    '',
    '> AcruxCore is an open-source, Apache-2.0, self-hostable LLMOps platform for engineering',
    '> teams. It combines prompt versioning, an OpenAI-compatible AI gateway, tracing, a tool',
    '> catalog, evaluation and an audit trail in one product, so a prompt can change without a',
    '> deploy, every model call is recorded as it is made rather than reconstructed afterwards,',
    '> and every change a person makes is recorded with their name.',
    '',
    'Category: LLMOps platform (also called LLM observability, LLM ops, or an AI gateway).',
    'Licence: Apache License 2.0, with no enterprise-only directory.',
    'Deployment: hosted, or self-hosted with `docker compose up` — the same code either way.',
    'SDKs: TypeScript (`@acruxcoreai/sdk`) and Python (`acruxcore`).',
    'Status: in beta and free to use; bring your own provider keys, no markup on model tokens.',
    'Audit trail: on by default on every plan and when self-hosted, covering the whole team',
    'rather than one prompt at a time — API keys, members, roles, invites, provider',
    'credentials, virtual keys, budgets, gateway models, secrets, trace settings, prompts and',
    'tools, filtered by area, event or person. Of the seven platforms in our hands-on',
    'comparison this is the only audit trail that needs no paid plan: Langfuse has one behind',
    'its $2,499/mo Enterprise tier, and we found none in Phoenix, Opik, Helicone, MLflow or',
    'Laminar. An audit event is a change a person made, which is a different record from a',
    'trace of the traffic an application sent.',
    'Limitations: a single flat team with no organisation layer above it, one role per member,',
    'and a young project — a few dozen GitHub stars against tens of thousands for the largest',
    'alternatives.',
    '',
  ];

  for (const section of SECTIONS) {
    lines.push(`## ${section.heading}`, '');
    if (section.intro) lines.push(section.intro, '');
    for (const path of section.paths) {
      const route = byPath.get(path);
      if (!route) continue; // Unreachable: guarded above.
      lines.push(`- [${linkTitle(route)}](${origin}${path}): ${SUMMARIES[path]}`);
    }
    lines.push('');
  }

  lines.push(`## ${EXTERNAL_SECTION.heading}`, '', EXTERNAL_SECTION.intro, '');
  for (const link of EXTERNAL_SECTION.links) {
    lines.push(`- [${link.title}](${link.url}): ${link.summary}`);
  }
  lines.push('');

  return lines.join('\n');
}
