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
    // convention because the six copies live 600 lines apart.
    const queries = FEATURE_LIST.map((f) => f.primaryQuery.toLowerCase());
    expect(new Set(queries).size).toBe(queries.length);
  });
});
