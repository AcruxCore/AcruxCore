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
            'AcruxCore is an LLMOps platform for managing applications built on large language models. It includes prompt versioning, an OpenAI-compatible LLM gateway, tracing, a tool catalog, and evaluation. The gateway records each model request that passes through it. If you do not use the gateway, your application can send its traces to AcruxCore directly.',
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
            'AcruxCore lets a team change a prompt without redeploying the application. It also shows what happened inside each model call. Prompt versions live in one place that the whole team can edit.',
          ],
          [
            'The gateway records each request that passes through it, so you do not depend only on the traces your application reports.',
          ],
          [
            'The tool catalog stores tool definitions next to your prompts. Attach a tool to a prompt and the model can call it. The prompt then works as an agent, with no extra code to connect the tool and the prompt. See the ',
            { text: 'connect a tool to a prompt guide', href: `${DOCS_URL}/docs/guides/connect-a-tool-to-a-prompt` },
            '.',
          ],
        ],
      },
      {
        question: 'What is the difference between a trace and an audit event?',
        answer: [
          [
            'A trace records traffic your application sent: one model call, its prompt, its tokens, its latency and its cost. An audit event records a change a person made, and names that person.',
          ],
          [
            'A trace answers why one model answer came out wrong. An audit event answers who changed the prompt on Tuesday, and what it said before. A model answer never becomes an audit event, and a role change never appears in a trace.',
          ],
          [
            'AcruxCore keeps traces and audit events, and both are on by default. See ',
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
            'AcruxCore combines an LLM gateway with prompt management, tracing, and evaluation. The gateway applies routing, caching, budgets, and virtual keys before calls reach the provider. Helicone and MLflow also have gateways. Langfuse, Phoenix, Opik, and Laminar have no gateway, and collect traces from the calls your application makes.',
          ],
          [
            'AcruxCore versions prompts and tools in the same place. The gateway runs those tools, and tracing records each model call. AcruxCore is also the only one of these platforms with an audit trail that costs nothing extra.',
          ],
          [
            'The ',
            { text: 'comparison matrix', to: '/compare' },
            ' puts the seven platforms side by side on ten criteria, with a source for each cell. The ',
            { text: 'hands-on test of nine platforms', href: COMPARE_POST },
            ' covers these seven, plus LangSmith and PromptLayer, in more detail.',
          ],
        ],
      },
      {
        question: 'What are AcruxCore’s key strengths?',
        answer: [
          [
            'AcruxCore’s first strength is its tool catalog. Each tool has a version history, and the gateway runs the tool when a model calls it. The second strength is prompt templates with conditions and loops. AcruxCore also has a prompt optimizer, user feedback linked to traces, and an audit trail that costs nothing extra.',
          ],
          [
            'The ',
            { text: 'versioned tool catalog', href: `${DOCS_URL}/docs/guides/build-and-attach-a-tool` },
            ' stores each tool with its version history, and the gateway runs the tool when a model calls it. No other platform in our comparison keeps versions of a tool and also runs it. Langfuse and Laminar store a tool schema inside a playground, and nothing runs it. Phoenix, Opik, and Helicone have no tool catalog. MLflow catalogs whole MCP servers, each a bundle of tools, rather than single tools.',
          ],
          [
            'Tools can connect to HTTP endpoints that the gateway calls for you. Add an existing endpoint as a tool without redeploying your application.',
          ],
          [
            'AcruxCore also supports ',
            { text: 'prompt templates with conditional logic', href: `${DOCS_URL}/docs/guides/use-conditional-logic-in-prompt-templates` },
            '. Jinja2 if statements and for loops keep the branching inside the template. MLflow also supports conditions and loops. Langfuse, Phoenix, Opik, Helicone, and Laminar only substitute variables.',
          ],
          [
            'The prompt optimizer drafts rewrites and evaluates them against the same test cases as your production prompt. You choose which candidate to promote as a new version. ',
            { text: 'Feedback', href: `${DOCS_URL}/docs/guides/improve-a-prompt-from-feedback` },
            ' links to a trace or to one span inside it. Each entry is labeled as an end-user rating or a developer note, so you can build a dataset from user feedback alone.',
          ],
          [
            'The ',
            { text: 'team-wide audit trail', to: '/features/audit' },
            ' records every change with the name of the person who made it. The trail covers API keys, members and roles, provider connections, virtual keys, budgets, secrets, prompts, and tools. Hosted or self-hosted, the trail is on by default. You can filter it by area, by event type, or by person.',
          ],
          [
            'A prompt optimizer and linked feedback are not unique to AcruxCore. Other platforms, Opik among them, also have optimizers and evaluation tools. The audit trail is different. AcruxCore is the only platform in our comparison where the trail costs nothing extra.',
          ],
        ],
      },
      {
        question: 'Which LLMOps platforms have an audit log of who changed what?',
        answer: [
          [
            'AcruxCore has an audit trail that records every change with the name of the person who made it, whether hosted or self-hosted. The trail is on by default and costs nothing extra.',
          ],
          [
            'Each prompt and each tool has its own Audit tab. The tab lists when that prompt or tool was created or renamed, when a version was committed, and when an alias was promoted or deleted. Owners and admins also get one ',
            { text: 'team-wide trail', to: '/features/audit' },
            ' in the dashboard. That trail covers the whole team, including the changes that belong to no single prompt or tool.',
          ],
          [
            'The team-wide trail holds 34 event types across multiple areas. The areas are API keys, members and roles, invites, provider connections, virtual keys, budgets, gateway models, secrets, trace settings, and prompt and tool changes. You can filter the trail by area, by one event type, or by person. Entries stay in the trail after the person who made them leaves the team.',
          ],
          [
            'Langfuse has an audit log, but it needs the Enterprise plan at $2,499 a month, even if you self-host. In Phoenix, Opik, Helicone, MLflow, and Laminar we found no audit log in the settings pages we opened.',
          ],
          [
            'The ',
            { text: 'audit trail guide', href: AUDIT_GUIDE },
            ' shows the dashboard screens, and the ',
            { text: 'audit API', href: AUDIT_API },
            ' returns the same events to your own code. Each cell in the ',
            { text: 'comparison matrix', to: '/compare' },
            ' has a check date. A platform can add an audit log after that date.',
          ],
        ],
      },
      {
        question: 'How much latency does the AcruxCore gateway add?',
        answer: [
          [
            'In our published benchmark, AcruxCore added about 42 ms of latency to each call compared with calling OpenAI directly. The confidence interval was +17 ms to +81 ms. Actual overhead depends on your setup and workload.',
          ],
          [
            'The ',
            { text: 'benchmark write-up', href: LATENCY_POST },
            ' includes the latency distribution, the tail latency, and the test script, which you can run against your own workload.',
          ],
        ],
      },
      {
        question: 'When should I consider an AcruxCore alternative?',
        answer: [
          [
            'Pick something else if you need an organization or workspace above teams, or content filtering in the gateway. Also pick something else if you need more than one role per member, or a larger community. Langfuse has an organization above its projects, and Laminar has a workspace above its projects. AcruxCore has one team with nothing above it.',
          ],
          [
            'MLflow’s gateway can block content and personal data at each endpoint. AcruxCore has no such filter. AcruxCore also gives each member exactly one role at a time.',
          ],
          [
            'Langfuse and MLflow have larger GitHub communities than AcruxCore.',
          ],
        ],
      },
      {
        question: 'How can I verify AcruxCore’s comparisons?',
        answer: [
          [
            'Our comparisons link a source for each fact and include screenshots from our test sessions. We self-host each platform where we can, then build the same example prompt in that platform and in AcruxCore.',
          ],
          [
            'Every cell in the ',
            { text: 'comparison matrix', to: '/compare' },
            ' has a source link and a check date.',
          ],
          [
            'The latency test scripts are in the ',
            { text: 'AcruxCore repository', href: GITHUB_URL },
            ', so you can rerun the benchmark in your own environment.',
          ],
        ],
      },
      {
        question: 'How does AcruxCore’s open-source license compare?',
        answer: [
          [
            'AcruxCore uses Apache 2.0 for the whole platform, with no folder under a separate paid license.',
          ],
          [
            'Opik, Helicone, MLflow, and Laminar use Apache 2.0 on the same terms. Langfuse is MIT at its core, and some features sit in a folder under an enterprise license. Phoenix uses the Elastic License 2.0, a source-available license that the Open Source Initiative has not approved.',
          ],
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
            ' to self-host the same code used by the hosted platform. There is no separate community edition and no folder under a separate paid license.',
          ],
        ],
      },
      {
        question: 'Does AcruxCore store my prompts and responses?',
        answer: [
          [
            'Hosted AcruxCore stores the request and response body of each call so you can inspect the trace. This stored body is called the payload, and you can turn payload capture off for the whole team or for single traces. The ',
            { text: 'payload capture guide', href: `${DOCS_URL}/docs/guides/configure-trace-payload-capture` },
            ' explains both options.',
          ],
          [
            'When you self-host, AcruxCore runs on your own servers. Self-hosting does not stop data going to the model providers you connect. Your own configuration decides what each call sends them. For hosted data handling, see the ',
            { text: 'security page', to: '/security' },
            '.',
          ],
        ],
      },
      {
        question: 'Can I export my prompts and traces?',
        answer: [
          [
            'Yes. Export your prompt library as JSON, including its version history, and import it again when needed. The ',
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
            'It is free. The audit trail is part of the platform whether hosted or self-hosted. Self-hosting costs nothing beyond your own servers, because the whole platform is ',
            { text: 'Apache 2.0', href: `${GITHUB_URL}/blob/main/LICENSE` },
            ' with no folder under a separate paid license.',
          ],
          [
            'AcruxCore is the only platform we compared whose audit trail costs nothing extra.',
          ],
          [
            'The trail has no CSV or JSON export yet, and you cannot set how long entries are kept. Events are never deleted. You read them in the dashboard or through the ',
            { text: 'audit API', href: AUDIT_API },
            '.',
          ],
        ],
      },
      {
        question: 'How much does AcruxCore cost? Is there a token markup?',
        answer: [
          [
            'Self-hosted AcruxCore has no license fee, so you pay only for your own servers and for the model providers you use. The full platform is Apache 2.0, with no folder under a separate paid license.',
          ],
          [
            'Hosted AcruxCore is free during beta, with no credit card required at sign-up.',
          ],
          [
            'AcruxCore does not mark up model tokens. Connect your own provider credentials and pay the provider’s rates. The gateway records the cost of each call and adds nothing to it.',
          ],
          [
            'Hosted pricing after the beta is not announced yet. The ',
            { text: 'pricing page', to: '/pricing' },
            ' will show it first, and existing accounts get notice before any price changes.',
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
