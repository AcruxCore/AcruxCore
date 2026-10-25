import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LANDING_TITLE } from './marketing-chrome';
import { ROUTES } from './entry-prerender';
import { FEATURE_LIST } from './features';
import {
  LOGO_URL,
  ORGANIZATION_ID,
  SOFTWARE_ID,
  WEBSITE_ID,
  pageStructuredData,
} from './structured-data';

/**
 * The three JSON-LD blocks live in `apps/web/index.html`, which the prerender
 * copies verbatim into every marketing page. They are hand-written JSON inside
 * an HTML file, so nothing type-checks them and nothing renders them — a
 * trailing comma or an unclosed bracket produces a page that looks perfect and
 * a structured-data block that every crawler silently discards.
 */
const indexHtml = readFileSync(
  fileURLToPath(new URL('../../index.html', import.meta.url)),
  'utf8',
);

/** Every `application/ld+json` payload in the shared head template, parsed. */
function structuredData(): Record<string, unknown>[] {
  const blocks = [
    ...indexHtml.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g),
  ];
  return blocks.map((match) => JSON.parse(match[1]) as Record<string, unknown>);
}

/** Reads a PNG's pixel size from its IHDR chunk. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('index.html structured data', () => {
  it('parses every ld+json block as JSON', () => {
    const blocks = structuredData();

    expect(blocks).toHaveLength(3);
    for (const block of blocks) {
      expect(block['@context']).toBe('https://schema.org');
    }
  });

  // `sameAs` is the only signal on the page that ties the name "AcruxCore" to
  // the profiles that carry it elsewhere. A relative or non-https entry is
  // dropped without a warning, which would leave the brand unresolvable again.
  it('gives the Organization a sameAs list of absolute https profile URLs', () => {
    const org = structuredData().find((block) => block['@type'] === 'Organization');

    expect(org).toBeDefined();
    const sameAs = org?.sameAs as string[] | undefined;
    expect(Array.isArray(sameAs)).toBe(true);
    expect(sameAs?.length).toBeGreaterThanOrEqual(2);
    for (const url of sameAs ?? []) {
      expect(url).toMatch(/^https:\/\//);
    }
    expect(new Set(sameAs).size).toBe(sameAs?.length);
  });

  // People search for the brand as two words, "acrux core", and the site
  // ranked below position 1 for it. WebSite.alternateName is the field Google
  // reads for a site's alternative names; Organization carries the same name so
  // the two blocks do not disagree.
  it('names "Acrux Core" as an alternate name on the WebSite and Organization', () => {
    for (const type of ['WebSite', 'Organization']) {
      const block = structuredData().find((entry) => entry['@type'] === type);
      expect(block?.name).toBe('AcruxCore');
      expect([block?.alternateName].flat()).toContain('Acrux Core');
    }
  });

  // The featureList is what a model reads to answer "what does it do". The
  // audit trail was absent from it while three pages claimed it in prose, so a
  // crawler that only parsed the JSON-LD never saw the one row no competitor in
  // our comparison matches for free.
  it('lists the audit trail among the SoftwareApplication features', () => {
    const app = structuredData().find((block) => block['@type'] === 'SoftwareApplication');

    expect(app).toBeDefined();
    const features = app?.featureList as string[] | undefined;
    expect(Array.isArray(features)).toBe(true);
    expect(features?.some((entry) => /audit/i.test(entry))).toBe(true);
    expect(features?.some((entry) => /every plan/i.test(entry))).toBe(true);
  });

  // The three site-wide blocks are one entity graph: every page's WebPage and
  // the blog's BlogPosting publisher point at these ids, so a crawler joins
  // them instead of reading fifteen unrelated copies of the same company.
  it('gives the Organization, WebSite and SoftwareApplication stable @ids', () => {
    const byType = (type: string) => structuredData().find((block) => block['@type'] === type);
    expect(byType('Organization')?.['@id']).toBe(ORGANIZATION_ID);
    expect(byType('WebSite')?.['@id']).toBe(WEBSITE_ID);
    expect(byType('SoftwareApplication')?.['@id']).toBe(SOFTWARE_ID);
    expect(byType('WebSite')?.publisher).toEqual({ '@id': ORGANIZATION_ID });
    expect(byType('SoftwareApplication')?.publisher).toEqual({ '@id': ORGANIZATION_ID });
  });

  // Google's logo guidelines want a raster image of at least 112x112. The
  // logo was /favicon.svg, which it does not accept.
  it('gives the Organization a raster logo of at least 112px that exists in public/', () => {
    const org = structuredData().find((block) => block['@type'] === 'Organization');
    const logo = org?.logo as { url?: string } | undefined;
    expect(logo?.url).toBe(LOGO_URL);
    expect(LOGO_URL).toMatch(/^https:\/\/acruxcore\.com\/.+\.png$/);
    const file = fileURLToPath(new URL(`../../public${new URL(LOGO_URL).pathname}`, import.meta.url));
    const { width, height } = pngSize(readFileSync(file));
    expect(width).toBeGreaterThanOrEqual(112);
    expect(height).toBe(width);
  });

  it('lists the npm and PyPI packages in sameAs', () => {
    const org = structuredData().find((block) => block['@type'] === 'Organization');
    expect(org?.sameAs).toEqual(
      expect.arrayContaining([
        'https://www.npmjs.com/package/@acruxcoreai/sdk',
        'https://pypi.org/project/acruxcore/',
      ]),
    );
  });

  // Every pillar page should have a featureList row, so the JSON-LD and the
  // pillar grid describe the same product.
  it('lists the MCP server among the SoftwareApplication features', () => {
    const app = structuredData().find((block) => block['@type'] === 'SoftwareApplication');
    const features = app?.featureList as string[] | undefined;
    expect(features?.some((entry) => /^MCP server\b/.test(entry))).toBe(true);
  });
});

/**
 * `index.html` is what a crawler reads; `useDocumentTitle` on the landing page
 * is what the tab says once React hydrates, and it runs second. So a title
 * changed in the HTML and not in the component produced a built file that was
 * correct and a real browser that reverted to the old wording a moment later —
 * invisible to a build, invisible to a diff, visible only if someone loads the
 * page. One constant, and this test to keep the hand-written HTML on it.
 */
