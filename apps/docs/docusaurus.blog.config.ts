import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import {
  addLastmod,
  analyticsHeadTags,
  classifySitemapRoute,
  datedBlogIndex,
  ORGANIZATION_ID,
  organizationHeadTag,
} from './site-shared';
import remarkUnescapeImageAlt from './plugins/remark-unescape-image-alt';
import remarkHeroImage from './plugins/remark-hero-image';
import {GENERATED_STATIC_DIR} from './plugins/blog-hero-image';
import {BLOG_REDIRECTS} from './redirects';
import {blogHeaderRules} from './plugins/cloudflare-headers';

// The blog, built on its own and served at https://acruxcore.com/blog/.
//
// It lives on the main domain rather than docs.acruxcore.com so the links and
// search signals the posts earn strengthen acruxcore.com itself; see
// docs/superpowers/specs/cross-cutting/2026-10-23-blog-to-main-domain-design.md
// and cross-cutting FAQ Q129. Same package and same src/theme as the docs site,
// so the consent banner, the swizzled blog layout and the CSS are shared.
//
// Build: `npm run build:blog` writes build-blog/ with files at its root. CI nests
// that under blog/ before deploying it to the `acruxcore-blog` Pages project, so
// the path on Pages is the same as the public path (see DEPLOY.md).

const BLOG_URL = 'https://acruxcore.com/blog/';
const DOCS_URL = 'https://docs.acruxcore.com';

