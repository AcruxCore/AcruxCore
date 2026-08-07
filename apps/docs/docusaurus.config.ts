import nodePath from 'node:path';
import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

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
function classifySitemapRoute(path: string): {
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
async function addLastmod<T extends {url: string; lastmod?: string | null}>(
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

const config: Config = {
  title: 'AcruxCore',
  tagline: 'Version prompts, route LLM calls, trace and evaluate — one platform.',
  favicon: 'img/favicon.ico',

  future: {
    v4: true, // Improve compatibility with the upcoming Docusaurus v4
  },

  // Production URL of the docs site (custom domain — see apps/docs/DEPLOY.md).
  url: 'https://docs.acruxcore.com',
  baseUrl: '/',
  trailingSlash: false,

  organizationName: 'talhaanwarch',
  projectName: 'acruxcore',

  // 'throw' is the primary CI gate — a dead internal link fails the build.
  onBrokenLinks: 'throw',

  // Site-wide structured data (Organization + WebSite) for richer search results,
  // plus (when enabled) the GA4 bootstrap under Google Consent Mode v2:
  // `analytics_storage` defaults to denied until the visitor accepts the
  // cookie banner, or the shared consent cookie already says they did.
  headTags: [
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
            `,
          },
          {
            tagName: 'script',
            attributes: {async: 'true', src: `https://www.googletagmanager.com/gtag/js?id=${GA4_MEASUREMENT_ID}`},
          },
        ]
      : []),
    {
      tagName: 'script',
      attributes: {type: 'application/ld+json'},
      innerHTML: JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Organization',
        name: 'AcruxCore',
        url: 'https://docs.acruxcore.com',
        description:
          'LLM-ops platform: version prompts, route LLM calls through a gateway, trace every request, catalog tools, and evaluate quality.',
      }),
    },
    {
      tagName: 'script',
      attributes: {type: 'application/ld+json'},
      innerHTML: JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        name: 'AcruxCore Docs',
        url: 'https://docs.acruxcore.com',
      }),
    },
  ],

  // `.mdx` files always get full MDX/JSX. `.md` files (blog, tutorials) stay
  // as CommonMark so literal `{...}` JSON in curl examples is safe.
  markdown: {
    format: 'detect',
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          // Tutorials + Getting Started live here, served under /docs.
          sidebarPath: './sidebars.ts',
        },
        blog: {
          showReadingTime: true,
          blogTitle: 'AcruxCore blog',
          blogDescription:
            'Comparisons, concepts, and release notes for the AcruxCore LLM-ops platform.',
          feedOptions: {
            type: ['rss', 'atom'],
            xslt: true,
            title: 'AcruxCore blog',
            description: 'LLM-ops articles and comparisons from the AcruxCore team.',
            copyright: `Copyright © ${new Date().getFullYear()} AcruxCore.`,
          },
          onInlineTags: 'warn',
          onInlineAuthors: 'warn',
          onUntruncatedBlogPosts: 'warn',
          // Default caps the "Recent posts" sidebar at 5, silently dropping our
          // oldest posts from every blog page's navigation even though /blog
          // itself lists all of them. 'ALL' keeps the sidebar a full catalog
          // as the blog grows past what fits on one page.
          blogSidebarCount: 'ALL',
        },
        theme: {
          customCss: './src/css/custom.css',
        },
        sitemap: {
          filename: 'sitemap.xml',
          // `lastmod` is the one field in a sitemap that Google actually reads —
          // it uses it to schedule recrawls (changefreq and priority are
          // ignored; see classifySitemapRoute). It is off by default in
          // Docusaurus 3, so our sitemap shipped with no freshness signal at
          // all, which is the likeliest reason new tutorials and posts sat
          // unindexed.
          //
          // Setting it here only picks the date-only format (YYYY-MM-DD) — the
          // values themselves are computed in createSitemapItems below, because
          // the plugin's own lookup silently returns nothing in a monorepo. See
          // addLastmod for the details.
          //
          // Values come from each page's last git commit, so
          // .github/workflows/docs.yml must check out full history
          // (fetch-depth: 0). With the default shallow clone every file reports
          // the deploy date, so every page would look changed on every deploy —
          // worse than sending nothing.
          lastmod: 'date',
          // Blog tag pages are thin (1-3 post excerpts each with only 7 posts
          // total) — keep them navigable but out of what search engines crawl.
          // /search is already `noindex` (added by the local-search plugin);
          // listing a noindex page in the sitemap trips a Search Console
          // warning, so exclude it here too. The rest are pagination, author
          // and auto-generated category pages: they carry no text of their own
          // beyond excerpts and links that already appear on the pages we do
          // list, so listing them spends crawl budget we would rather spend on
          // tutorials, guides and posts.
          ignorePatterns: [
            '/blog/tags/**',
            '/search',
            '/blog/archive',
            '/blog/authors/**',
            '/blog/page/**',
            '/docs/category/**',
          ],
          // Google ignores both changefreq and priority (the plugin's own types
          // say so, citing facebook/docusaurus#2604), so this is not what gets
          // a page indexed — lastmod above is. It is still worth setting
          // because Bing and Yandex do read them, and because the spec defines
          // priority as *relative*: one flat 0.5 across every URL tells a
          // crawler nothing about what matters here.
          createSitemapItems: async ({defaultCreateSitemapItems, ...rest}) => {
            const items = await defaultCreateSitemapItems(rest);
            const weighted = items.map((item) => {
              const routePath =
                item.url.slice(rest.siteConfig.url.length) || '/';
              return {...item, ...classifySitemapRoute(routePath)};
            });
            return addLastmod(weighted, rest);
          },
        },
      } satisfies Preset.Options,
    ],
  ],

  // Second docs instance: the API reference, sourced from the symlinked
  // repo `docs/api/` (single source of truth, curl-verified). Served at
  // /api-reference so it gets a clean top-level URL for SEO.
  plugins: [
    [
      '@docusaurus/plugin-content-docs',
      {
        id: 'api',
        // Point directly at the repo's curl-verified API docs (single source of
        // truth — no copy, no drift). A relative path is used rather than a
        // symlink because Docusaurus's mdx-loader keys page metadata by resolved
        // path; a symlink whose target resolves outside the plugin dir loses that
        // metadata and crashes SSG.
        path: '../../docs/api',
        routeBasePath: 'api-reference',
        sidebarPath: './sidebarsApi.ts',
      },
    ],
  ],

  themes: [
    [
      '@easyops-cn/docusaurus-search-local',
      {
        hashed: true,
        indexBlog: true,
        indexDocs: true,
        docsRouteBasePath: ['docs', 'api-reference'],
        highlightSearchTermsOnTargetPage: true,
      },
    ],
  ],

  themeConfig: {
    image: 'img/social-card.png',
    metadata: [
      {
        name: 'keywords',
        content:
          'llm ops, prompt management, ai gateway, llm tracing, prompt versioning, llm evaluation, tool catalog, openai compatible gateway',
      },
    ],
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      // The mark is an <img>, which CSS custom properties cannot cross, so the
      // accent has to be baked in — hence a separate file per colour mode.
      logo: {
        alt: '',
        src: 'img/logo.svg',
        srcDark: 'img/logo-dark.svg',
        width: 26,
        height: 23,
      },
      title: 'AcruxCore',
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'tutorialSidebar',
          position: 'left',
          label: 'Tutorials',
        },
        {to: '/api-reference', label: 'API Reference', position: 'left'},
        {to: '/blog', label: 'Blog', position: 'left'},
        {to: '/changelog', label: 'Changelog', position: 'left'},
        // AcruxCore/AcruxCore was private until 2026-08-03, so this used to 404 for
        // every visitor and was left out. It is public now.
        {href: 'https://github.com/AcruxCore/AcruxCore', label: 'Open Source', position: 'left'},
        {href: 'https://acruxcore.com', label: 'acruxcore.com', position: 'right'},
        {
          href: 'https://acruxcore.com/signup',
          label: 'Start free',
          position: 'right',
          className: 'navbar-cta',
        },
      ],
    },
    socialLinks: [
      { type: 'linkedin', href: 'https://www.linkedin.com/company/acruxcore/' },
      { type: 'twitter', href: 'https://x.com/AcruxCore' },
      { type: 'youtube', href: 'https://www.youtube.com/@AcruxCoreAI' },
    ],
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            {label: 'Quickstart', to: '/docs/getting-started/quickstart'},
            {label: 'Core concepts', to: '/docs/getting-started/core-concepts'},
            {label: 'API Reference', to: '/api-reference'},
          ],
        },
        {
          title: 'Guides',
          items: [
            {label: 'Version a prompt', to: '/docs/guides/version-a-prompt'},
            {label: 'Use the gateway', to: '/docs/guides/route-calls-through-the-gateway'},
            {label: 'Trace a call', to: '/docs/guides/trace-an-llm-call'},
          ],
        },
        {
          title: 'AcruxCore',
          items: [
            {label: 'Product site', href: 'https://acruxcore.com'},
            {label: 'Pricing', href: 'https://acruxcore.com/pricing'},
            {label: 'Contact', href: 'https://acruxcore.com/contact'},
            {label: 'Blog', to: '/blog'},
            {label: 'Changelog', to: '/changelog'},
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} AcruxCore. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'json', 'python'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
