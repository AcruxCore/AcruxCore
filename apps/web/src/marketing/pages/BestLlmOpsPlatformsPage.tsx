import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { MarketingShell, ContentHeader } from '../MarketingShell';
import { cssToStyle, Eyebrow, Ic, DOCS_URL, GITHUB_URL, ExternalArrow } from '../marketing-chrome';
import { ACRUX_CORE, PLATFORMS_BY_COMMUNITY, type Comparison } from '../comparisons';

/**
 * `/best-open-source-llmops-platforms` — a category page answering the query
 * "which open-source LLMOps platform should I use", for the seven platforms we
 * have actually run.
 *
 * **Why this exists next to `/compare`.** The matrix is built to be checked: it
 * puts AcruxCore beside each competitor row by row and expects a reader who has
 * already shortlisted us. Someone typing "best open-source LLMOps platform" has
 * not, and a page framed as "us versus them" is the wrong shape for that
 * question — an answer engine quoting it would be quoting a vendor comparing
 * itself. This page answers the category question directly instead, orders the
 * platforms by community size rather than by anything we scored, and puts
 * AcruxCore last. The two link to each other and target different queries; the
 * matrix stays the place to check a specific fact.
 *
 * **Every claim here comes from `comparisons.tsx`,** which records the source
 * and the date each fact was checked against the competitor's own pages. The
 * `bestFor` and `limitations` sentences are restatements of rows in that file,
 * never new assertions — writing a competitor's gap from memory is how earlier
 * posts came to claim we lacked budgets and rate limits we had shipped two
 * phases before.
 *
 * @returns The rendered category page.
 */
