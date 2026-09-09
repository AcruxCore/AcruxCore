import { type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { LandingPage } from './LandingPage';
import { AboutPage } from './pages/AboutPage';
import { ContactPage } from './pages/ContactPage';
import { SecurityPage } from './pages/SecurityPage';
import { PrivacyPage } from './pages/PrivacyPage';
import { TermsPage } from './pages/TermsPage';
import { PricingPage } from './pages/PricingPage';
import { SdkPage } from './pages/SdkPage';
import { FeaturePage } from './pages/FeaturePage';
import { ComparePage } from './pages/ComparePage';
import { FaqPage } from './pages/FaqPage';
import { BestLlmOpsPlatformsPage } from './pages/BestLlmOpsPlatformsPage';
import { faqStructuredData } from './faq';
import { platformListStructuredData } from './comparisons';
import { FEATURE_LIST } from './features';
import { LANDING_TITLE } from './marketing-chrome';

/**
 * Re-exported so `scripts/prerender.mjs` can reach it: the prerenderer imports
 * exactly one module (the SSR bundle built from this file), so anything it
 * needs has to be reachable from here.
 */
export { buildLlmsTxt } from './llms-txt';

/** A public marketing route baked to static HTML at build time. */
export interface PrerenderRoute {
  /** Router path, e.g. `/` or `/about`. */
  path: string;
  /** Output file relative to `dist/`, e.g. `index.html` or `about/index.html`. */
  out: string;
  /** `<title>` for the page. */
  title: string;
  /** `<meta name="description">` / social description for the page. */
  description: string;
  /** The page component to render at {@link path}. */
  component: () => ReactNode;
  /**
   * Every source file whose content this page renders, relative to `apps/web`.
   *
   * `scripts/prerender.mjs` takes the **newest** change date across them as the
   * page's sitemap `<lastmod>`. A list rather than a single file because most
   * pages here render copy that does not live in their own component: all six
   * pillar pages are `features.tsx` poured into `FeaturePage.tsx`, the landing
   * page's pillar grid comes from `features.tsx` too, and `/compare` renders
   * `comparisons.tsx`. Naming only the component meant editing the copy moved
   * no date at all, which told crawlers the page had not changed when it had.
   *
   * Shared chrome (`marketing-chrome.tsx`, `MarketingShell.tsx`) is deliberately
   * NOT listed: a nav or footer tweak is not a content change, and listing it
   * would re-date all fourteen pages every time.
   *
   * It cannot be derived from {@link PrerenderRoute.component}, because the
   * bundler discards the original filename — hence stating it here, next to the
   * page it describes, so adding a route cannot silently produce a sitemap entry
   * with no date.
   */
  sourceFiles: string[];
  /**
   * Relative importance in the sitemap, 0-1.
   *
   * Google ignores this field; Bing and Yandex read it. It lives here rather
   * than in the sitemap generator so that one route definition carries
   * everything about the page.
   */
  priority: number;
  /** How often this page's content is rewritten. */
  changefreq: 'weekly' | 'monthly' | 'yearly';
  /**
   * An extra `application/ld+json` payload for this page only, already
   * stringified.
   *
   * The two JSON-LD blocks in `index.html` are copied verbatim into every
   * marketing page, which is right for Organization and WebSite and wrong for
   * anything page-specific: a `FAQPage` block written there would tell crawlers
   * that all fifteen pages are FAQs. `scripts/prerender.mjs` appends this one
   * into the head of just this route's HTML.
   */
  structuredData?: string;
}

/**
 * Every public marketing page that is prerendered to static HTML.
 *
 * The production app is a client-only SPA, so crawlers and social-preview bots
 * that do not execute JavaScript would otherwise receive an empty `#root`. Each
 * entry is baked into its own `dist/<out>` by `scripts/prerender.mjs`, with the
 * per-page {@link PrerenderRoute.title} and {@link PrerenderRoute.description}
 * patched into the shared `index.html` head. On the client, `createRoot` hydrates
 * the same route.
 */
export const ROUTES: PrerenderRoute[] = [
  {
    path: '/',
    out: 'index.html',
    title: LANDING_TITLE,
    description:
      'AcruxCore is an open-source, Apache-2.0, self-hostable LLMOps platform: version prompts, route calls through an OpenAI-compatible gateway, trace and evaluate.',
    component: LandingPage,
    sourceFiles: ['src/marketing/LandingPage.tsx', 'src/marketing/features.tsx'],
    priority: 1.0,
    changefreq: 'weekly',
  },
  {
    path: '/about',
    out: 'about/index.html',
    title: 'About — AcruxCore',
    description:
      'AcruxCore is one control plane for the whole LLM stack: prompt versioning, an OpenAI-compatible gateway, tracing, a tool catalog and evaluation.',
    component: AboutPage,
    sourceFiles: ['src/marketing/pages/AboutPage.tsx'],
    priority: 0.6,
    changefreq: 'monthly',
  },
  {
    path: '/contact',
    out: 'contact/index.html',
    title: 'Contact — AcruxCore',
    description:
      'Get in touch with the AcruxCore team about the platform, self-hosting, pricing, or security reports.',
    component: ContactPage,
    sourceFiles: ['src/marketing/pages/ContactPage.tsx'],
    priority: 0.5,
    changefreq: 'monthly',
  },
  {
    path: '/security',
    out: 'security/index.html',
    title: 'Security — AcruxCore',
    description:
      'How AcruxCore protects provider keys, prompts and trace data: team isolation, encryption, payload-capture controls, self-hosting and disclosure.',
    component: SecurityPage,
    sourceFiles: ['src/marketing/pages/SecurityPage.tsx'],
    priority: 0.5,
    changefreq: 'monthly',
  },
  {
    path: '/privacy',
    out: 'privacy/index.html',
    title: 'Privacy Policy — AcruxCore',
    description:
      'What information AcruxCore collects, how we use it, and the choices you have across the hosted platform and website.',
    component: PrivacyPage,
    sourceFiles: ['src/marketing/pages/PrivacyPage.tsx'],
    priority: 0.3,
    changefreq: 'yearly',
  },
  {
    path: '/terms',
    out: 'terms/index.html',
    title: 'Terms of Service — AcruxCore',
    description: 'The terms that govern your access to and use of the AcruxCore platform, SDKs, APIs, and website.',
    component: TermsPage,
    sourceFiles: ['src/marketing/pages/TermsPage.tsx'],
    priority: 0.3,
    changefreq: 'yearly',
  },
  {
    path: '/pricing',
    out: 'pricing/index.html',
    title: 'Pricing — AcruxCore',
    description:
      'AcruxCore is free while in beta: the whole platform, with your own provider keys and no token markup. Self-hosted and enterprise options on request.',
    component: PricingPage,
    sourceFiles: ['src/marketing/pages/PricingPage.tsx'],
    priority: 0.7,
    changefreq: 'monthly',
  },
  {
    path: '/sdk',
    out: 'sdk/index.html',
    title: 'TypeScript & Python SDKs — AcruxCore',
    description:
      'One client for prompts, the gateway and tracing, in TypeScript and Python: cached prompt rendering, OpenAI-compatible chat and single-trace tool loops.',
    component: SdkPage,
    sourceFiles: ['src/marketing/pages/SdkPage.tsx'],
    priority: 0.8,
    changefreq: 'monthly',
  },
  // One prerendered page per pillar, generated from the shared FEATURE_LIST so a
  // route in the router always has matching static HTML for crawlers.
  ...FEATURE_LIST.map((feature) => ({
    path: `/features/${feature.slug}`,
    out: `features/${feature.slug}/index.html`,
    title: feature.metaTitle,
    description: feature.metaDescription,
    component: () => <FeaturePage feature={feature} />,
    // A pillar page is features.tsx (the copy) rendered through
    // FeaturePage.tsx (the sections that copy is poured into), so a change to
    // either one changes the page a crawler sees.
    sourceFiles: ['src/marketing/features.tsx', 'src/marketing/pages/FeaturePage.tsx'],
    priority: 0.8,
    changefreq: 'monthly' as const,
  })),
  {
    path: '/compare',
    out: 'compare/index.html',
    title: 'LLM Observability Tools Compared (2026) | AcruxCore',
    description:
      'AcruxCore vs Langfuse, Phoenix, Opik, Helicone, MLflow and Laminar on license, self-hosting, pricing, team structure and community — sourced and dated.',
    component: ComparePage,
    sourceFiles: ['src/marketing/pages/ComparePage.tsx', 'src/marketing/comparisons.tsx'],
    priority: 0.8,
    changefreq: 'monthly',
  },
  {
    path: '/faq',
    out: 'faq/index.html',
    title: 'AcruxCore FAQ — how it compares, and where it does not fit',
    description:
      'Straight answers on what AcruxCore does, how it compares to Langfuse, Phoenix, Opik, Helicone, MLflow and Laminar, and where another tool fits better.',
    component: FaqPage,
    sourceFiles: ['src/marketing/pages/FaqPage.tsx', 'src/marketing/faq.tsx'],
    priority: 0.8,
    changefreq: 'monthly',
    structuredData: faqStructuredData(),
  },
  {
    path: '/best-open-source-llmops-platforms',
    out: 'best-open-source-llmops-platforms/index.html',
    title: 'Best Open-Source LLMOps Platforms in 2026 | AcruxCore',
    description:
      'Seven open-source LLMOps platforms compared — Langfuse, MLflow, Opik, Phoenix, Helicone, Laminar and AcruxCore — each self-hosted and run for real.',
    component: BestLlmOpsPlatformsPage,
    sourceFiles: [
      'src/marketing/pages/BestLlmOpsPlatformsPage.tsx',
      'src/marketing/comparisons.tsx',
    ],
    priority: 0.9,
    changefreq: 'monthly',
    structuredData: platformListStructuredData(),
  },
];

/**
 * Render one marketing route to a static HTML string (no surrounding document).
 *
 * Renders the route's component directly — not through the auth-gated `/` route,
 * which would render a loading spinner with no session — wrapped in a
 * `StaticRouter` so `<Link>` elements resolve.
 *
 * @param path - The route path to render; must match a {@link ROUTES} entry.
 * @returns The rendered page markup.
 * @throws {Error} When `path` does not match any known route.
 */
export function render(path = '/'): string {
  const route = ROUTES.find((r) => r.path === path);
  if (!route) throw new Error(`Unknown prerender route: ${path}`);
  const Page = route.component;
  return renderToString(
    <StaticRouter location={path}>
      <Page />
    </StaticRouter>,
  );
}
