import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The two hosts are one product, and each serves its own static `robots.txt`.
 * Nothing at build time reads either file, so a crawler added to one and
 * forgotten on the other produces exactly the failure that is hardest to
 * notice: the marketing pitch is indexed, the documentation that backs it up is
 * not, and both files look fine on their own.
 *
 * These tests also pin the two properties that matter more than the list
 * itself — no `Disallow`, and a `Sitemap` line — because the block these files
 * now spell out came from a `Disallow` nobody in this repository had written.
 */
const WEB_ROBOTS = readFileSync(
  fileURLToPath(new URL('../../public/robots.txt', import.meta.url)),
  'utf8',
);
const DOCS_ROBOTS = readFileSync(
  fileURLToPath(new URL('../../../docs/static/robots.txt', import.meta.url)),
  'utf8',
);

/** Strips comments and blank lines, leaving the directives a crawler acts on. */
function directives(robots: string): string[] {
  return robots
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

/** The user-agent tokens named in a robots.txt, lowercased as crawlers match them. */
function userAgents(robots: string): string[] {
  return directives(robots)
    .filter((line) => /^user-agent:/i.test(line))
    .map((line) => line.split(':')[1].trim().toLowerCase());
}

describe.each([
  ['apps/web/public/robots.txt', WEB_ROBOTS, 'https://acruxcore.com/sitemap.xml'],
  ['apps/docs/static/robots.txt', DOCS_ROBOTS, 'https://docs.acruxcore.com/sitemap.xml'],
])('%s', (_name, robots, sitemap) => {
  it('disallows nothing', () => {
    const disallows = directives(robots).filter((line) => /^disallow:\s*\S/i.test(line));
    expect(disallows).toEqual([]);
  });

  it('allows the wildcard group', () => {
    expect(userAgents(robots)).toContain('*');
    expect(directives(robots).filter((line) => /^allow:\s*\/$/i.test(line)).length).toBeGreaterThan(
      0,
    );
  });

  it('points at its own host’s sitemap', () => {
    expect(directives(robots)).toContain(`Sitemap: ${sitemap}`);
  });

  // A named group that opens and is never followed by a rule inherits nothing
  // from the wildcard — the crawler reads an empty group as "no restrictions",
  // which happens to be what we want, but only by accident. Make it explicit.
  it('follows every named group with an Allow', () => {
    const lines = directives(robots);
    for (const [index, line] of lines.entries()) {
      if (!/^user-agent:/i.test(line)) continue;
      const next = lines[index + 1];
      const ok = next !== undefined && (/^user-agent:/i.test(next) || /^allow:/i.test(next));
      expect(ok, `no rule after "${line}"`).toBe(true);
    }
  });
});

describe('robots.txt across both hosts', () => {
  // The whole point of naming crawlers explicitly is that the list is a
  // decision. A decision applied to one host and not the other is not one.
  it('names the same crawlers on the marketing site and the docs site', () => {
    expect(userAgents(WEB_ROBOTS).sort()).toEqual(userAgents(DOCS_ROBOTS).sort());
  });

  // The four that carry answer-engine traffic today. Named individually so that
  // dropping one is a failing test rather than a quiet edit to a list.
  it.each(['oai-searchbot', 'gptbot', 'perplexitybot', 'claude-searchbot'])(
    'allows %s on both hosts',
    (agent) => {
      expect(userAgents(WEB_ROBOTS)).toContain(agent);
      expect(userAgents(DOCS_ROBOTS)).toContain(agent);
    },
  );
});