export function BestLlmOpsPlatformsPage(): ReactNode {
  return (
    <MarketingShell>
      <ContentHeader
        eyebrow="Comparison"
        title="7 best open-source LLMOps and observability platforms in 2026"
        lead="Find the right platform to manage prompts and tools, trace LLM calls, and improve response quality. Compare seven open-source and source-available tools, with hands-on findings, clear trade-offs, and licensing details."
        docTitle="Best open-source LLMOps platforms in 2026 — AcruxCore"
      />

      <section
        style={cssToStyle(
          'margin:0 0 clamp(36px,5vw,56px);padding:22px 24px;border:1px solid var(--line-soft);border-left:3px solid var(--accent);border-radius:14px;',
        )}
      >
        <h2 style={cssToStyle('font-size:17px;font-weight:650;letter-spacing:-.01em;margin:0 0 10px;')}>
          The short answer
        </h2>
        <p className="acx-prose" style={cssToStyle('margin:0 0 12px;')}>
          Choose an LLMOps platform based on what you need to control and improve. LLM gateways sit <strong>in the request path</strong> to control calls before they reach a provider.
          Observability tools{' '}
          <strong>record calls made by your existing client</strong> so you can trace behavior and
          evaluate responses. Use both when you need request controls and visibility into results.
        </p>
        <p className="acx-prose" style={cssToStyle('margin:0;')}>
          AcruxCore is the only platform in this comparison with a{' '}
          <strong>versioned tool catalog whose calls the gateway executes</strong>. Each tool is a
          catalog entry with its own version history, so you can add, change, or roll back a tool
          without deploying application code. Shortlist it if you want that alongside prompt
          versioning and feedback-driven prompt optimization in one workflow. It is also the
          only platform here whose <strong>audit trail needs no paid plan</strong>: every
          change anyone makes is recorded with their name, on every plan and when
          self-hosted. For the largest
          community in this comparison, consider <strong>Langfuse</strong>. Already using{' '}
          <strong>MLflow</strong>? Its prompt registry, tracing, and gateway may meet your needs. For
          evaluation, explore <strong>Opik</strong>; for agent tracing, explore <strong>Laminar</strong>.
          AcruxCore has a smaller community and a flat team structure; check its access controls if
          you need an organization layer or multiple roles per member.
        </p>
      </section>

      <section style={cssToStyle('margin:0 0 clamp(36px,5vw,56px);')}>
        <Eyebrow>How to choose</Eyebrow>
        <h2
          style={cssToStyle(
            'font-size:clamp(22px,2.6vw,28px);line-height:1.15;letter-spacing:-.02em;font-weight:700;margin:12px 0 16px;',
          )}
        >
          How to choose an LLMOps platform: seven key questions
        </h2>
        <div className="acx-prose">
          {DECISION_POINTS.map((point) => (
            <div
              key={point.question}
              style={cssToStyle('padding:16px 0;border-bottom:1px solid var(--line-soft);')}
            >
              <h3 style={cssToStyle('font-size:15.5px;font-weight:650;margin:0 0 8px;line-height:1.4;')}>
                {point.question}
              </h3>
              <p style={cssToStyle('margin:0;')}>{point.answer}</p>
            </div>
          ))}
        </div>
      </section>

      <section style={cssToStyle('margin:0 0 clamp(36px,5vw,56px);')}>
        <Eyebrow>The platforms</Eyebrow>
        <h2
          style={cssToStyle(
            'font-size:clamp(22px,2.6vw,28px);line-height:1.15;letter-spacing:-.02em;font-weight:700;margin:12px 0 10px;',
          )}
        >
          Seven LLMOps platforms compared
        </h2>
        <p className="acx-prose" style={cssToStyle('margin:0 0 24px;color:var(--muted);')}>
          Competitors are listed by community size, followed by AcruxCore. The order does not rank
          performance. Each entry includes a verification date; the comparison matrix links to
          the platform&rsquo;s own documentation.
        </p>

        {PLATFORMS_BY_COMMUNITY.map((platform) => (
          <PlatformCard key={platform.slug} platform={platform} />
        ))}

        <AcruxCoreCard />
      </section>

      <section style={cssToStyle('margin:0 0 clamp(36px,5vw,56px);')}>
        <Eyebrow>Methodology</Eyebrow>
        <h2
          style={cssToStyle(
            'font-size:clamp(22px,2.6vw,28px);line-height:1.15;letter-spacing:-.02em;font-weight:700;margin:12px 0 16px;',
          )}
        >
          How we tested the platforms
        </h2>
        <div className="acx-prose">
          <p style={cssToStyle('margin:0 0 12px;')}>
            We tested the same example prompt across all seven platforms, including AcruxCore, and
            self-hosted each where supported. The linked reviews include screenshots from these
            hands-on tests.
          </p>
          <p style={cssToStyle('margin:0 0 12px;')}>
            Findings reflect the versions and dates tested. A feature marked as absent was not found
            in our tests or the sources linked in the{' '}
            <Link to="/compare">comparison matrix</Link>. Features can change, so check the date
            and source before making a decision.
          </p>
          <p style={cssToStyle('margin:0 0 12px;')}>
            In our benchmark, AcruxCore&rsquo;s gateway added about 42 ms compared with calling
            OpenAI directly, with a confidence interval of +17 ms to +81 ms. Reproducible scripts
            are available in the repository. The{' '}
            <a href={`${DOCS_URL}/blog/llm-gateway-overhead`} target="_blank" rel="noreferrer">
              gateway latency benchmark
            </a>{' '}
            includes the full distribution and tail latency results.
          </p>
          <p style={cssToStyle('margin:0;')}>
            This comparison is published by AcruxCore. We highlight competitor strengths and link
            claims to sources so you can judge the fit for your team.
          </p>
        </div>
      </section>

      <section
        style={cssToStyle(
          'margin:0 0 clamp(48px,7vw,80px);padding:22px 24px;border:1px solid var(--line-soft);border-radius:14px;',
        )}
      >
        <h2 style={cssToStyle('font-size:17px;font-weight:650;letter-spacing:-.01em;margin:0 0 8px;')}>
          Compare features. Find your fit.
        </h2>
        <p className="acx-prose" style={cssToStyle('margin:0;')}>
          Check the <Link to="/compare">comparison matrix</Link> for features, trade-offs, and
          sources. Explore the{' '}
          <a href={`${DOCS_URL}/blog/hands-on-llm-ops-comparison`} target="_blank" rel="noreferrer">
            hands-on review of nine platforms
          </a>{' '}
          for screenshots and test details. Considering AcruxCore? Read the <Link to="/faq">FAQ</Link>
          to see how it fits your workflow and when to consider an alternative.
        </p>
      </section>
    </MarketingShell>
  );
}

