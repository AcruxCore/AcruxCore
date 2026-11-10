import { BLOG_URL, DOCS_URL, GITHUB_URL } from './marketing-chrome';

/**
 * The competitors with a row on `/compare` and a matched-example blog post. Kept
 * in sync with the seven `acruxcore-vs-<slug>` posts and the
 * `comparing-open-source-alternatives` skill's competitor set (see
 * cross-cutting-faq: LangWatch and LiteLLM dropped).
 */
export type CompetitorSlug = 'langfuse' | 'phoenix' | 'opik' | 'helicone' | 'mlflow' | 'laminar' | 'agenta';

/** Where a fact came from, so a reader can check it themselves. */
export interface Source {
  label: string;
  href: string;
}

/**
 * One fact in a comparison row, with its source and which side (if either) it
 * clearly favors. All three flags live on the competitor's own `Fact` object — there
 * is one shared `ACRUX_CORE` record reused across all seven competitors, so it has no
 * per-competitor notion of "wins"; the competitor's object is what varies row by
 * row and comparison by comparison, so that is where every verdict gets recorded.
 *
 * At most one flag should be set per fact. A fact with none is a row where the two
 * sides differ without either being better — a design choice, not a scoreline.
 */
export interface Fact {
  value: string;
  source?: Source;
  /** Set when this row is a clear win for the competitor — shown plainly, never buried. */
  competitorWins?: boolean;
  /** Set when this row is a clear win for AcruxCore against this specific competitor — shown just as plainly. */
  acruxWins?: boolean;
  /**
   * Set when both platforms genuinely land in the same place on this row — the same
   * licence terms, the same one-command self-host, the same templating engine. Marked
   * as explicitly as a win, so a reader can tell "we checked and it's even" apart from
   * "nobody scored this row."
   */
  tie?: boolean;
  /**
   * When this one fact was checked, if that is not the date in its column header.
   * A row added after the original sweep carries its own date rather than silently
   * borrowing the column's — the header claims a live self-hosted run, and a row
   * checked later against docs and source is not the same evidence.
   */
  checkedOn?: string;
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
  /**
   * The workload this platform is the better pick for, in one sentence.
   *
   * Every one of these is a restatement of a row below that this competitor
   * wins or ties, never a new claim — the whole point of keeping them in this
   * file is that `/best-open-source-llmops-platforms` cannot say something
   * kinder or harsher about a tool than the sourced facts already do.
   */
  bestFor: string;
  /** The gaps a reader should weigh, drawn from the same rows. */
  limitations: string;
  license: Fact;
  selfHost: Fact;
  gateway: Fact;
  toolCatalog: Fact;
  teamStructure: Fact;
  pricingSummary: Fact;
  rbac: Fact;
  auditLog: Fact;
  promptTemplating: Fact;
  promptOptimizer: Fact;
  /**
   * What the platform's own MCP server lets an AI assistant do. Every competitor here
   * has one (Agenta's only searches its docs), so this row compares capabilities, never
   * presence. `acruxWins` is set only
   * where AcruxCore's server covers everything the competitor's does and more; a
   * competitor whose server has tools ours lacks gets no flag. Tool counts are stated as
   * facts, never used as the score.
   */
  mcpServer: Fact;
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
  tagline:
    'A gateway in the request path, and tools that are defined, versioned, and run in the same place.',
  bestFor:
    'Teams that want prompts, gateway, tracing, and tools in one self-hosted product. Prompts are versioned, and the gateway sits in the request path. Tools are defined and versioned in AcruxCore, and the gateway runs them. From an MCP client such as Claude Code, you can commit a prompt version, promote it, run it through AcruxCore\'s gateway, and read the resulting trace. Feedback from users and notes from developers become a dataset of test cases. Standing rules score live traffic against that dataset. The optimizer proposes rewrites, and you promote a rewrite as a normal prompt version. Every change anyone makes is recorded with their name, whether you use the hosted product or self-host it. Langfuse and Agenta are the only other platforms here with an audit trail, and both put it on their Enterprise plan.',
  limitations:
    'One team with no organization layer, and one role per member. No content or PII guardrails in the request path. Only the local MCP server has a read-only mode, not the hosted one. A smaller community than any competitor on this page.',
  license: {
    value: 'Apache License 2.0, permissive and OSI-approved. No part of the repository is under a different license.',
    source: { label: 'LICENSE', href: `${GITHUB_URL}/blob/main/LICENSE` },
  },
  selfHost: {
    value: 'docker compose up',
    source: { label: 'Self-host with Docker', href: `${DOCS_URL}/docs/getting-started/self-host-with-docker` },
  },
  gateway: {
    value: 'In the request path. Routing, caching, budget checks, and virtual keys all take effect before a call reaches the provider.',
    source: { label: 'Route calls through the gateway', href: `${DOCS_URL}/docs/guides/route-calls-through-the-gateway` },
  },
  toolCatalog: {
    value: 'A Tool Catalog that keeps every version of each tool. The gateway runs those tools, and the catalog reports per-tool usage analytics.',
    source: { label: 'Create a tool', href: `${DOCS_URL}/docs/guides/create-a-tool` },
  },
  teamStructure: {
    value: 'One team with members, invites, and roles. Nothing sits above the team.',
    source: { label: 'Invite a teammate', href: `${DOCS_URL}/docs/guides/invite-a-teammate` },
  },
  pricing: {
    value: 'Free to use. You bring your own provider keys, and there is no paid plan.',
    source: { label: 'Pricing', href: '/pricing' },
  },
  rbac: {
    value: 'One role per team member, and no organization layer above the team.',
    source: {
      label: 'Manage team roles and permissions',
      href: `${DOCS_URL}/docs/guides/manage-team-roles-and-permissions`,
    },
  },
  auditLog: {
    value:
      'On by default, with nothing to pay and nothing to switch on. Every prompt and every tool keeps its own history, and the team has one trail you can filter by area, event, or person.',
    source: { label: 'Read the team audit trail', href: `${DOCS_URL}/docs/guides/read-the-team-audit-trail` },
  },
  promptTemplating: {
    value: 'Every prompt is a template. Templates take {% if %} conditionals, {% for %} loops, and filters, in the same syntax as Jinja2.',
    source: { label: 'Use conditional logic in prompt templates', href: `${DOCS_URL}/docs/guides/use-conditional-logic-in-prompt-templates` },
  },
  promptOptimizer: {
    value:
      'Built into the dashboard. The optimizer rewrites a prompt from failed test cases and judge feedback, scores each rewrite on several models, and you promote the winner.',
    source: { label: 'Improve a prompt from feedback', href: `${DOCS_URL}/docs/guides/improve-a-prompt-from-feedback` },
    checkedOn: '2026-09-10',
  },
  mcpServer: {
    value:
      'The server has 32 tools. AcruxCore hosts it, and you can also run it locally with npx. An assistant can commit a prompt version, promote it to an alias, and run it through AcruxCore\'s gateway. The assistant can then read the resulting trace, test a prompt over a dataset, and call entries in the Tool Catalog.',
    source: { label: 'Connect an MCP client', href: `${DOCS_URL}/docs/guides/connect-an-mcp-client` },
    checkedOn: '2026-10-18',
  },
} as const;

