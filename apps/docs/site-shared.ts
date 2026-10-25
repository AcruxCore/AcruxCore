import nodePath from 'node:path';
import type {HtmlTagObject} from '@docusaurus/types';
import {ORGANIZATION_ID} from './src/organization-id.ts';

export {ORGANIZATION_ID};

// Config pieces shared by the two Docusaurus sites built from this package:
// docusaurus.config.ts (docs.acruxcore.com) and docusaurus.blog.config.ts
// (acruxcore.com/blog). One copy each, so the two sites cannot drift apart on
// analytics consent, sitemap weighting or lastmod.

// Same measurement ID as the marketing site (see apps/web's GA4_MEASUREMENT_ID
// build arg) — GA4's default cookie domain covers every acruxcore.com
// subdomain, so one property sees both. Only baked in for a real production
// build (`docusaurus build`, not `docusaurus start`) and only when the
// GA4_MEASUREMENT_ID GitHub Actions secret is set (see .github/workflows/docs.yml),
// so local dev never reports traffic.
const GA4_MEASUREMENT_ID = process.env.GA4_MEASUREMENT_ID;
const GA4_ENABLED = Boolean(GA4_MEASUREMENT_ID) && process.env.NODE_ENV === 'production';

// Cookie name the consent banner (src/theme/Root.tsx) reads and writes. Must
// match apps/web/src/lib/analytics.ts's ANALYTICS_CONSENT_COOKIE exactly — the
// `.acruxcore.com` cookie domain is what lets a choice on one subdomain cover
// both, so an accept on the marketing site skips the prompt here too.
const CONSENT_COOKIE = 'acx_analytics_consent';

/**
 * The company's profiles elsewhere. Must equal the Organization `sameAs` in
 * apps/web/index.html; test/seo-build.test.ts compares the two.
 */
const ORGANIZATION_SAME_AS = [
  'https://github.com/AcruxCore',
  'https://www.linkedin.com/company/acruxcore/',
  'https://x.com/AcruxCore',
  'https://www.youtube.com/@AcruxCoreAI',
  'https://www.reddit.com/r/AcruxCore/',
  'https://www.npmjs.com/package/@acruxcoreai/sdk',
  'https://pypi.org/project/acruxcore/',
];

/**
 * The Organization JSON-LD block, as a head tag.
 *
 * Repeated in full on every page (not only referenced by `@id`), because a
 * crawler reads one page at a time and only joins ids it can see on that page.
 * The logo is the 512px PNG the marketing site serves: Google ignores SVG
 * logos and wants a raster of at least 112px.
 *
 * @returns A head tag to spread into a config's `headTags`.
 */
export function organizationHeadTag(): HtmlTagObject {
  return {
    tagName: 'script',
    attributes: {type: 'application/ld+json'},
    innerHTML: JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Organization',
      '@id': ORGANIZATION_ID,
      name: 'AcruxCore',
      alternateName: 'Acrux Core',
      url: 'https://acruxcore.com/',
      logo: {
        '@type': 'ImageObject',
        url: 'https://acruxcore.com/brand/logo-512.png',
        width: 512,
        height: 512,
      },
      sameAs: ORGANIZATION_SAME_AS,
    }),
  };
}

/**
 * The GA4 bootstrap under Google Consent Mode v2, or nothing.
 *
 * `analytics_storage` defaults to denied until the visitor accepts the cookie
 * banner, or the shared `.acruxcore.com` consent cookie already says they did.
 * Empty unless this is a production build with GA4_MEASUREMENT_ID set.
 *
 * The consent default and the `js`/`config` commands are queued inline, first
 * thing. The gtag.js script itself (194 KiB) is only added after the window
 * `load` event, once the browser is idle, so it does not compete with the
 * page's own scripts during first render. It reads the queue in order when it
 * arrives, so nothing is lost; and it still loads before any consent choice,
 * because Consent Mode v2 sends cookieless pings while consent is denied. Same
 * timing as the marketing site (apps/web/src/lib/analytics.ts).
 *
 * @returns Head tags to spread into a config's `headTags`.
 */
