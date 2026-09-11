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
        lead="We compared seven open-source and source-available platforms for prompt management, LLM gateways, tracing, and evaluation. We self-hosted each one and ran the same prompt through it. This page shows how each one handles prompts, tools, teams, audit logs, and licensing."
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
          Every platform here is an LLM gateway, an observability tool, or both. A gateway sits{' '}
          <strong>in the request path</strong>, so it can route, cache, and cap spending before a
          call reaches the provider. An observability tool{' '}
          <strong>records the calls your own client already makes</strong>, so you can trace and
          evaluate them afterwards. AcruxCore, MLflow, and Helicone are both. Langfuse, Phoenix,
          Opik, and Laminar only observe.
        </p>
        <p className="acx-prose" style={cssToStyle('margin:0;')}>
          AcruxCore is the only platform in this comparison where you{' '}
          <strong>define the tools a model can call, version them, and let the gateway run them</strong>.
          Each tool has its own version history, so you can add, change, or roll back a tool
          without deploying application code. AcruxCore is also the only platform here whose{' '}
          <strong>audit trail needs no paid plan</strong>. Hosted or self-hosted, every change
          anyone makes is recorded with their name. <strong>Langfuse</strong> has the
          largest community and an organization layer above projects. <strong>MLflow</strong>{' '}
          has a prompt registry, tracing, and a gateway, and many teams already run it for
          classic ML. <strong>Opik</strong> is built around datasets, experiments, and online
          scoring rules. <strong>Laminar</strong> traces agent runs, with SQL over spans and
          three workspace roles. AcruxCore has the smallest community here, a single team layer with
          no organization above it, and one role per member.
        </p>
      </section>

      <section style={cssToStyle('margin:0 0 clamp(36px,5vw,56px);')}>
        <Eyebrow>How to choose</Eyebrow>
        <h2
          style={cssToStyle(
            'font-size:clamp(22px,2.6vw,28px);line-height:1.15;letter-spacing:-.02em;font-weight:700;margin:12px 0 16px;',
          )}
        >
          How to choose: seven questions
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
          Competitors are listed by community size, with AcruxCore last. The order is not a
          ranking. Each card shows the date we checked it. The comparison matrix links every claim
          to the platform&rsquo;s own documentation.
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
            A feature marked as absent means we did not find it. We looked in the version we ran
            and in the sources linked from the <Link to="/compare">comparison matrix</Link>. Platforms change,
            so each finding carries the date we checked it.
          </p>
          <p style={cssToStyle('margin:0 0 12px;')}>
            AcruxCore&rsquo;s gateway added about 42 ms per call compared with calling OpenAI
            directly. The confidence interval is +17 ms to +81 ms. The{' '}
            <a href={`${DOCS_URL}/blog/llm-gateway-overhead`} target="_blank" rel="noreferrer">
              gateway latency benchmark
            </a>{' '}
            has the full distribution, the tail latencies, and the scripts to rerun it.
          </p>
          <p style={cssToStyle('margin:0;')}>
            AcruxCore publishes this comparison. Every claim about a competitor links to that
            competitor&rsquo;s own documentation, with the date we checked it.
          </p>
        </div>
      </section>

      <section
        style={cssToStyle(
          'margin:0 0 clamp(48px,7vw,80px);padding:22px 24px;border:1px solid var(--line-soft);border-radius:14px;',
        )}
      >
        <h2 style={cssToStyle('font-size:17px;font-weight:650;letter-spacing:-.01em;margin:0 0 8px;')}>
          Where to look next
        </h2>
        <p className="acx-prose" style={cssToStyle('margin:0;')}>
          The <Link to="/compare">comparison matrix</Link> puts every platform side by side, row
          by row, with a source for each cell. The{' '}
          <a href={`${DOCS_URL}/blog/hands-on-llm-ops-comparison`} target="_blank" rel="noreferrer">
            hands-on review of nine platforms
          </a>{' '}
          has the screenshots from each test. The <Link to="/faq">FAQ</Link> says which teams
          AcruxCore fits and which should pick something else.
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
      'An LLM gateway controls requests before they reach a provider. An observability tool records traces so you can inspect what happened. AcruxCore, MLflow’s gateway, and Helicone sit in the request path and act as a proxy. There they can route a call, cache it, check a budget, and hold the provider key. Langfuse, Phoenix, Opik, and Laminar collect traces without sitting in the request path, so they add no proxy.',
  },
  {
    question: 'Can you add and version the tools a model calls without deploying code?',
    answer:
      'In AcruxCore you define a tool once, keep every version of it, and the gateway runs it when the model calls it. So the tool the model sees and the code that ran are always the same version. You can add a tool, change it, or roll it back without deploying application code. No other platform in this comparison keeps versions of a tool and also runs it. Langfuse saves a tool schema in its playground, but does not version it or run it. Laminar stores tool schemas inside playground entries. Phoenix, Opik, and Helicone have no tool catalog. MLflow catalogs whole MCP servers rather than individual tools. In the MLflow workflow we tested, a single tool had no version history, and nothing ran the call.',
  },
  {
    question: 'Can you update prompts without deploying code?',
    answer:
      'Every platform here except Laminar has a prompt registry, so you can change a prompt without redeploying code. The registries differ in templating. AcruxCore and MLflow support Jinja2 conditionals and loops, so a prompt can branch on its inputs. Langfuse, Phoenix, Opik, and Helicone substitute variables only, and any branching logic stays in your application code. Laminar’s playground had no prompt versions, aliases, or variables.',
  },
  {
    question: 'What team structure and permissions do you need?',
    answer:
      'AcruxCore has members, invites, and roles inside a single team, with nothing above it, and one role per member. In the self-hosted versions we tested, Langfuse and Laminar had an organization or workspace layer above projects. Laminar had three workspace roles. Phoenix, Opik, and MLflow had no team, member, or invite management, and MLflow had no login screen. Helicone had one organization tier and no role field in its invite dialog.',
  },
  {
    question: 'Can you see who changed what and when, and does it cost extra?',
    answer:
      'Yes, in AcruxCore, and it costs nothing extra. Every prompt and every tool keeps its own change history. Owners and admins also see one audit trail for the whole team in the dashboard. That trail records 34 event types across seven areas: prompts, tools, members and invites, API keys, gateway credentials and budgets, secrets, and trace settings. You can filter the trail by area, by one event type, or by person. Entries stay in the trail after the person who made them leaves the team, so you can still filter by that person. The trail is on by default, whether hosted or self-hosted, with nothing to pay and nothing to switch on. Of the other six platforms, Langfuse is the only one where we found an audit log, and that log needs the top paid plan even if you self-host. For Phoenix, Opik, Helicone, MLflow and Laminar we found no activity audit option in the platform.',
  },
  {
    question: 'How do you turn feedback into better prompts?',
    answer:
      'AcruxCore labels end-user feedback and developer notes separately, and both can be added to a dataset of test cases. Experiments run those cases against different prompt versions and models so you can compare the results. Automated rules score live traffic as it arrives. The optimizer uses a large language model to propose rewrites and tests them on the same cases as your production prompt. You can edit the prompt that instructs the optimizer, so the rewrites follow your own rules for a good prompt. Promoting a better rewrite creates a numbered version and moves the alias, so your app picks it up without a deployment. Opik and MLflow also have optimizers, with more algorithms than AcruxCore. Both run from the SDK only and cannot be started from the UI. Langfuse, Phoenix, and Helicone have no optimizer in the product, and Laminar has no stored prompt to optimize.',
  },
  {
    question: 'What does the license include?',
    answer:
      'Opik, Helicone, MLflow, Laminar, and AcruxCore are Apache 2.0, with no folder under a separate paid license. Langfuse has an MIT-licensed core and one folder under an enterprise license. Its audit log needs the top paid plan even if you self-host. Phoenix uses Elastic License 2.0, which is source-available rather than OSI-approved open source.',
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
  'Tools are defined and versioned in AcruxCore, and the gateway runs them when the model calls them. Every other platform here either has no tool catalog, stores a tool schema that nothing runs, or catalogs whole MCP servers instead of tools.';
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
          Which teams AcruxCore fits
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