/** The seven competitors with a published comparison, in the order they appear on `/compare`. */
export const COMPARISONS: Record<CompetitorSlug, Comparison> = {
  langfuse: {
    slug: 'langfuse',
    name: 'Langfuse',
    tagline: 'OpenTelemetry-based tracing and prompt management, with an organization layer above projects.',
    postHref: `${BLOG_URL}/acruxcore-vs-langfuse`,
    githubHref: 'https://github.com/langfuse/langfuse',
    checkedOn: '2026-08-06',
    bestFor:
      'Teams that need an organization layer above the project, and the largest community here.',
    limitations:
      'Its gateway is a beta for OpenAI and Anthropic, with no spend caps or fallbacks yet. Variable substitution only, with no conditionals or loops. The audit log needs the $2,499/mo Enterprise plan, even if you self-host. The ee/ folders in the repository are under a separate enterprise licence.',
    license: {
      value:
        'MIT, except for the ee/ folders. A separate Enterprise License covers those folders, so the features in them are not MIT. AcruxCore has no such folder.',
      source: { label: 'LICENSE', href: 'https://github.com/langfuse/langfuse/blob/main/LICENSE' },
      acruxWins: true,
    },
    selfHost: {
      value: 'docker compose up',
      source: { label: 'GitHub', href: 'https://github.com/langfuse/langfuse' },
      tie: true,
    },
    gateway: {
      value:
        'In public beta since 9 November 2026, for OpenAI and Anthropic. The Langfuse AI Gateway holds the provider keys, gives each person or service its own key, and shows spend per key. Hard spend caps and fallbacks between providers are still on its roadmap, and its docs describe no response cache.',
      source: { label: 'Langfuse AI Gateway', href: 'https://langfuse.com/docs/gateway/overview' },
      acruxWins: true,
      checkedOn: '2026-11-10',
    },
    toolCatalog: {
      value: 'You can save a tool schema from the Playground and reuse it anywhere in the same Langfuse project. There is no catalog page, no version history, and nothing ever runs the tool.',
      acruxWins: true,
    },
    teamStructure: {
      value: 'Two levels, with an organization above the project. Every settings breadcrumb shows the organization and the project.',
      competitorWins: true,
    },
    pricingSummary: {
      value: 'Free Hobby tier, then $29–$2,499/mo',
      source: { label: 'langfuse.com/pricing', href: 'https://langfuse.com/pricing' },
    },
    rbac: {
      value: 'Organization roles on every plan. Project-level roles need Pro with the Teams add-on or Enterprise on Langfuse Cloud, and a licence key when self-hosted.',
      source: { label: 'langfuse.com/pricing', href: 'https://langfuse.com/pricing' },
      checkedOn: '2026-11-02',
    },
    auditLog: {
      value: 'The audit log is in the UI. It needs the Enterprise plan at $2,499/mo, whether you use hosted Langfuse or self-host it.',
      acruxWins: true,
    },
    promptTemplating: {
      value: 'Variable substitution only, written as {{var}}. Langfuse does not render Jinja2 or Liquid itself, and a feature request for conditionals is still open.',
      source: { label: 'Using external templating libraries', href: 'https://langfuse.com/faq/all/using-external-templating-libraries' },
      acruxWins: true,
    },
    promptOptimizer: {
      value:
        'No optimizer in the product. An Agent Skill in Claude Code reads trace feedback and edits the prompt through Langfuse\'s API.',
      source: { label: 'Prompt improvement with Agent Skills', href: 'https://langfuse.com/blog/2026-02-16-prompt-improvement-claude-skills' },
      acruxWins: true,
      checkedOn: '2026-09-10',
    },
    mcpServer: {
      value:
        'Langfuse\'s hosted server has about 95 tools for prompts, datasets, experiments, evaluators, scores, annotation queues, dashboards and traces. Read and write tools are on by default. Some tools create prompts and move prompt labels, but no tool runs a stored prompt.',
      source: { label: 'Langfuse MCP server', href: 'https://langfuse.com/docs/api-and-data-platform/features/mcp-server' },
      checkedOn: '2026-11-02',
    },
    communityStars: '36,886',
  },

  phoenix: {
    slug: 'phoenix',
    name: 'Phoenix',
    tagline: 'Arize\'s tracing and evaluation, running on your own machine inside a notebook.',
    postHref: `${BLOG_URL}/acruxcore-vs-phoenix`,
    githubHref: 'https://github.com/Arize-ai/phoenix',
    checkedOn: '2026-08-07',
    bestFor:
      'Tracing and evaluation on one machine, from a notebook, with nothing to set up and no account to create.',
    limitations:
      'Elastic License 2.0 is source-available rather than OSI-approved. There are no teams, and users and roles need authentication switched on. Nothing sits in the request path, and there is no tool catalog.',
    license: {
      value: 'Elastic License 2.0. Source-available, not OSI-approved, and not permissive.',
      source: { label: 'LICENSE', href: 'https://github.com/Arize-ai/phoenix/blob/main/LICENSE' },
      acruxWins: true,
    },
    selfHost: {
      value: 'docker compose up',
      source: { label: 'GitHub', href: 'https://github.com/Arize-ai/phoenix' },
      tie: true,
    },
    gateway: {
      value:
        'Not in the request path. The Playground is the one place where a call goes through Phoenix\'s own backend. From the SDK your client calls the provider directly, with nothing in between to route or cap the call.',
      acruxWins: true,
    },
    toolCatalog: {
      value: 'No catalog anywhere in Phoenix\'s navigation. The closest thing is a JSON Schema written per prompt in Phoenix\'s Playground, and nothing runs or measures that schema.',
      acruxWins: true,
    },
    teamStructure: {
      value: 'No teams. Users and three instance-wide roles when authentication is on.',
      acruxWins: true,
      checkedOn: '2026-11-02',
    },
    pricingSummary: {
      value: 'Phoenix itself is free. Arize AX, Arize\'s hosted product, costs $0–$50/mo.',
      source: { label: 'arize.com/pricing', href: 'https://arize.com/pricing/' },
    },
    rbac: {
      value: 'Three roles (admin, member, viewer) once you set PHOENIX_ENABLE_AUTH and PHOENIX_SECRET; authentication is off by default.',
      source: { label: 'Authentication', href: 'https://arize.com/docs/phoenix/self-hosting/features/authentication' },
      acruxWins: true,
      checkedOn: '2026-11-02',
    },
    auditLog: { value: 'Not found in any settings page we checked.', acruxWins: true },
    promptTemplating: {
      value: 'Mustache (full syntax, including sections and inverted sections), f-string, or none. There is no Jinja-style if/for syntax.',
      source: { label: 'Prompts concepts', href: 'https://arize.com/docs/phoenix/prompt-engineering/concepts-prompts/prompts-concepts' },
      acruxWins: true,
      checkedOn: '2026-11-02',
    },
    promptOptimizer: {
      value:
        'Arize\'s Prompt Learning optimizer rewrites a prompt from eval results. The optimizer sits in a separate research repo that you clone, not on PyPI or in the Phoenix app.',
      source: { label: 'Arize-ai/prompt-learning', href: 'https://github.com/Arize-ai/prompt-learning' },
      acruxWins: true,
      checkedOn: '2026-09-10',
    },
    mcpServer: {
      value:
        'Phoenix\'s local server has 27 tools for prompts, traces, spans, sessions, datasets and experiments. The hosted server can call any REST endpoint, including chat completions, and can be set read-only. No tool runs a stored prompt.',
      source: { label: 'Phoenix MCP server source', href: 'https://github.com/Arize-ai/phoenix/blob/main/src/phoenix/server/mcp_server.py' },
      checkedOn: '2026-10-18',
    },
    communityStars: '10,923',
  },

  opik: {
    slug: 'opik',
    name: 'Opik',
    tagline: 'Observability from Comet, built around datasets, experiments, and online scoring rules.',
    postHref: `${BLOG_URL}/acruxcore-vs-opik`,
    githubHref: 'https://github.com/comet-ml/opik',
    checkedOn: '2026-08-07',
    bestFor:
      'Evaluation work with datasets, experiments and online scoring rules, under the same Apache 2.0 terms as AcruxCore.',
    limitations:
      'No teams, members or invites when self-hosted, because members are a Cloud-tier feature. Nothing in the request path, and no tool catalog. Opik also offers an LLM Gateway in beta, which its docs say is for development and testing. Mustache substitution by default, with playground conditionals still an open feature request.',
    license: {
      value: 'Apache License 2.0, and no part of the repository is under a different license. The same terms as AcruxCore.',
      source: { label: 'LICENSE', href: 'https://github.com/comet-ml/opik/blob/main/LICENSE' },
      tie: true,
    },
    selfHost: {
      value: 'docker compose up',
      source: { label: 'GitHub', href: 'https://github.com/comet-ml/opik' },
      tie: true,
    },
    gateway: {
      value:
        'Not in the request path. Opik receives a trace after your own client has called the provider, so it cannot enforce a budget, serve a cache hit, or issue a virtual key. Opik also offers an LLM Gateway in beta, which its docs say is for development and testing.',
      source: { label: 'Opik LLM Gateway', href: 'https://www.comet.com/docs/opik/integrations/opik-llm-gateway' },
      acruxWins: true,
      checkedOn: '2026-11-02',
    },
    toolCatalog: {
      value: 'No tool catalog. Opik\'s "Agent playground" attaches to your own running code for debugging, rather than letting you define a tool schema.',
      acruxWins: true,
    },
    teamStructure: {
      value: 'No teams, members, invites, or organizations when you self-host. Comet\'s own pricing page says members are a Cloud-tier feature.',
      acruxWins: true,
    },
    pricingSummary: {
      value: 'The open-source version is free. Comet Cloud costs $0–$19/mo.',
      source: { label: 'comet.com/site/pricing', href: 'https://www.comet.com/site/pricing/' },
    },
    rbac: { value: 'Not found when you self-host. Comet\'s pricing page lists roles as Enterprise-only.', acruxWins: true },
    auditLog: { value: 'Not found in any settings page we checked.', acruxWins: true },
    promptTemplating: {
      value: 'Mustache substitution by default. Opik\'s SDK has a Jinja2 prompt type, but a feature request for conditionals and loops in the playground is still open.',
      source: { label: 'GitHub issue #5838', href: 'https://github.com/comet-ml/opik/issues/5838' },
      acruxWins: true,
    },
    promptOptimizer: {
      value:
        'Opik Agent Optimizer (Apache 2.0) rewrites a prompt against a dataset and a metric, with more algorithms than AcruxCore, including GEPA. You start a run from the SDK, not the UI.',
      source: { label: 'Opik Agent Optimizer', href: 'https://github.com/comet-ml/opik/blob/main/sdks/opik_optimizer/README.md' },
      checkedOn: '2026-09-10',
    },
    mcpServer: {
      value:
        'Read and write traces, scores, prompt versions, test suites and experiment records; no delete.',
      source: { label: 'Opik MCP tools', href: 'https://www.comet.com/docs/opik/mcp-server/tools' },
      checkedOn: '2026-11-02',
    },
    communityStars: '21,169',
  },

  helicone: {
    slug: 'helicone',
    name: 'Helicone',
    tagline: 'A request-path proxy with per-user metrics. It has been in maintenance mode since Mintlify acquired it.',
    postHref: `${BLOG_URL}/acruxcore-vs-helicone`,
    githubHref: 'https://github.com/Helicone/helicone',
    checkedOn: '2026-08-07',
    bestFor:
      'A request-path gateway for teams that want rate limits, metrics and alerts per end user, or one bill for 100+ providers.',
    limitations:
      'In maintenance mode since the Mintlify acquisition. Prompt variables are flat, with no conditionals or loops, and there is no tool catalog.',
    license: {
      value: 'Apache License 2.0, and no part of the repository is under a different license. The same terms as AcruxCore.',
      source: { label: 'LICENSE', href: 'https://github.com/Helicone/helicone/blob/main/LICENSE' },
      tie: true,
    },
    selfHost: {
      value: 'docker compose up',
      source: { label: 'GitHub', href: 'https://github.com/Helicone/helicone' },
      tie: true,
    },
    gateway: {
      value:
        'In the request path, same as AcruxCore. The hosted AI Gateway lists 100+ providers and can bill you from Helicone credits. In our self-hosted benchmark it forwarded all 300 calls to OpenAI.',
      source: { label: 'AI Gateway', href: 'https://docs.helicone.ai/gateway/overview' },
      tie: true,
      checkedOn: '2026-11-02',
    },
    toolCatalog: {
      value: 'No tool catalog. A prompt version\'s body takes the OpenAI chat-request shape, which includes tools, per Helicone\'s prompt API docs and source (not tested).',
      source: { label: 'Create a prompt', href: 'https://docs.helicone.ai/rest/prompts/post-v1prompt-2025' },
      acruxWins: true,
      checkedOn: '2026-11-02',
    },
    teamStructure: {
      value: 'One organization level, with no project layer below it. Members are invited by email, and an admin sets each role in the members list.',
      checkedOn: '2026-11-02',
    },
    pricingSummary: {
      value: 'Free Hobby tier, then $79–$799/mo',
      source: { label: 'helicone.ai/pricing', href: 'https://www.helicone.ai/pricing' },
    },
    rbac: {
      value: 'Three roles: owner, admin and member. An admin changes a role in the members list, not in the invite dialog.',
      source: {
        label: 'orgMemberItem.tsx',
        href: 'https://github.com/Helicone/helicone/blob/main/web/components/templates/organization/orgMemberItem.tsx',
      },
      checkedOn: '2026-11-02',
    },
    auditLog: { value: 'Not found in any settings page we checked, or in the Helicone source.', acruxWins: true, checkedOn: '2026-11-02' },
    promptTemplating: {
      value: 'Variable substitution only, through a prompt_id and its inputs. There is no templating logic.',
      source: { label: 'Prompt Management', href: 'https://docs.helicone.ai/gateway/prompt-integration' },
      acruxWins: true,
    },
    promptOptimizer: {
      value:
        'No optimizer. Helicone\'s old Auto-Improve rewrote a prompt once, with no dataset or scoring, and was deprecated with the prompt editor on 20 August 2025.',
      source: { label: 'Prompt editor (deprecated)', href: 'https://docs.helicone.ai/features/prompts-legacy/editor' },
      acruxWins: true,
      checkedOn: '2026-09-10',
    },
    mcpServer: {
      value:
        'Helicone\'s local server has 3 tools. Two tools search logged requests and sessions. The third tool sends chat messages that you write through Helicone\'s gateway. That tool cannot send a stored prompt.',
      source: { label: 'helicone-mcp source', href: 'https://github.com/Helicone/helicone/blob/main/helicone-mcp/src/index.ts' },
      acruxWins: true,
      checkedOn: '2026-10-18',
    },
    communityStars: '6,044',
    communityNote:
      'Acquired by Mintlify. Helicone\'s own announcement says "services will remain live... in maintenance mode."',
  },

  mlflow: {
    slug: 'mlflow',
    name: 'MLflow',
    tagline: 'The open-source ML and GenAI platform, with a prompt registry, tracing, evaluation, and its own request-path AI Gateway.',
    postHref: `${BLOG_URL}/acruxcore-vs-mlflow`,
    githubHref: 'https://github.com/mlflow/mlflow',
    checkedOn: '2026-08-08',
    bestFor:
      'Teams already running MLflow for classic ML. In a tool they already operate, they get a prompt registry, tracing, full Jinja2 templating, and a request-path gateway with PII and safety guardrails on each endpoint.',
    limitations:
      'Login, roles and Workspaces are all opt-in and off by default. Its MCP Registry catalogs whole servers rather than individual tools. A single tool has no version history, and nothing runs a tool call.',
    license: {
      value: 'Apache License 2.0, and no part of the repository is under a different license. The same terms as AcruxCore.',
      source: { label: 'LICENSE', href: 'https://github.com/mlflow/mlflow/blob/main/LICENSE' },
      tie: true,
    },
    selfHost: {
      value: 'pip install mlflow, then mlflow server. There is also a docker compose stack backed by Postgres.',
      source: { label: 'GitHub', href: 'https://github.com/mlflow/mlflow' },
      tie: true,
    },
    gateway: {
      value:
        'In the request path, same as AcruxCore. Named endpoints route to more than 60 providers and track usage. Each endpoint can also apply content guardrails for PII and safety. AcruxCore has no content guardrails. MLflow and AcruxCore both enforce a spend cap in the request path.',
      competitorWins: true,
    },
    toolCatalog: {
      value: 'An MCP Registry (Beta) catalogs each external MCP server from that server\'s server.json manifest. The registry stores a whole server, not a single tool, so a single tool has no version history. Nothing here runs or measures a tool call.',
      acruxWins: true,
    },
    teamStructure: {
      value: 'Optional Workspaces (off by default) let teams share one deployment, with roles scoped per workspace. No hard isolation between workspaces.',
      source: { label: 'Workspaces', href: 'https://mlflow.org/docs/latest/self-hosting/workspaces/' },
      checkedOn: '2026-11-02',
    },
    pricingSummary: {
      value: 'MLflow itself is free. Managed MLflow, hosted by Databricks, is priced by usage in DBUs, with no flat price published.',
      source: { label: 'databricks.com/product/managed-mlflow', href: 'https://www.databricks.com/product/managed-mlflow' },
    },
    rbac: {
      value: 'Optional login (--app-name basic-auth), off by default. Roles group READ, USE, EDIT and MANAGE permissions on experiments, models, prompts, scorers and gateway resources; every user starts with READ. With Workspaces on, roles are scoped per workspace.',
      source: { label: 'Role-based access control', href: 'https://mlflow.org/docs/latest/self-hosting/security/role-based-access-control/' },
      checkedOn: '2026-11-02',
    },
    auditLog: { value: 'Not found. Settings has only General, LLM Connections, and Webhooks.', acruxWins: true },
    promptTemplating: {
      value: 'Full Jinja2. {% if %} conditionals and {% for %} loops both render natively. There is also a version diff, plus @production and @staging aliases. MLflow is the one competitor that matches AcruxCore\'s own templates.',
      tie: true,
    },
    promptOptimizer: {
      value:
        'mlflow.genai.optimize_prompts() is experimental. It runs DSPy MIPROv2 or GEPA against a dataset and saves the rewrite as a new prompt version. You start a run from the SDK only, not the UI.',
      source: { label: 'Optimize prompts', href: 'https://mlflow.org/docs/latest/genai/prompt-registry/optimize-prompts/' },
      checkedOn: '2026-09-10',
    },
    mcpServer: {
      value:
        'Experimental. The default genai group has tools for traces, scorers, experiments and runs, and an optional ml group has experiments, runs, models and deployments. There are no Prompt Registry tools.',
      source: { label: 'MLflow MCP server', href: 'https://mlflow.org/docs/latest/genai/mcp/' },
      checkedOn: '2026-11-02',
    },
    communityStars: '27,416',
  },

  laminar: {
    slug: 'laminar',
    name: 'Laminar',
    tagline: 'Observability for agent runs, built in Rust on ClickHouse. Laminar has SQL over spans, LLM-watched Signals, and a CLI made for coding agents.',
    postHref: `${BLOG_URL}/acruxcore-vs-laminar`,
    githubHref: 'https://github.com/lmnr-ai/lmnr',
    checkedOn: '2026-09-06',
    bestFor:
      'Observability for agent runs, with SQL over spans, an LLM-watched Signals engine, and PII redaction. It has a workspace layer above projects, and three roles.',
    limitations:
      'No prompt registry, so there is nothing to version or template. Nothing in the request path. The lite self-host stack switches Signals off and does not create the span index. The smallest community of the competitors here.',
    license: {
      value: 'Apache License 2.0. At the commit we checked, no part of the repository was under a different license. The same terms as AcruxCore.',
      source: { label: 'LICENSE', href: 'https://github.com/lmnr-ai/lmnr/blob/main/LICENSE.md' },
      tie: true,
    },
    selfHost: {
      value: 'docker compose up. Laminar\'s lite stack switches Signals off and does not create the Quickwit span index.',
      source: { label: 'GitHub', href: 'https://github.com/lmnr-ai/lmnr' },
      tie: true,
    },
    gateway: {
      value:
        'Not in the request path, by design. An OpenTelemetry SDK records the call your own client already made, so nothing can route, cap, or cache that call. In exchange, any provider works and there is no proxy to configure.',
      acruxWins: true,
    },
    toolCatalog: {
      value: 'Tool schemas are a JSONB field on a single playground row, and tool calls appear as spans. There is no catalog page, no version history, and nothing here runs a tool.',
      acruxWins: true,
    },
    teamStructure: {
      value: 'Two levels, with a workspace above the project, and three roles. The invite dialog takes an email address only, and you assign a role afterwards.',
      competitorWins: true,
    },
    pricingSummary: {
      value: 'Free tier with 1 GB ingested, 7-day retention, and 1 seat. Paid plans run $30–$150/mo, priced by GB ingested rather than by trace count.',
      source: { label: 'laminar.sh/pricing', href: 'https://laminar.sh/pricing' },
    },
    rbac: { value: 'Three workspace roles: owner, admin, and member. In AcruxCore each person has one role.', competitorWins: true },
    auditLog: { value: 'Not found in any project or workspace settings page we checked.', acruxWins: true },
    promptTemplating: {
      value: 'No prompt registry. A playground holds a single row of messages that you overwrite. It has no versions, aliases, or variables, so there is nothing to template.',
      acruxWins: true,
    },
    promptOptimizer: {
      value: 'Nothing to optimize. With no prompt registry, there is no stored prompt for an optimizer to rewrite or version.',
      acruxWins: true,
      checkedOn: '2026-09-10',
    },
    mcpServer: {
      value:
        'Laminar\'s hosted server has 3 read-only tools. The tools run SQL over traces, fetch the details of one trace, and send a question to an agent inside Laminar. Laminar has no prompt registry, so no tool reads or runs a prompt.',
      source: { label: 'Laminar MCP server', href: 'https://laminar.sh/docs/platform/mcp' },
      acruxWins: true,
      checkedOn: '2026-10-18',
    },
    communityStars: '3,470',
    communityNote:
      'Y Combinator S24. On the date we checked it had 29 contributors and release v0.2.3. It ships a PII redaction toggle and an LLM-watched Signals engine. AcruxCore has no equivalent of either.',
  },

  agenta: {
    slug: 'agenta',
    name: 'Agenta',
    tagline: 'A workspace for building agents by chatting, with a prompt registry, evaluation, and tracing behind it.',
    postHref: `${BLOG_URL}/acruxcore-vs-agenta`,
    githubHref: 'https://github.com/Agenta-AI/agenta',
    checkedOn: '2026-10-18',
    bestFor:
      'Evaluation with people and rules in the loop: 11 built-in evaluator types (plus five regex presets), human and live evaluations, and annotation queues. It has roles at organization, workspace, and project level in the open-source version.',
    limitations:
      'No spend cap, response cache, or virtual keys on its invoke endpoint. You cannot define your own tool and keep versions of it. A Jinja2 variable that appears only inside {% if %} or {% for %} gets no input field in the editor. Audit logs need the Enterprise plan, and the ee/ folder is under a separate license.',
    license: {
      value:
        'MIT, except for the ee/ folder. A separate license covers that folder, so the features in it are not MIT. AcruxCore has no such folder.',
      source: { label: 'LICENSE', href: 'https://github.com/Agenta-AI/agenta/blob/main/LICENSE' },
      acruxWins: true,
    },
    selfHost: {
      value: 'docker compose up, after you copy the example env file. The stack runs 14 containers.',
      source: { label: 'Self-host quick start', href: 'https://agenta.ai/docs/self-host/quick-start' },
      tie: true,
    },
    gateway: {
      value:
        'Partly. The invoke endpoint renders a stored prompt and calls the model, so those calls pass through Agenta. It has no spend cap, response cache, or virtual keys. A call from your own code goes straight to the provider, and the SDK traces it.',
      acruxWins: true,
    },
    toolCatalog: {
      value:
        'A catalog of third-party actions from Composio, which Agenta runs for its agents once you set a Composio API key. You cannot add your own tool to it or keep versions of a tool. A prompt carries its own tool schemas.',
      acruxWins: true,
    },
    teamStructure: {
      value: 'Three levels: organization, workspace, and project. Members are managed on the organization.',
      competitorWins: true,
    },
    pricingSummary: {
      value: 'The open-source version is free. Agenta Cloud costs $0, $29, or $299 a month, and Enterprise is priced on request.',
      source: { label: 'agenta.ai/pricing', href: 'https://agenta.ai/pricing' },
    },
    rbac: {
      value:
        'Six roles in the open-source version: owner, admin, developer, editor, annotator, and viewer. On Agenta Cloud, roles come with the $299/mo Business plan.',
      source: { label: 'Roles and permissions', href: 'https://agenta.ai/docs/administration/access-control/rbac' },
      competitorWins: true,
    },
    auditLog: {
      value: 'Audit logs are on the Enterprise plan, for Agenta Cloud and for self-hosting.',
      source: { label: 'agenta.ai/pricing', href: 'https://agenta.ai/pricing' },
      acruxWins: true,
    },
    promptTemplating: {
      value:
        'Full Jinja2 when you choose the Jinja2 syntax. A variable that appeared only inside {% if %} or {% for %} got no input field in the editor. The invoke endpoint rejected that variable until we edited the input list by hand.',
      acruxWins: true,
    },
    promptOptimizer: {
      value:
        'No optimizer that rewrites a prompt from evaluation results. Agenta\'s agents can update their own instructions from feedback in chat.',
      acruxWins: true,
    },
    mcpServer: {
      value:
        'Agenta\'s MCP server has 3 tools, and all of them search Agenta\'s documentation. No tool reads or changes your prompts, traces or evaluations.',
      source: { label: 'Agenta MCP server', href: 'https://agenta.ai/docs/misc/mcp-server' },
      acruxWins: true,
      checkedOn: '2026-10-18',
    },
    communityStars: '4,843',
  },
};

