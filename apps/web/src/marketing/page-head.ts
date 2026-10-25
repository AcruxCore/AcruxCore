/**
 * Head rewrites the prerenderer applies to the shared `index.html` template.
 *
 * They live here, in TypeScript, rather than inline in `scripts/prerender.mjs`,
 * so a unit test can run them against the real template: a regex that stops
 * matching after someone edits `index.html` would otherwise ship a page that
 * looks fine and silently keeps the landing page's `index` and canonical.
 */

/**
 * Turns the landing-page template into the head of a page that must never be
 * indexed: the 404 page and the dashboard's app shell.
 *
 * Three things change. The robots meta says `noindex` in the HTML itself, so
 * the signal does not depend on nginx adding an `X-Robots-Tag` header (a header
 * is lost whenever a CDN or a self-hosted proxy rewrites the response). The
 * canonical link and `og:url` are removed, because both name `/`, and a page
 * that declares `/` as its canonical tells a crawler it is a duplicate of the
 * landing page. The title is replaced so a browser tab names the page.
 *
 * @param template - The built `dist/index.html`, before any page is rendered into it.
 * @param title - The `<title>` for this page.
 * @returns The rewritten HTML.
 * @throws {Error} When the template has no robots meta, canonical link or title
 *   to rewrite — the template changed shape and the result would be indexable.
 */
export function noindexShell(template: string, title: string): string {
  const steps: Array<[string, RegExp, string]> = [
    ['robots meta', /<meta\s+name="robots"\s+content="[^"]*"\s*\/>/, '<meta name="robots" content="noindex" />'],
    ['canonical link', /\s*<link\s+rel="canonical"\s+href="[^"]*"\s*\/>/, ''],
    ['og:url meta', /\s*<meta\s+property="og:url"\s+content="[^"]*"\s*\/>/, ''],
    ['title', /<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(title)}</title>`],
  ];
  let html = template;
  for (const [name, pattern, replacement] of steps) {
    if (!pattern.test(html)) {
      throw new Error(`noindexShell: the template has no ${name} to rewrite. Check apps/web/index.html.`);
    }
    html = html.replace(pattern, replacement);
  }
  return html;
}

/** Escapes text for an HTML text node. */
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
