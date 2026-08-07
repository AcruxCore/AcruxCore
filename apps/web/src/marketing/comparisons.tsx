import { DOCS_URL, GITHUB_URL } from './marketing-chrome';

/**
 * The competitors with a row on `/compare` and a matched-example blog post. Kept
 * in sync with the four `acruxcore-vs-<slug>` posts and the
 * `comparing-open-source-alternatives` skill's competitor set (see
 * cross-cutting-faq: LangWatch and LiteLLM dropped).
 */
export type CompetitorSlug = 'langfuse' | 'phoenix' | 'opik' | 'helicone';

/** Where a fact came from, so a reader can check it themselves. */
export interface Source {
  label: string;
  href: string;
}

/**
 * One fact in a comparison row, with its source and which side (if either) it
 * clearly favors. Both flags live on the competitor's own `Fact` object — there is
 * one shared `ACRUX_CORE` record reused across all four competitors, so it has no
 * per-competitor notion of "wins"; the competitor's object is what varies row by
 * row and comparison by comparison, so that is where both directions get recorded.
 */
export interface Fact {
  value: string;
  source?: Source;
  /** Set when this row is a clear win for the competitor — shown plainly, never buried. */
  competitorWins?: boolean;
  /** Set when this row is a clear win for AcruxCore against this specific competitor — shown just as plainly. */
  acruxWins?: boolean;
}

/** Everything needed to render one competitor's row in the `/compare` matrix. */
export interface Comparison {
  slug: CompetitorSlug;
  name: string;
  tagline: string;
  /** The matched-example hands-on post with this competitor's full write-up. */
  postHref: string;
  githubHref: string;
  /** The date these facts were checked against the competitor's own pages. */
  checkedOn: string;
  license: Fact;
  selfHost: Fact;
  gateway: Fact;
  toolCatalog: Fact;
  teamStructure: Fact;
  pricingSummary: Fact;
  rbac: Fact;
  auditLog: Fact;
  promptTemplating: Fact;
  communityStars: string;
  communityNote?: string;
}

/**
 * AcruxCore's own side of every row. One shared record rather than one copy per
 * competitor, since these facts don't change per comparison.
 */
export const ACRUX_CORE = {
  name: 'AcruxCore',
  checkedOn: '2026-08-07',
  license: {
    value: 'Apache License 2.0 — permissive and OSI-approved, with no enterprise-only directory',
    source: { label: 'LICENSE', href: `${GITHUB_URL}/blob/main/LICENSE` },
  },
  selfHost: {
    value: 'docker compose up',
    source: { label: 'GitHub', href: GITHUB_URL },
  },
  gateway: {
    value: 'In the request path — routing, caching, budgets and virtual keys apply before the provider is called',
    source: { label: 'Route calls through the gateway', href: `${DOCS_URL}/docs/guides/route-calls-through-the-gateway` },
  },
  toolCatalog: {
    value: 'Persistent, versioned Tool Catalog — real gateway-executed calls, with its own analytics page',
    source: { label: 'Build and attach a tool', href: `${DOCS_URL}/docs/guides/build-and-attach-a-tool` },
  },
  teamStructure: {
    value: 'Single team-scoped model — members, invites, and roles, no org layer above it',
    source: { label: 'Invite a teammate', href: `${DOCS_URL}/docs/guides/invite-a-teammate` },
  },
  pricing: {
    value: 'Free during beta — bring your own provider keys, no published paid tier yet',
    source: { label: 'Pricing', href: '/pricing' },
  },
  rbac: { value: 'Single role per team member, no org-level layer' },
  auditLog: { value: 'Present and populated by default, no upgrade needed — but scoped to one prompt at a time' },
  promptTemplating: {
    value: 'Every prompt is a template — {% if %} conditionals, {% for %} loops, filters, same syntax as Jinja2',
    source: { label: 'Use conditional logic in prompt templates', href: `${DOCS_URL}/docs/guides/use-conditional-logic-in-prompt-templates` },
  },
} as const;

