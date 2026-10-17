/**
 * One retired URL and the page that now answers it.
 */
export interface RedirectEntry {
  /** Site-relative path that no longer has a page, e.g. `/blog/tags/langfuse`. */
  from: string;
  /** Site-relative path of a page that exists in the build. */
  to: string;
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