export function analyticsHeadTags(): HtmlTagObject[] {
  return [
    ...(GA4_ENABLED
      ? [
          {
            tagName: 'script',
            attributes: {},
            innerHTML: `
              window.dataLayer = window.dataLayer || [];
              function gtag(){dataLayer.push(arguments);}
              gtag('consent', 'default', {
                analytics_storage: 'denied',
                ad_storage: 'denied',
                ad_user_data: 'denied',
                ad_personalization: 'denied',
                wait_for_update: 500
              });
              (function () {
                var m = document.cookie.match(/(?:^|; )${CONSENT_COOKIE}=(granted|denied)/);
                if (m && m[1] === 'granted') {
                  gtag('consent', 'update', { analytics_storage: 'granted' });
                }
              })();
              gtag('js', new Date());
              gtag('config', '${GA4_MEASUREMENT_ID}');
              (function () {
                function inject() {
                  var s = document.createElement('script');
                  s.async = true;
                  s.src = 'https://www.googletagmanager.com/gtag/js?id=${GA4_MEASUREMENT_ID}';
                  document.head.appendChild(s);
                }
                function idle() {
                  if (window.requestIdleCallback) window.requestIdleCallback(inject, {timeout: 2000});
                  else setTimeout(inject, 0);
                }
                if (document.readyState === 'complete') idle();
                else window.addEventListener('load', idle, {once: true});
              })();
            `,
          },
        ]
      : []),
  ] as HtmlTagObject[];
}

/**
 * Relative crawl weighting for one sitemap URL, most specific prefix first.
 *
 * The sitemap spec defines `priority` as a page's importance *relative to other
 * pages on the same site*, so the useful signal is the spread, not the absolute
 * numbers. Tutorials, guides and blog posts sit at the top because they are the
 * pages that answer a search query on their own; index and listing pages sit
 * below them because a searcher wants the article, not the table of contents;
 * API reference leaves sit lowest because they are terse curl blocks that rank
 * for almost nothing and there are 30-odd of them competing with the 40 pages
 * we do want crawled.
 *
 * `changefreq` is a hint about how often the content is rewritten: a published
 * post is essentially frozen once it ships, whereas the changelog gains a
 * section most weeks.
 *
 * @param path - Site-relative route path, always leading-slashed (`/blog/x`).
 * @returns The `priority` (0-1) and `changefreq` to emit for that route.
 */
