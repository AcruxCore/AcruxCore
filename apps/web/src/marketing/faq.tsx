import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { DOCS_URL, GITHUB_URL } from './marketing-chrome';

/**
 * One piece of an answer: either plain prose, or a link.
 *
 * Answers are stored as runs rather than as JSX because each one has to be
 * emitted twice — once as the rendered page, and once as the plain text inside
 * the `FAQPage` JSON-LD block, which may not contain markup. Holding a second,
 * hand-written plain-text copy of every answer would work until the first time
 * someone edited one and not the other, and a structured-data block that
 * disagrees with the visible page is the kind of drift nothing on the page
 * would show. One source, two renderers, no copy to forget.
 */
export type AnswerRun =
  | string
  | {
      text: string;
      /** Internal route, rendered as a router `<Link>`. */
      to?: string;
      /** External URL, rendered as a new-tab anchor. */
      href?: string;
    };

/**
 * One paragraph of an answer, as runs. See {@link AnswerRun}.
 */
export type AnswerParagraph = AnswerRun[];

/** One question and its answer. */
export interface FaqItem {
  /** Phrased the way a reader would actually ask it, not as a product feature. */
  question: string;
  /**
   * The answer, one entry per paragraph.
   *
   * Always a list of paragraphs, even when there is only one, so that a long
   * answer can be broken up without changing the shape. A single block of ten
   * lines is the version of this page nobody finishes reading, and the answers
   * that matter most here are the longest ones.
   */
  answer: AnswerParagraph[];
}

/** A titled group of questions. */
export interface FaqGroup {
  /** Anchor id, used for deep links like `/faq#comparisons`. */
  id: string;
  /** Heading shown above the group. */
  title: string;
  items: FaqItem[];
}

/**
 * Flattens an answer's paragraphs into the plain text the JSON-LD block carries.
 *
 * Paragraphs are joined with a space rather than a newline, because an
 * `acceptedAnswer.text` is a single plain string and a literal newline inside
 * it buys nothing.
 */
