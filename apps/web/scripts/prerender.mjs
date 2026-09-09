// Bakes every public marketing page into its own dist/<route>/index.html.
//
// Runs after `vite build` (client) and `vite build --ssr` (server bundle). It
// imports the SSR `render()` + `ROUTES` from dist-ssr and, for each route,
// renders the page to an HTML string, swaps it into the <!--app-html--> marker,
// and patches the per-page <title>, description, and canonical/social URLs into
// the shared index.html head. Pure Node (no headless browser), so it runs
// identically in local builds and in the Docker deploy build.
// See src/marketing/entry-prerender.tsx.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE_ORIGIN = 'https://acruxcore.com';
const MARKER = '<!--app-html-->';

const { render, ROUTES, buildLlmsTxt } = await import(resolve(webRoot, 'dist-ssr/entry-prerender.js'));

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

/**
 * Append a route's own JSON-LD block to the end of its <head>.
 *
 * The two blocks already in index.html (Organization, WebSite) describe the
 * site and are correct on every page, so they stay in the shared template. A
 * page-specific type — FAQPage on /faq — has to be added per route instead, or
 * it would claim every marketing page is that type.
 *
 * The payload is JSON produced by JSON.stringify, so the only sequence that can
 * break out of the script element is `</`, which cannot appear in valid JSON
 * outside a string and is escaped here for the case where it appears inside
 * one.
 */
function addStructuredData(html, route) {
  if (!route.structuredData) return html;
  const json = route.structuredData.replace(/<\//g, '<\\/');
  return html.replace(
    '</head>',
    `<script type="application/ld+json">${json}</script></head>`,
  );
}

for (const route of ROUTES) {
  const appHtml = render(route.path);
  const page = addStructuredData(patchHead(template, route), route).replace(MARKER, appHtml);
  const outPath = resolve(webRoot, 'dist', route.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, page);
  console.log(`Prerendered ${route.path} → dist/${route.out} (${appHtml.length} bytes).`);
}

console.log(`Prerendered ${ROUTES.length} marketing route(s).`);

// --- sitemap.xml -----------------------------------------------------------
//
// Generated from ROUTES rather than hand-written in public/. The hand-written
// copy had already drifted: /compare was missing entirely, and
// every <lastmod> was frozen at the day someone typed the file. Deriving the URL
// list from the same array that drives prerendering means a new page cannot be
// forgotten.
//
// `lastmod` is the only one of these fields Google reads — it schedules recrawls
// from it. priority and changefreq come from the route definition, for Bing and
// Yandex, which do read them.
//
// Dates come from git, with a committed cache as the fallback, because the
// production image is built WITHOUT git: `.dockerignore` excludes `.git` (it is
// several GB of history) and the builder never installs the binary. So:
//   - a build that can see git (local, or any CI checkout) reads the real dates
//     and rewrites PAGE_DATES_FILE when they have moved on;
//   - the Docker build, which cannot, reads that committed file.
// Committing a refreshed cache is therefore part of changing a marketing page —
// the build says so explicitly when it happens.
//
// A file with uncommitted edits dates to today rather than to its last commit
// (see `changeDate`), which is what makes the edit → build → commit flow produce
// a date that matches the content instead of trailing it by one commit. A page's
// date is the newest across every file it renders (see `routeLastmod`).
const PAGE_DATES_FILE = resolve(webRoot, 'src/marketing/page-dates.json');
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Today, as YYYY-MM-DD, in UTC — the same shape git's `%cs` produces. */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Last commit date of one file as YYYY-MM-DD, or null when git cannot say. */
function gitLastModified(relativePath) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cs', '--', relativePath], {
      cwd: webRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return DATE_PATTERN.test(out) ? out : null;
  } catch {
    // No git binary, no .git directory, or a clone too shallow to hold the file's
    // history — all three mean "ask the cache instead".
    return null;
  }
}

