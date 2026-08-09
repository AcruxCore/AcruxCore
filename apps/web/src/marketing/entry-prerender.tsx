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
import { FEATURE_LIST } from './features';

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
   * Source file backing this page, relative to `apps/web`.
   *
   * `scripts/prerender.mjs` reads its last git commit date to fill in the
   * page's sitemap `<lastmod>`. It cannot be derived from
   * {@link PrerenderRoute.component}, because the bundler discards the original
   * filename — hence stating it here, next to the page it describes, so adding
   * a route cannot silently produce a sitemap entry with no date.
   */
  sourceFile: string;
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
    title: 'AcruxCore — LLM-ops platform for engineering teams',
    description:
      'AcruxCore is an LLM-ops platform for engineering teams: version prompts, route LLM calls through an OpenAI-compatible gateway, trace every request, catalog tools, and evaluate quality — one platform, no redeploy to change a prompt.',
    component: LandingPage,
    sourceFile: 'src/marketing/LandingPage.tsx',
    priority: 1.0,
    changefreq: 'weekly',
  },
  {
    path: '/about',
    out: 'about/index.html',
    title: 'About — AcruxCore',
    description:
      'AcruxCore is one control plane for the whole LLM stack: prompt versioning, an OpenAI-compatible gateway, tracing, a tool catalog, and evaluation — with first-class TypeScript and Python SDKs.',
    component: AboutPage,
    sourceFile: 'src/marketing/pages/AboutPage.tsx',
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
    sourceFile: 'src/marketing/pages/ContactPage.tsx',
    priority: 0.5,
    changefreq: 'monthly',
  },
  {
    path: '/security',
    out: 'security/index.html',
    title: 'Security — AcruxCore',
    description:
      'How AcruxCore protects your provider keys, prompts, and trace data: team isolation, encryption, payload-capture controls, self-hosting, and responsible disclosure.',
    component: SecurityPage,
    sourceFile: 'src/marketing/pages/SecurityPage.tsx',
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
    sourceFile: 'src/marketing/pages/PrivacyPage.tsx',
    priority: 0.3,
    changefreq: 'yearly',
  },
  {
    path: '/terms',
    out: 'terms/index.html',
    title: 'Terms of Service — AcruxCore',
    description: 'The terms that govern your access to and use of the AcruxCore platform, SDKs, APIs, and website.',
    component: TermsPage,
    sourceFile: 'src/marketing/pages/TermsPage.tsx',
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
    sourceFile: 'src/marketing/pages/PricingPage.tsx',
    priority: 0.7,
    changefreq: 'monthly',
  },
  {
    path: '/sdk',
    out: 'sdk/index.html',
    title: 'TypeScript & Python SDKs — AcruxCore',
    description:
      'One client for prompts, the gateway, and tracing, with the same surface in TypeScript and Python: cached prompt rendering, OpenAI-compatible chat, single-trace tool loops, and feedback.',
    component: SdkPage,
    sourceFile: 'src/marketing/pages/SdkPage.tsx',
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
    // Every pillar page's copy lives in features.tsx, so that is the file
    // whose commit date reflects a change to any of them.
    sourceFile: 'src/marketing/features.tsx',
    priority: 0.8,
    changefreq: 'monthly' as const,
  })),
  {
    path: '/compare',
    out: 'compare/index.html',
    title: 'LLM Observability Tools Compared (2026) | AcruxCore',
    description:
      'AcruxCore vs Langfuse, Phoenix, Opik, and Helicone on license, self-hosting, pricing, team structure, security, and community stats — every fact sourced and dated.',
    component: ComparePage,
    sourceFile: 'src/marketing/pages/ComparePage.tsx',
    priority: 0.8,
    changefreq: 'monthly',
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
