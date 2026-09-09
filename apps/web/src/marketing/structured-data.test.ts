import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LANDING_TITLE } from './marketing-chrome';

/**
 * The two JSON-LD blocks live in `apps/web/index.html`, which the prerender
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

describe('index.html structured data', () => {
  it('parses every ld+json block as JSON', () => {
    const blocks = structuredData();

    expect(blocks).toHaveLength(2);
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
