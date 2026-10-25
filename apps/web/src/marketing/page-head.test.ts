import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { noindexShell } from './page-head';
import { renderNotFound } from './entry-prerender';

const template = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');

describe('noindexShell', () => {
  const html = noindexShell(template, 'Page not found — AcruxCore');

  it('says noindex in the HTML itself, not only in a header', () => {
    expect(html).toMatch(/<meta name="robots" content="noindex" \/>/);
    expect(html).not.toMatch(/content="index, follow/);
  });

  it('does not claim to be the landing page', () => {
    expect(html).not.toMatch(/rel="canonical"/);
    expect(html).not.toMatch(/property="og:url"/);
  });

  it('sets its own title', () => {
    expect(html).toMatch(/<title>Page not found — AcruxCore<\/title>/);
  });

  it('throws when the template no longer has a robots meta to replace', () => {
    expect(() => noindexShell('<html><head></head></html>', 'x')).toThrow(/robots/);
  });
});

describe('renderNotFound', () => {
  it('renders the 404 page markup for prerendering', () => {
    expect(renderNotFound()).toContain('That page does not exist.');
  });
});