/** The competitors as an ordered array — matches the order they appear on `/compare`. */
export const COMPARISON_LIST: Comparison[] = [
  COMPARISONS.langfuse,
  COMPARISONS.phoenix,
  COMPARISONS.opik,
  COMPARISONS.helicone,
  COMPARISONS.mlflow,
  COMPARISONS.laminar,
  COMPARISONS.agenta,
];

/**
 * The eight platforms on `/best-open-source-llmops-platforms`, ordered by the
 * size of the project around them — largest community first, AcruxCore last.
 *
 * Community size rather than a scoreline, because the page's own answer is that
 * there is no single best one, and ordering by anything we scored would
 * contradict that in the first thing a reader sees. It also puts us at the
 * bottom of our own list, which is where the star counts actually put us.
 */
export const PLATFORMS_BY_COMMUNITY: Comparison[] = [...COMPARISON_LIST].sort(
  (a, b) => Number(b.communityStars.replace(/,/g, '')) - Number(a.communityStars.replace(/,/g, '')),
);

/**
 * The `ItemList` structured-data block for `/best-open-source-llmops-platforms`.
 *
 * Marked explicitly as an **unordered** list. A schema.org `ItemList` is read as
 * a ranking by default, and a ranking is the one thing this page says it will
 * not give: the visible order is community size, and claiming it as a verdict in
 * machine-readable form while the prose says otherwise is the kind of
 * disagreement only a crawler would ever see.
 *
 * @returns A JSON string suitable for an `application/ld+json` script tag.
 */
export function platformListStructuredData(): string {
  const entries = [
    ...PLATFORMS_BY_COMMUNITY.map((c) => ({
      name: c.name,
      url: c.githubHref,
      description: c.bestFor,
    })),
    { name: ACRUX_CORE.name, url: GITHUB_URL, description: ACRUX_CORE.bestFor },
  ];

  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Open-source LLMOps platforms compared',
    itemListOrder: 'https://schema.org/ItemListUnordered',
    numberOfItems: entries.length,
    itemListElement: entries.map((entry, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      item: {
        '@type': 'SoftwareApplication',
        name: entry.name,
        url: entry.url,
        applicationCategory: 'DeveloperApplication',
        applicationSubCategory: 'LLMOps platform',
        operatingSystem: 'Web',
        description: entry.description,
      },
    })),
  });
}