/** The four competitors with a published comparison, in the order they appear on `/compare`. */
export const COMPARISONS: Record<CompetitorSlug, Comparison> = {
  langfuse: {
    slug: 'langfuse',
    name: 'Langfuse',
    tagline: 'OTel-native tracing and prompt management, with an org/project hierarchy above the team.',
    postHref: `${DOCS_URL}/blog/acruxcore-vs-langfuse`,
    githubHref: 'https://github.com/langfuse/langfuse',
    checkedOn: '2026-08-06',
    license: {
      value:
        'MIT on the core, but a separate Enterprise License governs the ee/ directory, so some features are gated. AcruxCore gates none.',
      source: { label: 'LICENSE', href: 'https://github.com/langfuse/langfuse/blob/main/LICENSE' },
      acruxWins: true,
    },
    selfHost: {
      value: 'docker compose up',
      source: { label: 'GitHub', href: 'https://github.com/langfuse/langfuse' },
    },
    gateway: {
      value: 'Not in the request path — ingests a trace after your own client calls the provider.',
    },
    toolCatalog: {
      value: 'A schema saved from the Playground, reusable project-wide — but no catalog page, no versioning, and nothing ever executes it',
      acruxWins: true,
    },
    teamStructure: {
      value: 'Real two-level hierarchy — organization above project, visible in every settings breadcrumb',
      competitorWins: true,
    },
    pricingSummary: {
      value: 'Free Hobby tier, then $29–$2,499/mo',
      source: { label: 'langfuse.com/pricing', href: 'https://langfuse.com/pricing' },
    },
    rbac: {
      value: 'Two-tiered by design (org role + project role), but Project Role read "N/A on plan" on the account checked',
    },
    auditLog: {
      value: 'Present in the UI, gated behind the Enterprise plan ($2,499/mo — on hosted Langfuse too, not just self-host)',
      acruxWins: true,
    },
    promptTemplating: {
      value: 'Variable substitution only ({{var}}) — Jinja2/Liquid isn\'t rendered natively; conditionals are an open feature request',
      source: { label: 'Using external templating libraries', href: 'https://langfuse.com/faq/all/using-external-templating-libraries' },
      acruxWins: true,
    },
    communityStars: '32,617',
  },

  phoenix: {
    slug: 'phoenix',
    name: 'Phoenix',
    tagline: 'Local-first tracing and evaluation, notebook-native, from Arize.',
    postHref: `${DOCS_URL}/blog/acruxcore-vs-phoenix`,
    githubHref: 'https://github.com/Arize-ai/phoenix',
    checkedOn: '2026-08-07',
    license: {
      value: 'Elastic License 2.0 — source-available, not OSI-approved and not permissive',
      source: { label: 'LICENSE', href: 'https://github.com/Arize-ai/phoenix/blob/main/LICENSE' },
      acruxWins: true,
    },
    selfHost: {
      value: 'docker compose up',
      source: { label: 'GitHub', href: 'https://github.com/Arize-ai/phoenix' },
    },
    gateway: {
      value: 'Not in the request path — the Playground relays through Phoenix\'s own backend; the SDK path calls the provider directly.',
    },
    toolCatalog: {
      value: 'No nav item at all — the closest thing is an ad-hoc JSON Schema per prompt in the Playground; nothing gets executed or measured',
      acruxWins: true,
    },
    teamStructure: {
      value: 'No team or user-management concept in local OSS — visiting /account with auth disabled throws an error',
      acruxWins: true,
    },
    pricingSummary: {
      value: 'Phoenix itself is free; hosted sibling Arize AX from $0–$50/mo',
      source: { label: 'arize.com/pricing', href: 'https://arize.com/pricing/' },
    },
    rbac: { value: 'Not found — no team/user concept in local OSS', acruxWins: true },
    auditLog: { value: 'Not found in any settings page checked', acruxWins: true },
    promptTemplating: {
      value: 'Variable substitution only (mustache or f-string) — no conditional or loop syntax',
      source: { label: 'Using the Playground', href: 'https://arize.com/docs/phoenix/prompt-engineering/how-to-prompts/using-the-playground' },
      acruxWins: true,
    },
    communityStars: '10,923',
  },

  opik: {
    slug: 'opik',
    name: 'Opik',
    tagline: 'Evaluation-first observability from Comet — datasets, experiments, and online scoring rules.',
    postHref: `${DOCS_URL}/blog/acruxcore-vs-opik`,
    githubHref: 'https://github.com/comet-ml/opik',
    checkedOn: '2026-08-07',
    license: {
      value: 'Apache License 2.0, no gated directory found in the repo — the same terms as AcruxCore, a genuine tie',
      source: { label: 'LICENSE', href: 'https://github.com/comet-ml/opik/blob/main/LICENSE' },
    },
    selfHost: {
      value: 'docker compose up',
      source: { label: 'GitHub', href: 'https://github.com/comet-ml/opik' },
    },
    gateway: {
      value: 'Not in the request path — ingests a trace after your own client calls the provider.',
    },
    toolCatalog: {
      value: 'No tool catalog concept at all — its "Agent playground" is a live-connection debugger for your own code, not a schema-definition UI',
      acruxWins: true,
    },
    teamStructure: {
      value: 'No team, member, invite, or org concept anywhere in self-host — Comet\'s own pricing page confirms members are a Cloud-tier feature',
      acruxWins: true,
    },
    pricingSummary: {
      value: 'Open source is free; Comet Cloud from $0–$19/mo',
      source: { label: 'comet.com/site/pricing', href: 'https://www.comet.com/site/pricing/' },
    },
    rbac: { value: 'Not found in self-host — Enterprise-only per Comet\'s pricing page', acruxWins: true },
    auditLog: { value: 'Not found anywhere in the settings pages checked', acruxWins: true },
    promptTemplating: {
      value: 'Mustache substitution by default; a Jinja2 type exists in the SDK, but conditionals/loops in the playground are an open feature request',
      source: { label: 'GitHub issue #5838', href: 'https://github.com/comet-ml/opik/issues/5838' },
      acruxWins: true,
    },
    communityStars: '21,169',
  },

  helicone: {
    slug: 'helicone',
    name: 'Helicone',
    tagline: 'A request-path proxy with per-user metrics — now in maintenance mode after being acquired by Mintlify.',
    postHref: `${DOCS_URL}/blog/acruxcore-vs-helicone`,
    githubHref: 'https://github.com/Helicone/helicone',
    checkedOn: '2026-08-07',
    license: {
      value: 'Apache-2.0, no ee/ split found — the same terms as AcruxCore, a genuine tie',
      source: { label: 'LICENSE', href: 'https://github.com/Helicone/helicone/blob/main/LICENSE' },
    },
    selfHost: {
      value: 'docker compose up',
      source: { label: 'GitHub', href: 'https://github.com/Helicone/helicone' },
    },
    gateway: {
      value:
        'In the request path, same as AcruxCore — but self-hosted routing 501\'d or misrouted on the calls tested. AcruxCore routed the same calls clean on 100/100 rounds.',
      acruxWins: true,
    },
    toolCatalog: {
      value: 'No tool-catalog concept anywhere in self-hosted Helicone — no schema builder, no execution record, nothing',
      acruxWins: true,
    },
    teamStructure: {
      value: 'Single org tier, no project layer — but the "Add New Member" dialog has no role field at all, just an email address',
    },
    pricingSummary: {
      value: 'Free Hobby tier, then $79–$799/mo',
      source: { label: 'helicone.ai/pricing', href: 'https://www.helicone.ai/pricing' },
    },
    rbac: { value: 'No role picker found anywhere in the member-invite flow checked', acruxWins: true },
    auditLog: { value: 'Not found in the settings pages checked', acruxWins: true },
    promptTemplating: {
      value: 'Variable substitution only (prompt_id + inputs) — no templating logic',
      source: { label: 'Prompt Management', href: 'https://docs.helicone.ai/gateway/prompt-integration' },
      acruxWins: true,
    },
    communityStars: '6,044',
    communityNote:
      'Acquired by Mintlify; per Helicone\'s own announcement, "services will remain live... in maintenance mode."',
  },
};

/** The competitors as an ordered array — matches the order they appear on `/compare`. */
export const COMPARISON_LIST: Comparison[] = [
  COMPARISONS.langfuse,
  COMPARISONS.phoenix,
  COMPARISONS.opik,
  COMPARISONS.helicone,
];