/** The distinctions that decide the answer, rather than the ones that fill a feature table. */
export const DECISION_POINTS: { question: string; answer: string }[] = [
  {
    question: 'Do you need an LLM gateway, observability, or both?',
    answer:
      'An LLM gateway controls requests before they reach a provider. An observability tool records traces so you can inspect what happened. AcruxCore, MLflow’s gateway, and Helicone sit in the request path, where routing, caching, budget checks, and provider-key management can happen. Check support for each control. Langfuse, Phoenix, Opik, and Laminar collect traces without acting as gateways, so you can add visibility without introducing a new proxy.',
  },
  {
    question: 'Can you add and version the tools a model calls without deploying code?',
    answer:
      'This is the one question where AcruxCore stood alone against all six. In AcruxCore a tool is a catalog entry with its own version history, and the gateway executes the call, so the definition the model reads and the call that ran are the same record. You can add a tool, change it, or roll it back without deploying application code. No other platform in this comparison had both a versioned catalog and execution. Langfuse saved playground tool schemas without versioning or execution. Laminar stored schemas within playground entries. Phoenix, Opik, and Helicone had no tool catalog. MLflow cataloged MCP servers rather than individual tools, without per-tool history or execution in the workflow tested. If your tools live in your own code and you want them to stay there, this question will not decide it for you.',
  },
  {
    question: 'Can you update prompts without deploying code?',
    answer:
      'A versioned prompt registry lets you change prompts without redeploying code. Look for aliases, version comparisons, and the templating features you need. In our tests, AcruxCore and MLflow supported native Jinja2 conditionals and loops. Langfuse, Phoenix, Opik, and Helicone supported variable substitution but left branching logic to application code. Laminar’s playground had no prompt versions, aliases, or variables. Check the dated findings for current support.',
  },
  {
    question: 'What team structure and permissions do you need?',
    answer:
      'Match access controls to how your team shares projects. In the self-hosted versions we tested, AcruxCore offered members, invites, and roles in a flat team structure. Langfuse and Laminar added an organization or workspace above projects. Laminar offered three workspace roles; AcruxCore offered one. Phoenix, Opik, and MLflow had no team, member, or invite management; MLflow also had no login screen. Helicone used one organization tier with no role selector in its invite dialog. For separate business units, compare the hierarchy and permissions in Langfuse and Laminar.',
  },
  {
    question: 'Can you see who changed what, and when — without paying for it?',
    answer:
      'An audit log answers this, and it is the question where paid tiers show up. Ask it about the whole account rather than about prompts alone: a compliance review asks who revoked an API key or changed a member\u2019s role as often as it asks who edited a prompt. In AcruxCore every prompt and every tool carries its own trail. Owners and admins also get one team-wide trail in the dashboard, covering 34 event types across seven areas. Those areas are prompts, tools, members and invites, API keys, gateway credentials and budgets, secrets, and trace settings. Filter the trail by area, by one event, or by the person, including someone who has since left the team. It is populated by default on every plan and when self-hosted, with no upgrade. Langfuse has an audit log in its UI, limited to its top paid plan for hosted and self-hosted use. For Phoenix, Opik, Helicone, MLflow and Laminar we found no audit log in the settings pages we checked. Export and a retention window are the two things AcruxCore\u2019s trail does not have yet.',
  },
  {
    question: 'How do you turn feedback into better prompts?',
    answer:
      'Feedback only helps if it leads to a prompt change you can test. AcruxCore keeps end-user feedback and developer notes apart, and either one can become a dataset of test cases. Experiments run those cases against different prompt versions and models so you can compare the results. Automated rules score live traffic as it arrives. The optimizer proposes rewrites and tests them on the same cases as your production prompt. Promoting a better rewrite creates a numbered version and moves the alias, so your app picks it up without a deployment. Opik also focuses on evaluation. Compare how many of these steps each platform handles for you and how many stay in your own code.',
  },
  {
    question: 'What does the license include?',
    answer:
      'Check the license and which features require payment. Our recorded comparison lists Opik, Helicone, MLflow, Laminar, and AcruxCore as Apache 2.0, with no gated directory. Langfuse has an MIT-licensed core and an enterprise-licensed directory; its audit log was limited to the top paid plan for hosted and self-hosted use. Phoenix uses Elastic License 2.0: it is source-available, rather than OSI-approved open source. Check the dated licensing sources for terms that apply to your deployment.',
  },
];

