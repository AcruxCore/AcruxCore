import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import {BLOG_REDIRECTS, DOCS_REDIRECTS, OLD_BLOG_RULES} from './redirects';
import {addLastmod, analyticsHeadTags, classifySitemapRoute} from './site-shared';
import remarkUnescapeImageAlt from './plugins/remark-unescape-image-alt';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

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
    ...analyticsHeadTags(),
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
          remarkPlugins: [remarkUnescapeImageAlt],
        },
        // The blog moved to https://acruxcore.com/blog (docusaurus.blog.config.ts,
        // cross-cutting FAQ Q129). The posts and static/img/blog stay in this
        // package; this site only redirects the old URLs, see _redirects below.
        blog: false,
        pages: {
          remarkPlugins: [remarkUnescapeImageAlt],
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
            // The six guide-section indexes (docs/guides/<section>/_category_.json)
            // carry a `slug` so their URL reads as /docs/guides/<section> instead of
            // /docs/category/<section> — but a generated index is still just excerpts
            // and links that already appear on the guides it lists, the same reason
            // /docs/category/** is excluded above. Every guide's own page also sets
            // its own flat `slug: /guides/<name>` (not nested under its section), so
            // a bare `/docs/guides/*` would match the 29 real guides too — this
            // brace-alternation names exactly the six section slugs instead.
            '/docs/guides/{tools,prompts,gateway,traces,evaluation,team}',
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
        remarkPlugins: [remarkUnescapeImageAlt],
      },
    ],
    [
      '@docusaurus/plugin-client-redirects',
      // Meta-refresh fallback pages; see redirects.ts for why the same list
      // also feeds the Cloudflare `_redirects` plugin below.
      // Docs pages only: a meta refresh cannot cross hosts, so the old blog
      // URLs rely on the Cloudflare 301s alone.
      {redirects: [...DOCS_REDIRECTS]},
    ],
    // Writes `_redirects` so Cloudflare Pages serves a real 301 for every
    // retired URL in redirects.ts.
    // Retired blog tags point straight at their final page on the new host, so
    // they are one hop, and the splat that sends the rest of /blog there comes
    // last.
    [
      './plugins/cloudflare-redirects.ts',
      {
        redirects: [
          ...BLOG_REDIRECTS.map(({from, to}) => ({from, to: `https://acruxcore.com${to}`})),
          ...DOCS_REDIRECTS,
        ],
        extraRules: OLD_BLOG_RULES,
      },
    ],
    // Emits /llms.txt after the build — a Markdown index of every page, written
    // for the AI crawlers that reach the docs through an answer engine rather
    // than through search. Generated from each page's own front matter so it
    // cannot drift; see the module's own comment for what stays hand-curated.
    [
      './plugins/llms-txt.ts',
      {
        // The comparison and benchmark posts that used to head this list are
        // featured in https://acruxcore.com/blog/llms.txt now.
        featuredRoutePaths: [
          '/docs/getting-started/quickstart',
          '/docs/getting-started/core-concepts',
          '/docs/tutorials/build-a-tool-calling-agent-in-the-dashboard-no-code',
        ],
      },
    ],
  ],

  themes: [
    [
      '@easyops-cn/docusaurus-search-local',
      {
        hashed: true,
        indexBlog: false,
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
        {href: 'https://acruxcore.com/blog/', label: 'Blog', position: 'left', target: '_self', className: 'navbar-sister-site'},
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
            {label: 'Connect an MCP client', to: '/docs/guides/connect-an-mcp-client'},
          ],
        },
        {
          title: 'AcruxCore',
          items: [
            {label: 'Product site', href: 'https://acruxcore.com'},
            {label: 'Pricing', href: 'https://acruxcore.com/pricing'},
            {label: 'Contact', href: 'https://acruxcore.com/contact'},
            {label: 'Blog', href: 'https://acruxcore.com/blog/'},
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
