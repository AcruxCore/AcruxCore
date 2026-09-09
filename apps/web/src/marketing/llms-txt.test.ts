import { describe, expect, it } from 'vitest';
import { buildLlmsTxt } from './llms-txt';
import { ROUTES, type PrerenderRoute } from './entry-prerender';

const ORIGIN = 'https://acruxcore.com';

/**
 * `/llms.txt` is generated at build time and read by nothing a person looks at,
 * so every way it can go wrong is silent: a page missing from the index, a link
 * to a route that was renamed, a relative URL that resolves against whatever
 * host the crawler happened to be on. The guards inside `buildLlmsTxt` throw for
 * the first two; these tests prove the guards fire, and check the shape of what
 * comes out when they do not.
 */
describe('buildLlmsTxt', () => {
  const output = buildLlmsTxt(ROUTES, ORIGIN);

  it('lists every prerendered route exactly once', () => {
    for (const route of ROUTES) {
      const url = `${ORIGIN}${route.path}`;
      const occurrences = output.split(`(${url})`).length - 1;
      expect(occurrences, `${route.path} appears ${occurrences} time(s)`).toBe(1);
    }
  });

  it('opens with the H1 and blockquote summary the convention expects', () => {
    const lines = output.split('\n');
    expect(lines[0]).toBe('# AcruxCore');
    expect(lines[2].startsWith('> ')).toBe(true);
  });

  // A model reading this file has no base URL to resolve against.
  it('makes every link absolute and https', () => {
    const links = [...output.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]);
    expect(links.length).toBeGreaterThan(ROUTES.length);
    for (const link of links) {
      expect(link, link).toMatch(/^https:\/\//);
    }
  });

  it('gives every list entry a summary after the link', () => {
    for (const line of output.split('\n').filter((l) => l.startsWith('- ['))) {
      expect(line, line).toMatch(/^- \[[^\]]+\]\(https:\/\/[^)]+\): \S.+$/);
    }
  });

  // "## Optional" is the one section heading the convention gives a meaning to:
  // everything under it can be dropped for a shorter context. Legal pages are
  // the only things here that qualify, and putting anything else there would
  // quietly tell a crawler to skip a page we want read.
  it('reserves the Optional section for the legal pages', () => {
    const optional = output.split('## Optional')[1] ?? '';
    const paths = [...optional.matchAll(/\]\(https:\/\/acruxcore\.com([^)]*)\)/g)].map((m) => m[1]);
    expect(paths.sort()).toEqual(['/privacy', '/terms']);
  });

  it('names the licence, the deployment model and the limitations up front', () => {
    const preamble = output.split('## ')[0];
    expect(preamble).toContain('Apache License 2.0');
    expect(preamble).toContain('self-hosted');
    expect(preamble.toLowerCase()).toContain('limitations');
  });

  // A model that reads only the preamble should still come away with the one
  // claim no competitor in the comparison matches, and with the distinction
  // that stops it reporting our traces as an audit log.
  it('states the audit trail and its price in the preamble', () => {
    // The preamble is written as one array entry per output line, so a phrase
    // straddles a newline as often as not. Assert against the prose, not the
    // line breaks.
    const preamble = output.split('## ')[0].replace(/\s+/g, ' ');
    expect(preamble).toMatch(/Audit trail:/);
    expect(preamble).toMatch(/every plan/);
    expect(preamble).toMatch(/needs no paid plan/);
    expect(preamble).toMatch(/different record from a trace/);
  });

  // Every capability page is a section in "What the platform does". A new one
  // throws in the builder; this says which list to add it to.
  it('lists every /features page under one heading', () => {
    const featurePaths = ROUTES.map((r) => r.path).filter((p) => p.startsWith('/features/'));
    expect(featurePaths).toContain('/features/audit');
    const section = output.split('## What the platform does')[1]?.split('\n## ')[0] ?? '';
    for (const path of featurePaths) {
      expect(section, `${path} is not under "What the platform does"`).toContain(
        `${ORIGIN}${path})`,
      );
    }
  });
});

describe('buildLlmsTxt guards', () => {
  /** A route object with only the fields the builder reads. */
  function route(path: string, title: string): PrerenderRoute {
    return { path, title } as PrerenderRoute;
  }

  it('throws when a route has no section', () => {
    expect(() => buildLlmsTxt([...ROUTES, route('/orphan', 'Orphan — AcruxCore')], ORIGIN)).toThrow(
      /no section for these routes: \/orphan/,
    );
  });

  it('throws when a section names a route that no longer exists', () => {
    const withoutFaq = ROUTES.filter((r) => r.path !== '/faq');
    expect(() => buildLlmsTxt(withoutFaq, ORIGIN)).toThrow(/no longer exist: \/faq/);
  });
});
