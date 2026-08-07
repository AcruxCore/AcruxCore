import { type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { LandingPage } from './LandingPage';
import { AboutPage } from './pages/AboutPage';
import { ContactPage } from './pages/ContactPage';
import { CareersPage } from './pages/CareersPage';
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
  },
  {
    path: '/about',
    out: 'about/index.html',
    title: 'About — AcruxCore',
    description:
      'AcruxCore is one control plane for the whole LLM stack: prompt versioning, an OpenAI-compatible gateway, tracing, a tool catalog, and evaluation — with first-class TypeScript and Python SDKs.',
    component: AboutPage,
  },
  {
    path: '/contact',
    out: 'contact/index.html',
    title: 'Contact — AcruxCore',
    description:
      'Get in touch with the AcruxCore team about the platform, self-hosting, pricing, or security reports.',
    component: ContactPage,
  },
  {
    path: '/careers',
    out: 'careers/index.html',
    title: 'Careers — AcruxCore',
    description: 'Open roles at AcruxCore, an LLM-ops platform for engineering teams.',
    component: CareersPage,
  },
  {
    path: '/security',
    out: 'security/index.html',
    title: 'Security — AcruxCore',
    description:
      'How AcruxCore protects your provider keys, prompts, and trace data: team isolation, encryption, payload-capture controls, self-hosting, and responsible disclosure.',
    component: SecurityPage,
  },
  {
    path: '/privacy',
    out: 'privacy/index.html',
    title: 'Privacy Policy — AcruxCore',
    description:
      'What information AcruxCore collects, how we use it, and the choices you have across the hosted platform and website.',
    component: PrivacyPage,
  },
  {
    path: '/terms',
    out: 'terms/index.html',
    title: 'Terms of Service — AcruxCore',
    description: 'The terms that govern your access to and use of the AcruxCore platform, SDKs, APIs, and website.',
    component: TermsPage,
  },
  {
    path: '/pricing',
    out: 'pricing/index.html',
    title: 'Pricing — AcruxCore',
    description:
      'AcruxCore is free while in beta: the whole platform, with your own provider keys and no token markup. Self-hosted and enterprise options on request.',
    component: PricingPage,
  },
  {
    path: '/sdk',
    out: 'sdk/index.html',
    title: 'TypeScript & Python SDKs — AcruxCore',
    description:
      'One client for prompts, the gateway, and tracing, with the same surface in TypeScript and Python: cached prompt rendering, OpenAI-compatible chat, single-trace tool loops, and feedback.',
    component: SdkPage,
  },
  // One prerendered page per pillar, generated from the shared FEATURE_LIST so a
  // route in the router always has matching static HTML for crawlers.
  ...FEATURE_LIST.map((feature) => ({
    path: `/features/${feature.slug}`,
    out: `features/${feature.slug}/index.html`,
    title: feature.metaTitle,
    description: feature.metaDescription,
    component: () => <FeaturePage feature={feature} />,
  })),
  {
    path: '/compare',
    out: 'compare/index.html',
    title: 'Compare AcruxCore to Langfuse, Phoenix, Opik & Helicone',
    description:
      'License, self-hosting, pricing, team structure, security, and community stats for AcruxCore next to Langfuse, Phoenix, Opik, and Helicone — every fact sourced and dated.',
    component: ComparePage,
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