export function answerToPlainText(answer: readonly AnswerParagraph[]): string {
  return answer
    .map((paragraph) =>
      paragraph.map((run) => (typeof run === 'string' ? run : run.text)).join(''),
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const COMPARE_POST = `${DOCS_URL}/blog/hands-on-llm-ops-comparison`;
const LATENCY_POST = `${DOCS_URL}/blog/llm-gateway-overhead`;
const AUDIT_API = `${DOCS_URL}/api-reference/audit`;
const AUDIT_GUIDE = `${DOCS_URL}/docs/guides/read-the-team-audit-trail`;
const CORE_CONCEPTS = `${DOCS_URL}/docs/getting-started/core-concepts`;

/**
 * Every question on `/faq`, grouped.
 *
 * **The register is deliberate.** The obvious version of this page answers
 * "why are you better than everyone else", and it is the least persuasive page
 * a product can publish: the reader knows the author also picked the questions.
 * The comparison work this page summarises is already built the other way —
 * `comparisons.tsx` marks a row the competitor wins as plainly as one we win,
 * and the per-competitor "Our edge" badges were removed for the same reason. So
 * the differentiating answers here sit next to the ones that concede a point,
 * and every claim that could be argued with links to the evidence rather than
 * restating itself louder.
 *
 * **Every factual claim traces to something checked.** Licence terms, hierarchy,
 * guardrails and star counts come from `comparisons.tsx`, which records the date
 * each fact was checked against the competitor's own pages; the latency figures
 * come from the published benchmark and its committed script. Nothing here
 * asserts a capability gap that was not looked up — writing a gap from memory is
 * how earlier posts came to claim we lacked budgets and rate limits we had
 * shipped two phases before.
 */
export const FAQ_GROUPS: FaqGroup[] = [
  {
    id: 'basics',
    title: 'AcruxCore basics',
    items: [
      {
        question: 'What is AcruxCore?',
        answer: [
          [
            'AcruxCore is an LLMOps platform for managing applications built on large language models. It brings prompt versioning, an OpenAI-compatible LLM gateway, tracing, a tool catalog, and evaluation into one place. Use the gateway to capture model requests as they pass through, or connect tracing directly.',
          ],
          [
            'AcruxCore is licensed under ',
            { text: 'Apache 2.0', href: `${GITHUB_URL}/blob/main/LICENSE` },
            ', so you can self-host the platform.',
          ],
        ],
      },
      {
        question: 'What problems does AcruxCore solve?',
        answer: [
          [
            'AcruxCore helps teams update prompts without redeploying application code and understand what happens during model calls. Prompt versioning gives teams a shared place to manage and improve prompts.',
          ],
          [
            'The gateway captures requests as they pass through it. This gives you visibility into model calls without relying only on traces reported by your application.',
          ],
          [
            'The tool catalog stores tool definitions next to your prompts. Give a prompt access to a tool and the model can call it, so a plain prompt becomes an agent without extra glue code. See the ',
            { text: 'connect a tool to a prompt guide', href: `${DOCS_URL}/docs/guides/connect-a-tool-to-a-prompt` },
            '.',
          ],
        ],
      },
      {
        question: 'What is the difference between a trace and an audit event?',
        answer: [
          [
            'A trace records traffic your application sent: one model call, its prompt, its tokens, its latency and its cost. An audit event records a change a person made, and names them.',
          ],
          [
            'The two answer different questions. "Why did this answer come out wrong?" is a trace. "Who changed the prompt on Tuesday, and what did it say before?" is an audit event. A completion never appears in the audit trail, and a role change never appears in a trace.',
          ],
          [
            'AcruxCore keeps both, and both are on by default. See ',
            { text: 'core concepts', href: CORE_CONCEPTS },
            ' for how traces, prompts, versions and audit events relate.',
          ],
        ],
      },
      {
        question: 'Can I use AcruxCore without the gateway?',
        answer: [
          [
            'Yes. Call your model provider directly with your own API key while using AcruxCore for prompt versioning and tracing. Follow the ',
            { text: 'gateway-free RAG tutorial', href: `${DOCS_URL}/docs/tutorials/build-a-rag-agent-without-the-gateway` },
            ' for a complete example.',
          ],
          [
            'If your app already uses OpenTelemetry, it can ',
            { text: 'send traces to the OTLP endpoint', href: `${DOCS_URL}/docs/guides/send-otel-traces-with-the-sdk-helper` },
            '. Gateway features such as caching, budgets, virtual keys, and automatic fallbacks require traffic to pass through the gateway.',
          ],
        ],
      },
    ],
  },
  {
    id: 'comparisons',
    title: 'LLMOps platform comparisons',
    items: [
      {
        question: 'How does AcruxCore compare with Langfuse, Phoenix, Opik, Helicone, MLflow, and Laminar?',
        answer: [
          [
            'AcruxCore combines an LLM gateway with prompt management, tracing, and evaluation. The gateway applies routing, caching, budgets, and virtual keys before calls reach the provider. In our published comparison, Helicone and MLflow also offer gateways; Langfuse, Phoenix, Opik, and Laminar collect traces from calls made by your application.',
          ],
          [
            'AcruxCore brings prompt versioning and a versioned tool catalog together with gateway execution and tracing. It is also the only one of the seven whose audit log of who changed what needs no paid plan. This makes it a strong option for teams that want to manage their agents in one platform.',
          ],
          [
            'The ',
            { text: 'comparison matrix', to: '/compare' },
            ' compares ten criteria per competitor, with supporting sources. For a deeper look, read our ',
            { text: 'hands-on test of nine platforms', href: COMPARE_POST },
            '.',
          ],
        ],
      },
      {
        question: 'What are AcruxCore’s key strengths?',
        answer: [
          [
            'AcruxCore’s strengths include versioned tools, gateway-managed tool execution, and prompt templates with conditional logic. It also includes prompt optimization, trace-linked user feedback, and an audit log of who changed what, on every plan.',
          ],
          [
            'The ',
            { text: 'versioned tool catalog', href: `${DOCS_URL}/docs/guides/build-and-attach-a-tool` },
            ' stores individual tools with their version history and lets the gateway execute their calls. Our published comparison distinguishes this from stored tool schemas, playground configurations, and catalogs of whole MCP servers.',
          ],
          [
            'Tools can connect to HTTP endpoints that the gateway calls for you. Add an existing endpoint as a tool without redeploying your application.',
          ],
          [
            'AcruxCore also supports ',
            { text: 'prompt templates with conditional logic', href: `${DOCS_URL}/docs/guides/use-conditional-logic-in-prompt-templates` },
            ' using Jinja2 conditionals and loops. This keeps branching logic inside the template. In our published comparison, MLflow also supports this; the other five platforms use variable substitution.',
          ],
          [
            'The prompt optimizer drafts rewrites and evaluates them against the same test cases as your production prompt. You choose which candidate to promote as a new version. ',
            { text: 'Feedback', href: `${DOCS_URL}/docs/guides/improve-a-prompt-from-feedback` },
            ' links to a trace or an individual span and records its source. This separates end-user ratings from developer notes, so you can build datasets specifically from user feedback.',
          ],
          [
            'The ',
            { text: 'team-wide audit trail', to: '/features/audit' },
            ' records every change with the person who made it — API keys, members and roles, provider connections, virtual keys, budgets, secrets, prompts and tools. It is on by default on every plan and when self-hosted, and it filters by area, by event, or by the person.',
          ],
          [
            'These features help teams improve prompts using test results and user feedback. Other platforms also have evaluation strengths, including Opik; our comparison does not establish optimization or feedback as exclusive to AcruxCore. The audit trail is the exception. Of the seven platforms compared it is the only one that needs no paid plan: Langfuse gates its own behind a $2,499/mo Enterprise tier, and we found none in Phoenix, Opik, Helicone, MLflow or Laminar.',
          ],
        ],
      },
      {
        question: 'Which LLMOps platforms have an audit log of who changed what?',
        answer: [
          [
            'AcruxCore records every change with the member who made it, on every plan, self-hosted included. It is on by default and there is nothing to switch on.',
          ],
          [
            'There are three trails. Each prompt and each tool has its own Audit tab — created, renamed, version committed, alias promoted, alias deleted. Owners and admins also get one ',
            { text: 'team-wide trail', to: '/features/audit' },
            ' in the dashboard, covering what belongs to no prompt and no tool.',
          ],
          [
            'The team-wide trail holds 34 event types across seven areas: API keys, members and roles, invites, provider connections, virtual keys, budgets, gateway models, secrets, trace settings, and prompt and tool changes. Filter it by area, by a single event, or by the person — including someone who has since left the team.',
          ],
          [
            'In our published comparison this is the row where the paid tiers show. Langfuse has an audit log in its UI, gated behind the Enterprise plan at $2,499/mo, on hosted Langfuse as well as self-hosted. For Phoenix, Opik, Helicone, MLflow and Laminar we found no audit log in any settings page we opened.',
          ],
          [
            'Read the ',
            { text: 'audit trail guide', href: AUDIT_GUIDE },
            ' for the screens, or the ',
            { text: 'audit API', href: AUDIT_API },
            ' to pull the same events yourself. Check the dated ',
            { text: 'comparison matrix', to: '/compare' },
            ' before deciding: a feature can ship after the date we checked it, and this is a row worth re-checking yourself if a compliance review depends on it.',
          ],
        ],
      },
      {
        question: 'How much latency does the AcruxCore gateway add?',
        answer: [
          [
            'In our published benchmark, AcruxCore added about 42 ms of software overhead compared with calling OpenAI directly. The reported confidence interval was +17 ms to +81 ms. Actual overhead depends on your setup and workload.',
          ],
          [
            'The ',
            { text: 'benchmark write-up', href: LATENCY_POST },
            ' includes the latency distribution, tail latency, and a reproducible test script. Run it with your workload to assess the trade-off.',
          ],
        ],
      },
      {
        question: 'When should I consider an AcruxCore alternative?',
        answer: [
          [
            'Consider an alternative if you need a hierarchy above teams, gateway-level content filtering, different role controls, or a larger project community. In our published comparison, Langfuse and Laminar offer two-level hierarchies; AcruxCore uses a flat team structure.',
          ],
          [
            'Our comparison also identifies endpoint-level content guardrails and PII filtering in MLflow’s gateway, which AcruxCore does not offer. AcruxCore allows one role per member; review the documented role controls if your team needs more flexibility.',
          ],
          [
            'Langfuse and MLflow have larger GitHub communities in our published comparison. If ecosystem size matters to your decision, weigh it alongside workflow fit and deployment needs.',
          ],
        ],
      },
      {
        question: 'How can I verify AcruxCore’s comparisons?',
        answer: [
          [
            'Our comparisons include sources, test details, and screenshots from actual sessions. We run each platform, self-host where possible, and rebuild the same example prompt on both sides.',
          ],
          [
            'Every row in the ',
            { text: 'comparison matrix', to: '/compare' },
            ' includes a source link and a check date. We highlight competitor strengths alongside AcruxCore’s strengths so you can assess the trade-offs.',
          ],
          [
            'The latency test scripts are available in the repository. You can reproduce the benchmark and check how the results apply to your environment.',
          ],
        ],
      },
      {
        question: 'How does AcruxCore’s open-source license compare?',
        answer: [
          [
            'AcruxCore uses Apache 2.0 for the whole platform, with no enterprise-only feature directory. Our published comparison identifies similar licensing for four alternatives and different terms for two.',
          ],
          [
            'The comparison lists Opik, Helicone, MLflow, and Laminar as Apache 2.0 without a gated directory. It describes Langfuse as MIT at its core, with some features under an enterprise license. Phoenix uses the Elastic License 2.0, a source-available license that is not OSI-approved.',
          ],
          ['Check the linked sources and review each license before choosing a platform. AcruxCore’s Apache 2.0 license supports teams that want to run and manage the full platform themselves.'],
        ],
      },
    ],
  },
  {
    id: 'running-it',
    title: 'Self-hosting, privacy, and data export',
    items: [
      {
        question: 'Can I self-host AcruxCore?',
        answer: [
          [
            'Yes. Run ',
            { text: 'docker compose up', href: GITHUB_URL },
            ' to self-host the same code used by the hosted platform. There is no separate community edition or enterprise-only feature directory.',
          ],
        ],
      },
      {
        question: 'Does AcruxCore store my prompts and responses?',
        answer: [
          [
            'Hosted AcruxCore stores request and response bodies for trace inspection. You can disable payload capture for your whole team or individual traces. The ',
            { text: 'payload capture guide', href: `${DOCS_URL}/docs/guides/configure-trace-payload-capture` },
            ' explains both options.',
          ],
          [
            'With self-hosting, you manage AcruxCore on your own infrastructure. Data sent to external model providers still depends on your configuration. For hosted data handling, see the ',
            { text: 'security page', to: '/security' },
            '.',
          ],
        ],
      },
      {
        question: 'Can I export my prompts and traces?',
        answer: [
          [
            'Yes. Export your prompt library as portable JSON, including its version history, and import it again when needed. The ',
            { text: 'diff, export and import guide', href: `${DOCS_URL}/docs/guides/diff-export-and-import-your-prompt-library` },
            ' explains the process. You can also retrieve traces through the REST API.',
          ],
        ],
      },
    ],
  },
  {
    id: 'cost',
    title: 'AcruxCore pricing',
    items: [
      {
        question: 'Is the AcruxCore audit log free, or does it need a paid plan?',
        answer: [
          [
            'It is free. The audit trail is part of the platform on every plan, hosted and self-hosted, with no upgrade and no add-on. Self-hosting it costs nothing beyond your own infrastructure, because the whole platform is ',
            { text: 'Apache 2.0', href: `${GITHUB_URL}/blob/main/LICENSE` },
            ' with no enterprise-only directory.',
          ],
          [
            'This is unusual in this category, and it is the reason the row is worth checking. Of the seven platforms in our hands-on comparison, AcruxCore is the only one whose audit trail needs no paid plan. Langfuse has one, behind its $2,499/mo Enterprise tier for hosted and self-hosted use alike. We found none in Phoenix, Opik, Helicone, MLflow or Laminar.',
          ],
          [
            'What it does not do yet: there is no CSV or JSON export and no retention window you can set. Events accumulate and are read in the dashboard or over the ',
            { text: 'audit API', href: AUDIT_API },
            '.',
          ],
        ],
      },
      {
        question: 'How much does AcruxCore cost? Is there a token markup?',
        answer: [
          [
            'Self-hosted AcruxCore has no software license fee. The full platform is available under Apache 2.0, with no enterprise-only feature directory. You pay for your infrastructure and any model provider usage.',
          ],
          [
            'Hosted AcruxCore is free during beta, with no credit card required at sign-up.',
          ],
          [
            'AcruxCore does not mark up model tokens. Connect your own provider credentials and pay the provider’s rates. The gateway tracks per-call costs for visibility without adding a token surcharge.',
          ],
          [
            'Post-beta hosted pricing has not been announced. Check the ',
            { text: 'pricing page', to: '/pricing' },
            ' for updates. Existing accounts will receive notice before pricing changes.',
          ],
        ],
      },
    ],
  },
];

/**
 * Renders an answer as one `<p>` per paragraph, turning link runs into the
 * right element type.
 *
 * The paragraphs are emitted here rather than by the page, so that every
 * surface rendering an answer breaks it the same way.
 */
export function FaqAnswer({ answer }: { answer: readonly AnswerParagraph[] }): ReactNode {
  return (
    <>
      {answer.map((paragraph, pIndex) => (
        <p key={pIndex} style={{ margin: pIndex === 0 ? '0' : '0.7em 0 0' }}>
          {paragraph.map((run, index) => {
            if (typeof run === 'string') {
              return <span key={index}>{run}</span>;
            }
            if (run.to) {
              return (
                <Link key={index} to={run.to}>
                  {run.text}
                </Link>
              );
            }
            return (
              <a key={index} href={run.href} target="_blank" rel="noreferrer">
                {run.text}
              </a>
            );
          })}
        </p>
      ))}
    </>
  );
}

/**
 * The `FAQPage` structured-data block for `/faq`, as a JSON string.
 *
 * Worth emitting because this is the one page on the site shaped the way answer
 * engines quote — a question with a self-contained answer under it — and the
 * schema is what tells them the shape is deliberate rather than incidental
 * prose. It is built from {@link FAQ_GROUPS} at build time, so it cannot fall
 * behind the visible page.
 *
 * @returns A JSON string suitable for an `application/ld+json` script tag.
 */
export function faqStructuredData(): string {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FAQ_GROUPS.flatMap((group) =>
      group.items.map((item) => ({
        '@type': 'Question',
        name: item.question,
        acceptedAnswer: {
          '@type': 'Answer',
          text: answerToPlainText(item.answer),
        },
      })),
    ),
  });
}