/**
 * Which of the five facts a card row is, which decides its icon and colour.
 *
 * Deliberately named after the fact rather than after a sentiment — `best` and
 * `limits`, not `good` and `bad`. Every card on this page except ours belongs to a
 * competitor, and a row that renders as a verdict turns a sourced, dated fact into
 * us marking someone else down. The colour is there to let the eye find the row,
 * not to score it.
 */
type FactKind = 'best' | 'limits' | 'unique' | 'license' | 'community';

/**
 * Each fact's colour token and icon. All five come from `tokens.css`, so they
 * follow the light/dark theme; none is an emoji, which could not be recoloured and
 * would render as a different picture on every operating system.
 */
const FACT_KINDS: Record<FactKind, { color: string; icon: ReactNode }> = {
  best: {
    color: 'var(--ok)',
    icon: (
      <Ic size={13} sw={2.6}>
        <path d="M20 6 9 17l-5-5" />
      </Ic>
    ),
  },
  limits: {
    color: 'var(--warn)',
    icon: (
      <Ic size={13} sw={2.1}>
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
      </Ic>
    ),
  },
  unique: {
    color: 'var(--accent)',
    icon: (
      <Ic size={13} sw={1.9}>
        <path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
      </Ic>
    ),
  },
  license: {
    color: 'var(--faint)',
    icon: (
      <Ic size={13} sw={1.9}>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6" />
        <path d="M9 13h6" />
        <path d="M9 17h4" />
      </Ic>
    ),
  },
  community: {
    color: 'var(--faint)',
    icon: (
      <Ic size={13} sw={1.9}>
        <path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9.5" cy="7" r="3.5" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </Ic>
    ),
  },
};

/**
 * One labelled fact inside a platform card, in its own colour with an icon in the
 * gutter, so "best for" and "limitations" can be told apart without being read.
 *
 * The icon is `aria-hidden`: the label beside it already says which fact this is,
 * and a screen reader announcing a shape as well would only repeat it.
 */
function CardFact({ label, kind, children }: { label: string; kind: FactKind; children: ReactNode }): ReactNode {
  const { color, icon } = FACT_KINDS[kind];
  return (
    <div style={cssToStyle('display:flex;align-items:flex-start;gap:10px;margin-bottom:12px;')}>
      <span
        aria-hidden="true"
        style={cssToStyle(
          `display:inline-flex;align-items:center;justify-content:center;flex:none;width:21px;height:21px;margin-top:1px;border-radius:6px;color:${color};background:color-mix(in oklch, ${color} 15%, transparent);`,
        )}
      >
        {icon}
      </span>
      <span style={cssToStyle('display:flex;flex-direction:column;gap:3px;min-width:0;')}>
        <span
          style={cssToStyle(
            `font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${color};`,
          )}
        >
          {label}
        </span>
        <span style={cssToStyle('font-size:13.5px;line-height:1.55;color:var(--muted);text-wrap:pretty;')}>
          {children}
        </span>
      </span>
    </div>
  );
}

const cardStyle =
  'padding:22px 24px;border:1px solid var(--line-soft);border-radius:14px;margin-bottom:16px;';
const cardTitleStyle =
  'font-size:19px;font-weight:700;letter-spacing:-.015em;margin:0;line-height:1.3;';

