import type {ReactNode} from 'react';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';

/**
 * Docs home page. This is the documentation launchpad for docs.acruxcore.com —
 * its job is to route readers into the content (quickstart, guides, API
 * reference), not to re-pitch the product (that's the marketing landing in
 * apps/web). It shares the product's "precision instrument" identity (dark,
 * hairline, lime accent) so it reads as the same product.
 */

type Guide = {
  title: string;
  href: string;
  body: string;
  icon: ReactNode;
};

/** Small stroked-icon wrapper matching the app's line-icon language. */
function Ic({children}: {children: ReactNode}): ReactNode {
  return (
    <svg
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round">
      {children}
    </svg>
  );
}

const GUIDES: Guide[] = [
  {
    title: 'Prompts',
    href: '/docs/guides/version-a-prompt',
    body: 'Versioned, templated message sets. Move a production alias between versions without redeploying your app.',
    icon: (
      <Ic>
        <path d="M4 6h16" />
        <path d="M4 12h16" />
        <path d="M4 18h10" />
      </Ic>
    ),
  },
  {
    title: 'Gateway',
    href: '/docs/guides/route-calls-through-the-gateway',
    body: 'One OpenAI-compatible endpoint in front of every provider. Bring your own keys; get routing, cost, and caching.',
    icon: (
      <Ic>
        <path d="M3 8h6l3 8h9" />
        <path d="M17 4l3 4-3 4" />
        <path d="M3 16h4" />
      </Ic>
    ),
  },
  {
    title: 'Tracing',
    href: '/docs/guides/trace-an-llm-call',
    body: 'Every call recorded as a trace with spans — model, tokens, latency, cost. Report your own spans too.',
    icon: (
      <Ic>
        <circle cx={11} cy={11} r={7} />
        <path d="m21 21-4.3-4.3" />
      </Ic>
    ),
  },
  {
    title: 'Tools',
    href: '/docs/guides/build-and-attach-a-tool',
    body: 'Callable functions, versioned like prompts, that you attach to a prompt and hand to the model.',
    icon: (
      <Ic>
        <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.4 2.4-2-2 2.4-2.4Z" />
      </Ic>
    ),
  },
  {
    title: 'Evaluation',
    href: '/docs/guides/evaluate-a-prompt',
    body: 'Build datasets from real feedback and run experiments to compare prompt or model versions on quality.',
    icon: (
      <Ic>
        <rect x={4} y={12} width={4} height={8} rx={1} />
        <rect x={10} y={7} width={4} height={13} rx={1} />
        <rect x={16} y={3} width={4} height={17} rx={1} />
      </Ic>
    ),
  },
];

type StartLink = {n: string; title: string; body: string; href: string};

const START_LINKS: StartLink[] = [
  {
    n: '01',
    title: 'Quickstart',
    body: 'From signup to your first rendered, traced LLM call in about ten minutes.',
    href: '/docs/getting-started/quickstart',
  },
  {
    n: '02',
    title: 'Core concepts',
    body: 'Prompts, versions, aliases, the gateway, and traces — how they fit together.',
    href: '/docs/getting-started/core-concepts',
  },
  {
    n: '03',
    title: 'API reference',
    body: 'Every endpoint, curl-verified, with exact request and response shapes.',
    href: '/api-reference',
  },
];

function Arrow(): ReactNode {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true">
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  );
}

function Hero(): ReactNode {
  return (
    <div className="heroWrap">
      <div className="heroGlow" aria-hidden="true" />
      <section className="hero">
        <div className="heroContent">
          <div className="heroBadge">
            <span className="dot" aria-hidden="true" />
            <span>Documentation</span>
            <span aria-hidden="true">·</span>
            <span>Open source</span>
          </div>
          <Heading as="h1">
            Build on <span className="accent">AcruxCore.</span>
          </Heading>
          <p className="heroTagline">
            Guides, core concepts, and a complete API reference — from your first
            traced LLM call to running evaluations. Start with the quickstart, or
            jump straight to the reference.
          </p>
          <div className="heroButtons">
            <Link className="btnPrimary" to="/docs/getting-started/quickstart">
              Quickstart <Arrow />
            </Link>
            <Link className="btnGhost" to="/api-reference">
              API Reference
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}

function Guides(): ReactNode {
  return (
    <section className="section">
      <div className="sectionHead">
        <p className="eyebrow">Guides</p>
        <Heading as="h2">Learn the platform, one piece at a time.</Heading>
        <p>
          Each guide is self-contained. Follow them in order for the full
          round-trip, or jump straight to the one you need.
        </p>
      </div>
      <div className="blockGrid">
        {GUIDES.map((g) => (
          <Link key={g.title} to={g.href} className="blockCard">
            <span className="blockCard__icon">{g.icon}</span>
            <Heading as="h3">{g.title}</Heading>
            <p>{g.body}</p>
            <span className="blockCard__go">
              Read the guide <Arrow />
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

function StartHere(): ReactNode {
  return (
    <div className="startStrip">
      <section className="section">
        <div className="sectionHead">
          <p className="eyebrow">Get oriented</p>
          <Heading as="h2">New here?</Heading>
        </div>
        <div className="startGrid">
          {START_LINKS.map((s) => (
            <Link key={s.title} to={s.href} className="startCard">
              <span className="startCard__n">{s.n}</span>
              <span>
                <p className="startCard__t">{s.title}</p>
                <p className="startCard__d">{s.body}</p>
              </span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}

export default function Home(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  return (
    <Layout
      title={`${siteConfig.title} documentation`}
      description="Guides, core concepts, and a complete API reference for AcruxCore — version prompts, route LLM calls through a gateway, trace every request, catalog tools, and evaluate quality.">
      <div className="docLanding">
        <Hero />
        <main>
          <Guides />
          <StartHere />
        </main>
      </div>
    </Layout>
  );
}
