import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
});
