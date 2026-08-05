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

const config: Config = {
  title: 'Acrux Core',
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
        name: 'Acrux Core',
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
        name: 'Acrux Core Docs',
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
          blogTitle: 'Acrux Core blog',
          blogDescription:
            'Comparisons, concepts, and release notes for the Acrux Core LLM-ops platform.',
          feedOptions: {
            type: ['rss', 'atom'],
            xslt: true,
            title: 'Acrux Core blog',
            description: 'LLM-ops articles and comparisons from the Acrux Core team.',
            copyright: `Copyright © ${new Date().getFullYear()} Acrux Core.`,
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
          changefreq: 'weekly',
          priority: 0.5,
          filename: 'sitemap.xml',
          // Blog tag pages are thin (1-3 post excerpts each with only 7 posts
          // total) — keep them navigable but out of what search engines crawl.
          // /search is already `noindex` (added by the local-search plugin);
          // listing a noindex page in the sitemap trips a Search Console
          // warning, so exclude it here too.
          ignorePatterns: ['/blog/tags/**', '/search'],
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
      title: 'Acrux Core',
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
          title: 'Acrux Core',
          items: [
            {label: 'Product site', href: 'https://acruxcore.com'},
            {label: 'Pricing', href: 'https://acruxcore.com/pricing'},
            {label: 'Contact', href: 'https://acruxcore.com/contact'},
            {label: 'Blog', to: '/blog'},
            {label: 'Changelog', to: '/changelog'},
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Acrux Core. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'json', 'python'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
