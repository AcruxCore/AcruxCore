import { FEATURE_LIST } from './features';

/**
 * Schema.org entity ids and the per-page JSON-LD for the marketing site.
 *
 * The site-wide entities (Organization, WebSite, SoftwareApplication) are
 * written once, by hand, in `apps/web/index.html`, and carry the ids below.
 * Every page then adds one small graph of its own — a WebPage for its own URL
 * and a BreadcrumbList — that points back at those entities by `@id` instead of
 * repeating them. The blog and docs sites reuse {@link ORGANIZATION_ID} for
 * the same reason, so all three hosts describe one company.
 */

const SITE_ORIGIN = 'https://acruxcore.com';

/** `@id` of the company. Shared verbatim with `apps/docs/site-shared.ts`. */
export const ORGANIZATION_ID = `${SITE_ORIGIN}/#org`;

/** `@id` of the acruxcore.com website. */
export const WEBSITE_ID = `${SITE_ORIGIN}/#website`;

/** `@id` of the product (the SoftwareApplication block). */
export const SOFTWARE_ID = `${SITE_ORIGIN}/#software`;

/**
 * Raster logo for the Organization. Google ignores an SVG logo and wants at
 * least 112x112 px; this one is 512x512, rendered by `scripts/brand-assets.mjs`
 * from the same `favicon.svg` mark the site uses.
 */
export const LOGO_URL = `${SITE_ORIGIN}/brand/logo-512.png`;

/**
 * The breadcrumb label for each non-pillar page — what the page is called in
 * the nav or footer, not its full `<title>`. Pillar pages take their label
 * from `FEATURE_LIST` instead, so a renamed pillar cannot drift from its trail.
 */
const BREADCRUMB_NAMES: Record<string, string> = {
  '/about': 'About',
  '/contact': 'Contact',
  '/press': 'Press',
  '/security': 'Security',
  '/privacy': 'Privacy Policy',
  '/terms': 'Terms of Service',
  '/pricing': 'Pricing',
  '/sdk': 'SDKs',
  '/compare': 'Compare',
  '/faq': 'FAQ',
  '/best-open-source-llmops-platforms': 'Best open-source LLMOps platforms',
};

/** The parts of a prerendered route this module reads. */
export interface StructuredDataRoute {
  /** Router path, e.g. `/` or `/pricing`. */
  path: string;
  /** The page's `<title>`, used as the WebPage name. */
  title: string;
  /** The page's meta description. */
  description: string;
  /**
   * `YYYY-MM-DD` of the page's last content change, the same date as its
   * sitemap `<lastmod>`. Omitted when the build has no date for the page.
   */
  dateModified?: string | null;
}

/**
 * The short breadcrumb label for one page.
 *
 * @param path - A marketing route path other than `/`.
 * @returns The label shown as the second crumb.
 * @throws {Error} When the path is neither a pillar page nor listed in
 *   {@link BREADCRUMB_NAMES}, so a new route fails the build instead of
 *   shipping a crumb with no name.
 */
function breadcrumbName(path: string): string {
  const feature = FEATURE_LIST.find((f) => path === `/features/${f.slug}`);
  if (feature) return feature.name;
  const name = BREADCRUMB_NAMES[path];
  if (!name) {
    throw new Error(`No breadcrumb name for ${path}. Add it to BREADCRUMB_NAMES in src/marketing/structured-data.ts.`);
  }
  return name;
}

/**
 * The per-page JSON-LD graph that `scripts/prerender.mjs` appends to a route.
 *
 * Holds a WebPage for the page's own canonical URL, joined to the site-wide
 * entities by `@id` (`isPartOf` the WebSite, `about` the product, published by
 * the Organization), and — below the home page — a two-step BreadcrumbList,
 * Home then the page. There is no deeper level: `/features` has no page of its
 * own (it redirects to `/#pillars`), so a pillar page is Home > pillar.
 *
 * @param route - The route's path, title, description and, when known, change date.
 * @returns The graph as a JSON string, ready to drop into a
 *   `<script type="application/ld+json">`.
 * @throws {Error} When a non-home route has no breadcrumb name.
 */
export function pageStructuredData(route: StructuredDataRoute): string {
  const url = route.path === '/' ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}${route.path}`;
  const breadcrumbId = `${url}#breadcrumb`;
  const isHome = route.path === '/';

  const webPage: Record<string, unknown> = {
    '@type': 'WebPage',
    '@id': `${url}#webpage`,
    url,
    name: route.title,
    description: route.description,
    inLanguage: 'en',
    isPartOf: { '@id': WEBSITE_ID },
    about: { '@id': SOFTWARE_ID },
    publisher: { '@id': ORGANIZATION_ID },
  };
  if (!isHome) webPage.breadcrumb = { '@id': breadcrumbId };
  // Without it, the only date on a marketing page is the footer's "© 2026",
  // which date extractors read as 1 January 2026.
  if (route.dateModified) webPage.dateModified = route.dateModified;

  const graph: Record<string, unknown>[] = [webPage];
  if (!isHome) {
    graph.push({
      '@type': 'BreadcrumbList',
      '@id': breadcrumbId,
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE_ORIGIN}/` },
        { '@type': 'ListItem', position: 2, name: breadcrumbName(route.path), item: url },
      ],
    });
  }

  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph });
}
