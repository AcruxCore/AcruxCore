// Bakes every public marketing page into its own dist/<route>/index.html.
//
// Runs after `vite build` (client) and `vite build --ssr` (server bundle). It
// imports the SSR `render()` + `ROUTES` from dist-ssr and, for each route,
// renders the page to an HTML string, swaps it into the <!--app-html--> marker,
// and patches the per-page <title>, description, and canonical/social URLs into
// the shared index.html head. Pure Node (no headless browser), so it runs
// identically in local builds and in the Docker deploy build.
// See src/marketing/entry-prerender.tsx.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE_ORIGIN = 'https://acruxcore.com';
const MARKER = '<!--app-html-->';

const { render, ROUTES } = await import(resolve(webRoot, 'dist-ssr/entry-prerender.js'));

const indexPath = resolve(webRoot, 'dist/index.html');
const template = readFileSync(indexPath, 'utf8');

if (!template.includes(MARKER)) {
  throw new Error(`Prerender marker "${MARKER}" not found in dist/index.html`);
}

/** Escape a string for safe insertion into an HTML attribute value. */
function attr(value) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Patch the per-page head fields into the shared template: <title>, the
 * description meta, and the canonical/og/twitter URLs and titles/descriptions.
 * The landing route ('/') keeps the template head verbatim.
 */
function patchHead(html, route) {
  if (route.path === '/') return html;
  const url = `${SITE_ORIGIN}${route.path}`;
  const t = attr(route.title);
  const d = attr(route.description);
  return html
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${t}</title>`)
    .replace(/(<meta\s+name="description"\s+content=")[\s\S]*?("\s*\/>)/, `$1${d}$2`)
    .replace(/(<link\s+rel="canonical"\s+href=")[^"]*("\s*\/>)/, `$1${url}$2`)
    .replace(/(<meta\s+property="og:title"\s+content=")[^"]*("\s*\/>)/, `$1${t}$2`)
    .replace(/(<meta\s+property="og:description"\s+content=")[^"]*("\s*\/>)/, `$1${d}$2`)
    .replace(/(<meta\s+property="og:url"\s+content=")[^"]*("\s*\/>)/, `$1${url}$2`)
    .replace(/(<meta\s+name="twitter:title"\s+content=")[^"]*("\s*\/>)/, `$1${t}$2`)
    .replace(/(<meta\s+name="twitter:description"\s+content=")[^"]*("\s*\/>)/, `$1${d}$2`);
}

for (const route of ROUTES) {
  const appHtml = render(route.path);
  const page = patchHead(template, route).replace(MARKER, appHtml);
  const outPath = resolve(webRoot, 'dist', route.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, page);
  console.log(`Prerendered ${route.path} → dist/${route.out} (${appHtml.length} bytes).`);
}

console.log(`Prerendered ${ROUTES.length} marketing route(s).`);
