import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ROUTES } from './entry-prerender';
import { FEATURE_LIST } from './features';

/**
 * What a search result can actually show. Google truncates by pixel width, not
 * by character count, so these are the conventional safe budgets rather than
 * hard limits: past them the tail of the string is invisible in a listing.
 *
 * These exist because every one of the six pillar descriptions had drifted to
 * 204–253 characters with nothing to catch it, which meant roughly the back
 * half of each was written for a reader who never saw it.
 */
const TITLE_MAX = 60;
const DESCRIPTION_MAX = 160;

/**
 * The floor is as real as the ceiling: a 60-character description wastes the
 * space, and Google is more likely to replace it with text of its own choosing.
 */
const DESCRIPTION_MIN = 90;

describe('prerendered head budgets', () => {
  it.each(ROUTES.map((r) => [r.path, r] as const))('%s has a description within budget', (_path, route) => {
    expect(route.description.length).toBeGreaterThanOrEqual(DESCRIPTION_MIN);
    expect(route.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
  });

  it.each(FEATURE_LIST.map((f) => [f.slug, f] as const))('%s has a title within budget', (_slug, feature) => {
    // Asserted for the commercial pillar pages only. The landing page's title
    // is the brand entity sentence, is already indexed, and is asserted against
    // index.html in structured-data.test.ts — it is 61 characters on purpose.
    expect(feature.metaTitle.length).toBeLessThanOrEqual(TITLE_MAX);
  });
});

describe('page titles', () => {
  it.each(ROUTES.filter((r) => r.path !== '/').map((r) => [r.path, r] as const))(
    '%s has a title within budget',
    (_path, route) => {
      expect(route.title.length).toBeLessThanOrEqual(TITLE_MAX);
    },
  );

  // "Pricing — AcruxCore" told a searcher nothing about what is being priced.
  it.each(['/pricing', '/about'])('%s names the product category in its title', (path) => {
    const route = ROUTES.find((r) => r.path === path);
    expect(route?.title).toMatch(/LLMOps/);
    expect(route?.title).toMatch(/AcruxCore/);
  });
});

/**
 * The prerendered `<title>` comes from ROUTES; the title the tab shows after
 * hydration comes from the page component (`useDocumentTitle` or the shell's
 * `docTitle`). Google renders JavaScript, so it can index the second one. When
 * they differ, the title in ROUTES is a title nobody sees.
 */
describe('client-side titles', () => {
  const pageSources = ROUTES.filter((r) => r.sourceFiles[0].startsWith('src/marketing/pages/')).map(
    (r) => [r.path, r, readFileSync(fileURLToPath(new URL(`../../${r.sourceFiles[0]}`, import.meta.url)), 'utf8')] as const,
  );

  it.each(pageSources)('%s sets the same title after hydration', (_path, route, source) => {
    const literal =
      source.match(/docTitle="([^"]+)"/)?.[1] ?? source.match(/useDocumentTitle\('([^']+)'\)/)?.[1];
    if (literal === undefined) return; // falls back to `${title} — AcruxCore`, checked by the shell
    expect(literal).toBe(route.title);
  });
});

/**
 * `prerender.mjs` leaves the landing page's head exactly as `index.html` has
 * it, so the description a search result shows for acruxcore.com is the one in
 * that file, not the one in ROUTES. They had drifted to 289 and 155
 * characters. One value now, checked here.
 */
describe('landing page description', () => {
  const indexHtml = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');

  it('matches the ROUTES entry, so it is held to the same budget', () => {
    const description = indexHtml.match(/<meta\s+name="description"\s+content="([^"]*)"/)?.[1];
    const landing = ROUTES.find((r) => r.path === '/');
    expect(description).toBe(landing?.description);
  });
});

describe('primary query placement', () => {
  it.each(FEATURE_LIST.map((f) => [f.slug, f] as const))(
    '%s carries its primary query in the title, h1 and description',
    (_slug, feature) => {
      const q = feature.primaryQuery.toLowerCase();
      expect(feature.metaTitle.toLowerCase()).toContain(q);
      expect(feature.title.toLowerCase()).toContain(q);
      expect(feature.metaDescription.toLowerCase()).toContain(q);
    },
  );

  it.each(FEATURE_LIST.map((f) => [f.slug, f] as const))(
    '%s leads its cross-link anchor text with the primary query',
    (_slug, feature) => {
      // `summary` renders inside the landing pillar card link and inside the
      // cross-link cards on the other five pillar pages, so it is the anchor
      // text 36 internal links point here with. The nav and footer can only
      // carry the short `name`, which makes this the one place the keyword can
      // reach an anchor without hurting the UI.
      expect(feature.summary.toLowerCase()).toContain(feature.primaryQuery.toLowerCase());
    },
  );

  it('gives each pillar page a distinct primary query', () => {
    // Two pages chasing one query split it. Kept as an assertion rather than a
    // convention because the seven copies live 900 lines apart.
    const queries = FEATURE_LIST.map((f) => f.primaryQuery.toLowerCase());
    expect(new Set(queries).size).toBe(queries.length);
  });
});
