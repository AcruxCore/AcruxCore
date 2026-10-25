/**
 * One retired URL and the page that now answers it.
 */
export interface RedirectEntry {
  /** Site-relative path that no longer has a page, e.g. `/blog/tags/langfuse`. */
  from: string;
  /**
   * Site-relative path of a page that exists in the build, or an absolute
   * `https://` URL when the page now lives on the other host — a blog post
   * that moved into the docs points at `https://docs.acruxcore.com/docs/…`.
   */
  to: string;
}

/** Origin of the blog since it moved to the main domain (cross-cutting FAQ Q129). */
export const BLOG_ORIGIN = 'https://acruxcore.com';

/** Origin of the docs site, the target of a blog post that moved into the docs. */
export const DOCS_ORIGIN = 'https://docs.acruxcore.com';

/**
 * Turns a retired blog entry's `to` into the absolute URL the old docs host
 * redirects to.
 *
 * The docs host still answers the old `docs.acruxcore.com/blog/…` URLs, but it
 * has no blog pages, so every target must name a host. A site-relative `to` is
 * a blog page and gets the blog's origin. An absolute `to` already names its
 * page (a post that moved into the docs) and is kept as it is, so the old URL
 * reaches it in one hop rather than going through the blog host first.
 *
 * @param to - An entry's `to`: a site-relative path, or an absolute `https://` URL.
 * @returns The absolute URL to write into the docs host's `_redirects`.
 */
export function blogTargetFromDocsHost(to: string): string {
  return to.startsWith('/') ? `${BLOG_ORIGIN}${to}` : to;
}

/**
 * Every retired URL on the docs site, in one list read by two consumers.
 *
 * `@docusaurus/plugin-client-redirects` turns each entry into an HTML page that
 * jumps with a meta refresh, which works on any host and under `docusaurus
 * serve`. `plugins/cloudflare-redirects.ts` writes the same entries into
 * `_redirects`, which Cloudflare Pages answers with a real HTTP 301 before the
 * HTML page is ever reached. A 301 is what search engines, link checkers and
 * social-preview bots follow reliably; a meta refresh is only a fallback. One
 * list keeps the two from drifting apart.
 *
 * These pages are linked from published articles, notebooks and social posts
 * we cannot edit, so a 404 would strand a real reader.
 */
export const REDIRECTS: readonly RedirectEntry[] = [
  // A guide that merged into another keeps its old URL working.
  { from: '/docs/guides/build-and-attach-a-tool', to: '/docs/guides/create-a-tool' },
  {
    from: '/docs/guides/define-a-tool-in-code-or-in-the-catalog',
    to: '/docs/guides/create-a-tool',
  },
  {
    from: '/docs/guides/manage-a-tools-lifecycle-via-the-sdk',
    to: '/docs/guides/version-and-track-a-tool',
  },
  {
    from: '/docs/guides/alias-and-track-usage-of-tools-in-the-catalog',
    to: '/docs/guides/version-and-track-a-tool',
  },
  // A blog post that toured only our own dashboard. The blog compares and
  // measures, so the tour moved into the docs; six posts and outside articles
  // link the old URL.
  {
    from: '/blog/acruxcore-hands-on-walkthrough',
    to: `${DOCS_ORIGIN}/docs/getting-started/dashboard-tour`,
  },
  // Tags removed from blog/tags.yml as thin pages. Search Console still
  // showed them in results, so each points at the page that now holds
  // its intent: a competitor tag goes to that competitor's comparison
  // post (the page the tag used to compete with), a topic tag to the
  // closest of the five tags that remain.
  ...[
    ['comparison', '/blog/tags/llmops-comparison'],
    ['walkthrough', '/blog/tags/llmops-comparison'],
    ['llm-ops', '/blog'],
    ['gateway', '/blog/tags/llm-gateway'],
    ['byok', '/blog/tags/llm-gateway'],
    ['performance', '/blog/tags/llm-latency'],
    ['tracing', '/blog/tags/llm-tracing'],
    ['tools', '/blog/tags/llm-tracing'],
    ['sdk', '/blog/tool-agent-sdk-langchain-vs-acruxcore'],
    ['langsmith', '/blog/acrux-core-vs-langsmith'],
    ['langfuse', '/blog/acruxcore-vs-langfuse'],
    ['helicone', '/blog/acruxcore-vs-helicone'],
    ['opik', '/blog/acruxcore-vs-opik'],
    ['phoenix', '/blog/acruxcore-vs-phoenix'],
    ['mlflow', '/blog/acruxcore-vs-mlflow'],
    ['promptlayer', '/blog/promptlayer-hands-on-walkthrough'],
  ].map(([tag, to]) => ({ from: `/blog/tags/${tag}`, to })),
];

/**
 * The entries under `/blog/`: tag pages and posts retired from the blog.
 *
 * The blog is also built on its own for https://acruxcore.com/blog (see
 * docusaurus.blog.config.ts), and that build serves these from its own
 * `_redirects`, so a retired tag 301s on the blog's host too.
 */
export const BLOG_REDIRECTS: readonly RedirectEntry[] = REDIRECTS.filter((entry) =>
  entry.from.startsWith('/blog/'),
);

/** Every entry that is not under `/blog/` — the docs site's own retired pages. */
export const DOCS_REDIRECTS: readonly RedirectEntry[] = REDIRECTS.filter(
  (entry) => !entry.from.startsWith('/blog/'),
);

/**
 * The whole old blog tree on docs.acruxcore.com, sent to acruxcore.com/blog.
 *
 * The blog moved to the main domain (cross-cutting FAQ Q129) with the same
 * slugs, so one splat covers every post, tag, page and feed. Written last into
 * `_redirects`: Pages applies the first rule that matches, and a retired tag
 * must hit its own entry (one hop to its final page) before this splat would
 * send it to a tag page that itself redirects. The index goes to `/blog/` with
 * the slash, its one canonical form.
 *
 * Every other blog URL has no trailing slash, and the new host 308s a slashed
 * one. The placeholder rules strip the slash here instead, so `/blog/x/` is
 * still one hop. Tags, pages and authors sit at most three segments deep.
 */
export const OLD_BLOG_RULES: readonly string[] = [
  '/blog https://acruxcore.com/blog/ 301',
  '/blog/:a/ https://acruxcore.com/blog/:a 301',
  '/blog/:a/:b/ https://acruxcore.com/blog/:a/:b 301',
  '/blog/:a/:b/:c/ https://acruxcore.com/blog/:a/:b/:c 301',
  '/blog/* https://acruxcore.com/blog/:splat 301',
];