export function classifySitemapRoute(path: string): {
  priority: number;
  changefreq: 'daily' | 'weekly' | 'monthly';
} {
  const rules: Array<[RegExp, number, 'daily' | 'weekly' | 'monthly']> = [
    // Landing page — the site's single most important URL.
    [/^\/$/, 1.0, 'weekly'],
    // Entry points a newcomer lands on and we actively want ranking.
    [/^\/docs\/getting-started\//, 0.9, 'weekly'],
    // The long-form pages that carry the site: each one is a standalone answer.
    [/^\/docs\/tutorials\/./, 0.9, 'monthly'],
    [/^\/docs\/guides\//, 0.9, 'monthly'],
    // Blog posts, but not the /blog index (matched below).
    [/^\/blog\/./, 0.8, 'monthly'],
    // SDK reference: valuable, but it mirrors what the guides already teach.
    [/^\/docs\/sdk-reference\//, 0.7, 'monthly'],
    // Gains an entry most weeks, so worth recrawling often despite being thin.
    [/^\/changelog$/, 0.7, 'weekly'],
    // Section landing pages — navigation, not answers.
    [/^\/(blog|docs\/tutorials|api-reference)$/, 0.6, 'weekly'],
    // API reference leaves.
    [/^\/api-reference\//, 0.5, 'monthly'],
  ];

  for (const [pattern, priority, changefreq] of rules) {
    if (pattern.test(path)) {
      return {priority, changefreq};
    }
  }
  // Anything new that lands outside the sections above: mid weight, so a page
  // added later is never silently demoted below the API reference.
  return {priority: 0.6, changefreq: 'weekly'};
}

/**
 * Fills in each sitemap item's `lastmod` from its page's last git commit.
 *
 * Docusaurus can do this itself, but the result is silently empty here. With
 * `future.v4` on, the active VCS strategy is the eager one, which preloads the
 * whole repository into a map keyed by **absolute** path — while the sitemap
 * plugin looks each page up by `sourceFilePath`, which is relative to the site
 * directory. In a single-package site those happen to agree often enough to
 * work; in this monorepo the site directory is `apps/docs`, so every lookup
 * misses. A miss returns `null` rather than raising, so the build stays green
 * and `<lastmod>` is simply absent from all 90 URLs — which is how this went
 * unnoticed. Resolving the path against the site directory first is the whole
 * fix; the same git data then comes back populated.
 *
 * Pages whose date cannot be resolved keep no `lastmod` at all: omitting the
 * field lets a crawler fall back to its own judgement, whereas a guessed date
 * actively misinforms it.
 *
 * @param items - Sitemap items already carrying url/priority/changefreq.
 * @param params - The plugin's `routes` (source of `sourceFilePath`) and
 *   `siteConfig` (source of the VCS strategy).
 * @returns The same items, each with `lastmod` set where git knew the date.
 * @throws {Error} In CI only, when not one page resolved a date — that means
 *   this workaround has broken (or the checkout is shallow) and the sitemap
 *   would ship without the one field Google reads. Locally it only warns, so
 *   building outside a git checkout still works.
 */
export async function addLastmod<T extends {url: string; lastmod?: string | null}>(
  items: T[],
  params: {routes: readonly unknown[]; siteConfig: {url: string; future: unknown}},
): Promise<T[]> {
  // `experimental_vcs` is not in the public SiteConfig type, hence the cast.
  const vcs = (params.siteConfig.future as {
    experimental_vcs: {
      getFileLastUpdateInfo: (p: string) => Promise<{timestamp: number} | null>;
    };
  }).experimental_vcs;

  // Route paths are nested (a blog post sits under the /blog parent), and only
  // the leaves carry sourceFilePath — so walk the whole tree.
  const sourceFileByRoute = new Map<string, string>();
  const walk = (routes: readonly unknown[]): void => {
    for (const route of routes as Array<{
      path?: string;
      routes?: readonly unknown[];
      metadata?: {sourceFilePath?: string};
    }>) {
      if (route.path && route.metadata?.sourceFilePath) {
        sourceFileByRoute.set(route.path, route.metadata.sourceFilePath);
      }
      if (route.routes) {
        walk(route.routes);
      }
    }
  };
  walk(params.routes);

  const withLastmod = await Promise.all(
    items.map(async (item) => {
      // A date the content plugin already worked out wins. For a blog post that
      // is its `last_update.date` front matter, the date of its last content
      // change, which git cannot know: a sweep that only rewrites links is still
      // a commit.
      if (item.lastmod != null) {
        return item;
      }
      const routePath = item.url.slice(params.siteConfig.url.length) || '/';
      const sourceFilePath = sourceFileByRoute.get(routePath);
      if (!sourceFilePath) {
        return item;
      }
      // The absolute-path resolution that the plugin itself is missing.
      const info = await vcs.getFileLastUpdateInfo(
        nodePath.resolve(__dirname, sourceFilePath),
      );
      if (!info) {
        return item;
      }
      return {
        ...item,
        lastmod: new Date(info.timestamp).toISOString().split('T')[0],
      };
    }),
  );

  // Test the value, not the key: the plugin's own items always carry a
  // `lastmod` property, set to null when it could not work the date out.
  const resolved = withLastmod.filter((item) => item.lastmod != null).length;
  if (resolved === 0) {
    const message =
      `Sitemap: resolved 0 of ${items.length} lastmod dates. Either the ` +
      `Docusaurus VCS workaround in addLastmod has broken, or this build has ` +
      `no git history (docs.yml needs fetch-depth: 0).`;
    if (process.env.CI) {
      throw new Error(message);
    }
    console.warn(`[WARNING] ${message}`);
  }
  return withLastmod;
}

/**
 * Gives the blog index the date of its newest post.
 *
 * The index has no source file, so neither the blog plugin nor git can date it,
 * and it shipped with no `lastmod` at all. Its content is the list of posts, so
 * it changes exactly when a post does.
 *
 * @param items - Sitemap items, posts already carrying `lastmod`.
 * @param indexUrl - The index's absolute URL, with its trailing slash.
 * @returns The same items, the index dated to the newest post's `lastmod`.
 */
export function datedBlogIndex<T extends {url: string; lastmod?: string | null}>(
  items: T[],
  indexUrl: string,
): T[] {
  const newest = items
    .filter((item) => item.url !== indexUrl && item.lastmod)
    .map((item) => item.lastmod as string)
    .sort()
    .at(-1);
  return items.map((item) => (item.url === indexUrl && newest ? {...item, lastmod: newest} : item));
}