describe('index.html head', () => {
  it('gives the landing page the same title the component sets', () => {
    const title = indexHtml.match(/<title>([\s\S]*?)<\/title>/)?.[1];
    expect(title).toBe(LANDING_TITLE);
  });

  // og:title and twitter:title are what a shared link shows. They drifted from
  // the <title> once already, for the same reason.
  it.each(['og:title', 'twitter:title'])('gives %s the same title', (name) => {
    const attr = name.startsWith('og:') ? 'property' : 'name';
    const pattern = new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`);
    expect(indexHtml.match(pattern)?.[1]).toBe(LANDING_TITLE);
  });
});

/**
 * The per-page block `scripts/prerender.mjs` appends to each route: a WebPage
 * with the page's own URL, joined to the site-wide entities by @id, and a
 * BreadcrumbList for every page below the home page.
 */
describe('pageStructuredData', () => {
  const graphOf = (path: string) => {
    const route = ROUTES.find((r) => r.path === path);
    if (!route) throw new Error(path);
    const parsed = JSON.parse(pageStructuredData(route)) as {
      '@context': string;
      '@graph': Record<string, unknown>[];
    };
    expect(parsed['@context']).toBe('https://schema.org');
    return parsed['@graph'];
  };

  it.each(ROUTES.map((r) => [r.path, r] as const))('%s has its own WebPage', (path, route) => {
    const url = path === '/' ? 'https://acruxcore.com/' : `https://acruxcore.com${path}`;
    const page = graphOf(path).find((node) => node['@type'] === 'WebPage');
    expect(page?.url).toBe(url);
    expect(page?.['@id']).toBe(`${url}#webpage`);
    expect(page?.name).toBe(route.title);
    expect(page?.description).toBe(route.description);
    expect(page?.isPartOf).toEqual({ '@id': WEBSITE_ID });
    expect(page?.about).toEqual({ '@id': SOFTWARE_ID });
    expect(page?.publisher).toEqual({ '@id': ORGANIZATION_ID });
  });

  it('puts the change date on the WebPage node, and leaves it off when unknown', () => {
    const route = ROUTES.find((r) => r.path === '/pricing');
    if (!route) throw new Error('/pricing');
    const webPage = (dateModified?: string) =>
      (JSON.parse(pageStructuredData({ ...route, dateModified })) as { '@graph': Record<string, unknown>[] })[
        '@graph'
      ].find((node) => node['@type'] === 'WebPage');
    expect(webPage('2026-09-09')?.dateModified).toBe('2026-09-09');
    expect(webPage()).not.toHaveProperty('dateModified');
  });

  it.each(ROUTES.filter((r) => r.path !== '/').map((r) => [r.path] as const))(
    '%s has a Home > page breadcrumb',
    (path) => {
      const graph = graphOf(path);
      const crumbs = graph.find((node) => node['@type'] === 'BreadcrumbList');
      const items = crumbs?.itemListElement as Record<string, unknown>[];
      expect(items).toHaveLength(2);
      expect(items[0]).toMatchObject({ position: 1, name: 'Home', item: 'https://acruxcore.com/' });
      expect(items[1]).toMatchObject({ position: 2, item: `https://acruxcore.com${path}` });
      expect(String(items[1].name).length).toBeGreaterThan(0);
      const page = graph.find((node) => node['@type'] === 'WebPage');
      expect(page?.breadcrumb).toEqual({ '@id': crumbs?.['@id'] });
    },
  );

  // There is no /features index (it 302s to /#pillars), so a pillar page's
  // trail goes straight from Home to the pillar, named as the nav names it.
  it.each(FEATURE_LIST.map((f) => [f.slug, f] as const))('/features/%s is Home > its pillar name', (slug, feature) => {
    const crumbs = graphOf(`/features/${slug}`).find((node) => node['@type'] === 'BreadcrumbList');
    const items = crumbs?.itemListElement as Record<string, unknown>[];
    expect(items[1].name).toBe(feature.name);
  });

  it('gives the home page no breadcrumb', () => {
    expect(graphOf('/').some((node) => node['@type'] === 'BreadcrumbList')).toBe(false);
  });
});