const config: Config = {
  title: 'AcruxCore',
  tagline: 'Version prompts, route LLM calls, trace and evaluate — one platform.',
  favicon: 'img/favicon.ico',

  future: {
    v4: true,
  },

  url: 'https://acruxcore.com',
  // Must end in "/": it is also the prefix of every asset, which keeps the
  // blog's /blog/assets/ clear of the marketing site's Vite /assets/.
  baseUrl: '/blog/',
  trailingSlash: false,

  organizationName: 'talhaanwarch',
  projectName: 'acruxcore',

  onBrokenLinks: 'throw',

  // static-generated/ holds the smaller copies of each post's hero image, written
  // by scripts/blog-image-variants.ts before every build (see prebuild:blog).
  staticDirectories: ['static', GENERATED_STATIC_DIR],

  headTags: [
    ...analyticsHeadTags(),
    // The same Organization entity as acruxcore.com; each post's BlogPosting
    // names it as publisher by @id (src/theme/BlogPostPage/StructuredData).
    organizationHeadTag(),
    {
      tagName: 'script',
      attributes: {type: 'application/ld+json'},
      innerHTML: JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        name: 'AcruxCore Blog',
        url: BLOG_URL,
        publisher: {'@id': ORGANIZATION_ID},
      }),
    },
  ],

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
        docs: false,
        pages: false,
        blog: {
          // The blog is the whole site here, so it sits at the base URL itself:
          // a post's path is /blog/<slug>, the same slug it had on the docs host.
          routeBasePath: '/',
          remarkPlugins: [remarkUnescapeImageAlt, [remarkHeroImage, {siteDir: __dirname, baseUrl: '/blog/'}]],
          showReadingTime: true,
          // A post's "last updated" date, shown under the post and emitted as
          // dateModified in its BlogPosting JSON-LD and as its sitemap lastmod.
          // It comes from the post's own `last_update.date` front matter, which
          // test/blog-dates-and-hero.test.ts requires on every post. Git is only the
          // fallback: one sweep that rewrote a link in every post once re-dated 23
          // of 26 posts to the same day.
          showLastUpdateTime: true,
          // The list page's <title> is "<blogTitle> | AcruxCore", and the
          // swizzled BlogListPage shows it as the page's H1, so it names the
          // topic rather than repeating the brand.
          blogTitle: 'LLMOps comparisons and benchmarks',
          blogDescription:
            'Hands-on comparisons of LLMOps platforms, latency benchmarks run against real providers, and how to self-host LLM observability.',
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
          blogSidebarCount: 'ALL',
        },
        theme: {
          customCss: './src/css/custom.css',
        },
        sitemap: {
          filename: 'sitemap.xml',
          lastmod: 'date',
          // Same reasoning as the docs sitemap: listing and tag pages carry no
          // text of their own, and /search is noindex.
          ignorePatterns: [
            '/blog/tags/**',
            '/blog/archive',
            '/blog/authors/**',
            '/blog/page/**',
          ],
          createSitemapItems: async ({defaultCreateSitemapItems, ...rest}) => {
            const items = await defaultCreateSitemapItems(rest);
            const weighted = items.map((item) => {
              const routePath = item.url.slice(rest.siteConfig.url.length) || '/';
              return {...item, ...classifySitemapRoute(routePath.replace(/\/$/, ''))};
            });
            return datedBlogIndex(await addLastmod(weighted, rest), BLOG_URL);
          },
        },
      } satisfies Preset.Options,
    ],
  ],

  plugins: [
    // Retired tag pages that still show in search results keep a 301 here, on
    // the blog's own host; see redirects.ts.
    ['./plugins/cloudflare-redirects.ts', {redirects: BLOG_REDIRECTS}],
    // Pages reads _headers only at the project root, and the deploy nests this
    // build under blog/ — so every path here carries the /blog prefix, and CI
    // moves the file to the root (docs.yml). No security headers: the blog is
    // reached through the marketing site's nginx, which adds them.
    ['./plugins/cloudflare-headers.ts', {rules: blogHeaderRules()}],
    // Same generated llms.txt as the docs site, at /blog/llms.txt, listing
    // every post on this host.
    [
      './plugins/llms-txt.ts',
      {
        featuredRoutePaths: ['/blog/hands-on-llm-ops-comparison', '/blog/full-cycle-latency-benchmark'],
      },
    ],
  ],

  // No local search here. @easyops-cn/docusaurus-search-local's SearchBar calls
  // the docs plugin's hooks unconditionally, and a docs-less build cannot give
  // it one (an empty docs instance is a build error). The blog sidebar lists
  // every post and the tag pages group them, which covers ~30 posts.

  themeConfig: {
    image: 'img/social-card.png',
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      logo: {
        alt: '',
        src: 'img/logo.svg',
        srcDark: 'img/logo-dark.svg',
        width: 26,
        height: 23,
        href: 'https://acruxcore.com',
      },
      title: 'AcruxCore',
      items: [
        {href: `${DOCS_URL}/docs/getting-started/quickstart`, label: 'Docs', position: 'left', target: '_self', className: 'navbar-sister-site'},
        {href: `${DOCS_URL}/api-reference`, label: 'API Reference', position: 'left', target: '_self', className: 'navbar-sister-site'},
        {to: '/', label: 'Blog', position: 'left', activeBaseRegex: '.*'},
        {href: `${DOCS_URL}/changelog`, label: 'Changelog', position: 'left', target: '_self', className: 'navbar-sister-site'},
        {href: 'https://github.com/AcruxCore/AcruxCore', label: 'Open Source', position: 'left'},
        {
          href: 'https://acruxcore.com/signup',
          label: 'Start free',
          position: 'right',
          className: 'navbar-cta navbar-sister-site',
          target: '_self',
        },
      ],
    },
    socialLinks: [
      {type: 'linkedin', href: 'https://www.linkedin.com/company/acruxcore/'},
      {type: 'twitter', href: 'https://x.com/AcruxCore'},
      {type: 'youtube', href: 'https://www.youtube.com/@AcruxCoreAI'},
    ],
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            {label: 'Quickstart', href: `${DOCS_URL}/docs/getting-started/quickstart`},
            {label: 'Core concepts', href: `${DOCS_URL}/docs/getting-started/core-concepts`},
            {label: 'API Reference', href: `${DOCS_URL}/api-reference`},
          ],
        },
        {
          title: 'AcruxCore',
          items: [
            {label: 'Product site', href: 'https://acruxcore.com'},
            {label: 'Pricing', href: 'https://acruxcore.com/pricing'},
            {label: 'Contact', href: 'https://acruxcore.com/contact'},
            {label: 'Changelog', href: `${DOCS_URL}/changelog`},
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