/** True when `relativePath` has edits git has not recorded yet. */
function hasUncommittedChanges(relativePath) {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--', relativePath], {
      cwd: webRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * The change date to advertise for one source file.
 *
 * An uncommitted edit dates to **today**, not to the last commit. Without that,
 * every local build stamped the cache with the date of the commit *before* the
 * change being built — so the committed `page-dates.json` (which is what the
 * git-less production image ships) was permanently one commit behind, and the
 * sitemap told crawlers a page was older than its content. The normal flow is
 * edit → build → commit both, and that now produces a date that matches.
 *
 * @param relativePath - Source file, relative to `apps/web`.
 * @returns `YYYY-MM-DD`, or null when neither git nor the working tree can say.
 */
function changeDate(relativePath) {
  if (hasUncommittedChanges(relativePath)) return today();
  return gitLastModified(relativePath);
}

const cachedDates = existsSync(PAGE_DATES_FILE)
  ? JSON.parse(readFileSync(PAGE_DATES_FILE, 'utf8'))
  : {};

// Keyed by source file, not by route, so several routes sharing a file (all five
// pillar pages share features.tsx) resolve it once and cannot disagree.
const resolvedDates = {};
for (const route of ROUTES) {
  if (!Array.isArray(route.sourceFiles) || route.sourceFiles.length === 0) {
    throw new Error(`Route ${route.path} has no sourceFiles. Fix it in src/marketing/entry-prerender.tsx.`);
  }
  for (const sourceFile of route.sourceFiles) {
    if (!existsSync(resolve(webRoot, sourceFile))) {
      throw new Error(
        `Route ${route.path} points at a sourceFile that does not exist: ${sourceFile}. ` +
          `Fix it in src/marketing/entry-prerender.tsx.`,
      );
    }
    if (resolvedDates[sourceFile]) continue;
    const date = changeDate(sourceFile) ?? cachedDates[sourceFile] ?? null;
    if (date) {
      resolvedDates[sourceFile] = date;
    }
  }
}

/**
 * A page's `<lastmod>`: the newest date among the files it renders, or null when
 * none of them resolved. Newest rather than the component's own date, because a
 * page whose copy lives elsewhere changes when that copy changes.
 */
function routeLastmod(route) {
  const dates = route.sourceFiles.map((f) => resolvedDates[f]).filter(Boolean);
  return dates.length > 0 ? dates.sort().at(-1) : null;
}

const undated = ROUTES.filter((route) => !routeLastmod(route));
if (undated.length > 0) {
  // Never guess a date: a wrong one actively misinforms a crawler, whereas an
  // absent one just leaves it to its own judgement. But do say so loudly,
  // because it means the cache is incomplete and needs a git-capable build.
  console.warn(
    `[WARNING] No lastmod date for ${undated.length} page(s): ${undated
      .map((r) => r.path)
      .join(', ')}. Run this build where git history is available, then commit ` +
      `src/marketing/page-dates.json.`,
  );
}

const sitemap = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...ROUTES.map((route) => {
    const lastmod = routeLastmod(route);
    return [
      '  <url>',
      `    <loc>${SITE_ORIGIN}${route.path}</loc>`,
      ...(lastmod ? [`    <lastmod>${lastmod}</lastmod>`] : []),
      `    <changefreq>${route.changefreq}</changefreq>`,
      `    <priority>${route.priority.toFixed(1)}</priority>`,
      '  </url>',
    ].join('\n');
  }),
  '</urlset>',
  '',
].join('\n');

writeFileSync(resolve(webRoot, 'dist/sitemap.xml'), sitemap);

// Refresh the cache only when git actually answered, so a git-less build can
// never overwrite good dates with nothing.
const refreshed = JSON.stringify(resolvedDates, null, 2) + '\n';
if (Object.keys(resolvedDates).length > 0 && refreshed !== JSON.stringify(cachedDates, null, 2) + '\n') {
  writeFileSync(PAGE_DATES_FILE, refreshed);
  console.log('Updated src/marketing/page-dates.json — commit it so the Docker build ships these dates.');
}

console.log(
  `Wrote dist/sitemap.xml with ${ROUTES.length} URL(s), ${ROUTES.length - undated.length} carrying a lastmod date.`,
);

// --- llms.txt --------------------------------------------------------------
//
// A Markdown index of the site for AI crawlers and answer engines, generated
// from the same ROUTES array as the sitemap for the same reason: a hand-written
// copy in public/ goes stale the first time a page is added or renamed, and
// nothing fails when it does. buildLlmsTxt throws when a route has no section
// or a section names a route that no longer exists, so the two cannot disagree
// past a build. The curation — section order, and a one-line summary per page —
// stays hand-written in src/marketing/llms-txt.ts.
const llmsTxt = buildLlmsTxt(ROUTES, SITE_ORIGIN);
writeFileSync(resolve(webRoot, 'dist/llms.txt'), llmsTxt);
console.log(`Wrote dist/llms.txt (${llmsTxt.length} bytes, ${ROUTES.length} page(s) indexed).`);