/** One competitor's card: what it is, what it is best at, and what it costs you. */
function PlatformCard({ platform }: { platform: Comparison }): ReactNode {
  return (
    <article style={cssToStyle(cardStyle)}>
      <div
        style={cssToStyle(
          'display:flex;flex-wrap:wrap;align-items:baseline;gap:10px;justify-content:space-between;margin-bottom:6px;',
        )}
      >
        <h3 style={cssToStyle(cardTitleStyle)}>{platform.name}</h3>
        <span style={cssToStyle('font-size:12.5px;color:var(--faint);')}>
          {platform.communityStars} GitHub stars · checked {platform.checkedOn}
        </span>
      </div>
      <p
        style={cssToStyle(
          'font-size:14px;line-height:1.55;color:var(--muted);margin:0 0 16px;text-wrap:pretty;',
        )}
      >
        {platform.tagline}
      </p>

      <CardFact label="Best for" kind="best">{platform.bestFor}</CardFact>
      <CardFact label="Limitations" kind="limits">{platform.limitations}</CardFact>
      <CardFact label="License" kind="license">{platform.license.value}</CardFact>
      {platform.communityNote ? <CardFact label="Community notes" kind="community">{platform.communityNote}</CardFact> : null}

      <div style={cssToStyle('display:flex;flex-wrap:wrap;gap:16px;margin-top:14px;')}>
        <a
          href={platform.postHref}
          target="_blank"
          rel="noreferrer"
          style={cssToStyle('font-size:13px;color:var(--accent);text-decoration:none;font-weight:550;')}
        >
          Read the hands-on review
          <ExternalArrow />
        </a>
        <a
          href={platform.githubHref}
          target="_blank"
          rel="noreferrer"
          style={cssToStyle('font-size:13px;color:var(--muted);text-decoration:none;')}
        >
          View on GitHub
          <ExternalArrow />
        </a>
      </div>
    </article>
  );
}

/**
 * AcruxCore's own card, in the same shape as every other.
 *
 * Deliberately last and deliberately not restyled: on a page whose answer is
 * "it depends", a card styled differently from the other six would undo the
 * argument the page just made. The one extra fact it carries, "Unique in this
 * comparison", is the tool-catalog row, because it is the only row AcruxCore
 * wins against all six in `comparisons.tsx` (owner instruction, 2026-09-09).
 * `comparisons.test.ts` fails the moment a competitor's row stops saying so.
 */
const UNIQUE_IN_COMPARISON =
  'A versioned tool catalog whose calls the gateway executes. Every other platform here either has no tool catalog, stores an unversioned schema that nothing runs, or catalogs whole MCP servers instead of tools.';
function AcruxCoreCard(): ReactNode {
  return (
    <article style={cssToStyle(cardStyle)}>
      <div
        style={cssToStyle(
          'display:flex;flex-wrap:wrap;align-items:baseline;gap:10px;justify-content:space-between;margin-bottom:6px;',
        )}
      >
        <h3 style={cssToStyle(cardTitleStyle)}>{ACRUX_CORE.name}</h3>
        <span style={cssToStyle('font-size:12.5px;color:var(--faint);')}>
          Public mirror launched 2026-08-03 · checked {ACRUX_CORE.checkedOn}
        </span>
      </div>
      <p
        style={cssToStyle(
          'font-size:14px;line-height:1.55;color:var(--muted);margin:0 0 16px;text-wrap:pretty;',
        )}
      >
        {ACRUX_CORE.tagline}
      </p>

      <CardFact label="Unique in this comparison" kind="unique">{UNIQUE_IN_COMPARISON}</CardFact>
      <CardFact label="Best for" kind="best">{ACRUX_CORE.bestFor}</CardFact>
      <CardFact label="Limitations" kind="limits">{ACRUX_CORE.limitations}</CardFact>
      <CardFact label="License" kind="license">{ACRUX_CORE.license.value}</CardFact>

      <div style={cssToStyle('display:flex;flex-wrap:wrap;gap:16px;margin-top:14px;')}>
        <Link
          to="/faq"
          style={cssToStyle('font-size:13px;color:var(--accent);text-decoration:none;font-weight:550;')}
        >
          Is AcruxCore right for your team?
        </Link>
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noreferrer"
          style={cssToStyle('font-size:13px;color:var(--muted);text-decoration:none;')}
        >
          View on GitHub
          <ExternalArrow />
        </a>
      </div>
    </article>
  );
}
