import fs from 'node:fs/promises';
import nodePath from 'node:path';
import {DEFAULT_PARSE_FRONT_MATTER} from '@docusaurus/utils';
import type {LoadContext, Plugin} from '@docusaurus/types';

/**
 * One documentation page, as one line of the generated file.
 */
interface PageEntry {
  /** Absolute URL, e.g. `https://docs.acruxcore.com/docs/guides/version-a-prompt`. */
  url: string;
  /** Site-relative route path, used for matching and for featured-link lookup. */
  routePath: string;
  /** The page's `title` front matter, verbatim. */
  title: string;
  /** The page's `description` front matter, collapsed onto one line. */
  description: string;
  /** `sidebar_position` when the page declares one, otherwise `undefined`. */
  sidebarPosition?: number;
  /** `YYYY-MM-DD` parsed off a blog filename, otherwise `undefined`. */
  date?: string;
}

/**
 * One `## Heading` block of the generated file.
 */
interface SectionSpec {
  /** Text of the `##` heading. */
  heading: string;
  /** Sentence printed under the heading, before the list. */
  intro: string;
  /** True when a route belongs in this section. First match wins. */
  match: (routePath: string) => boolean;
  /** Ordering within the section. */
  sort: (a: PageEntry, b: PageEntry) => number;
}

/**
 * Pages worth reading first, in the order a newcomer should read them.
 *
 * Hand-picked on purpose: the rest of the file is generated, so without this
 * block every page would arrive at equal weight and the one page that answers
 * "what is this and how does it compare" would be buried among thirty guides.
 * A crawler that reads only the first section should still come away with the
 * measured comparison, the five-minute path to a first call, and the vocabulary.
 *
 * Each path is checked against the real route table at build time — see
 * {@link resolveFeatured} — so a renamed or deleted page fails the build
 * instead of shipping a broken pointer to every crawler that reads the file.
 */
const FEATURED_ROUTE_PATHS: readonly string[] = [
  '/blog/hands-on-llm-ops-comparison',
  '/docs/getting-started/quickstart',
  '/docs/getting-started/core-concepts',
  '/blog/full-cycle-latency-benchmark',
  '/docs/tutorials/build-a-tool-calling-agent-in-the-dashboard-no-code',
];

/** Sort helper: `sidebar_position` first, then title, for sidebar-ordered folders. */
function bySidebarPosition(a: PageEntry, b: PageEntry): number {
  const left = a.sidebarPosition ?? Number.MAX_SAFE_INTEGER;
  const right = b.sidebarPosition ?? Number.MAX_SAFE_INTEGER;
  return left === right ? a.title.localeCompare(b.title) : left - right;
}

/** Sort helper: newest first, for the blog. */
function byDateDescending(a: PageEntry, b: PageEntry): number {
  return (b.date ?? '').localeCompare(a.date ?? '');
}

/** Sort helper: alphabetical, for reference material with no meaningful order. */
function byTitle(a: PageEntry, b: PageEntry): number {
  return a.title.localeCompare(b.title);
}

/**
 * The file's sections, in output order. First matching section wins, so the
 * more specific prefixes must come before the broader ones.
 *
 * The API reference sits last under `## Optional`, which the llms.txt
 * convention defines as "skip these if you need a shorter context". That is the
 * right call for thirty-odd terse curl blocks: they answer a question a reader
 * already knows to ask, whereas the guides and tutorials above them teach what
 * to ask in the first place.
 */
const SECTIONS: readonly SectionSpec[] = [
  {
    heading: 'Getting started',
    intro: 'What AcruxCore is, the vocabulary, and a first traced call.',
    match: (p) => p.startsWith('/docs/getting-started/'),
    sort: bySidebarPosition,
  },
  {
    heading: 'Guides',
    intro:
      'One AcruxCore capability per page, start to finish, with the exact requests and the real output.',
    match: (p) => p.startsWith('/docs/guides/'),
    sort: bySidebarPosition,
  },
  {
    heading: 'Tutorials',
    intro:
      'End-to-end builds of something that exists outside AcruxCore — agents, assistants, analysts. Every one ships a runnable script and a notebook.',
    match: (p) => p.startsWith('/docs/tutorials'),
    sort: bySidebarPosition,
  },
  {
    heading: 'Benchmarks and comparisons',
    intro:
      'Measured write-ups and hands-on comparisons against other LLM-ops platforms. Every number comes from a script committed to the repository, and every competitor screenshot from a real run on that competitor.',
    match: (p) => p.startsWith('/blog/'),
    sort: byDateDescending,
  },
  {
    heading: 'SDK reference',
    intro: 'Every method and parameter in the two published SDKs.',
    match: (p) => p.startsWith('/docs/sdk-reference/'),
    sort: byTitle,
  },
  {
    heading: 'Optional',
    intro:
      'The REST API, one page per domain. Every endpoint here was verified with curl against a running server, and each entry shows the exact request and the exact response it returned.',
    match: (p) => p === '/api-reference' || p.startsWith('/api-reference/'),
    sort: byTitle,
  },
];

/**
 * Route paths that carry a source file but should never appear in the file.
 *
 * The blog listing, tag and author pages are navigation over content that is
 * already listed line by line below, and the changelog is a single page that
 * grows a section every week — a crawler reading a snapshot of it learns less
 * than it would from the guide the change is described in.
 */
const EXCLUDED_ROUTE_PATTERNS: readonly RegExp[] = [
  /^\/$/,
  /^\/blog\/?$/,
  /^\/blog\/(tags|authors|archive|page)(\/|$)/,
  /^\/changelog$/,
];

/**
 * Collapses a front matter description onto one line.
 *
 * A `description` may be written as a folded or multi-line YAML scalar, and a
 * newline inside a Markdown list item would end the item early — turning the
 * rest of the sentence into a stray paragraph in the middle of a link list.
 *
 * @param value - The raw description string from front matter.
 * @returns The same text with all runs of whitespace collapsed to single spaces.
 */
function toSingleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Walks the built route tree, pairing every leaf route with its source file.
 *
 * Routes nest — a blog post sits under the `/blog` parent — and only the leaves
 * carry `sourceFilePath`, so the whole tree has to be walked rather than just
 * its top level. This mirrors the same walk in `docusaurus.config.ts`'s
 * `addLastmod`, for the same reason.
 *
 * @param routes - The plugin API's `routes`, of unknown shape at the type level.
 * @returns Route path to source file path (relative to the site directory).
 */
function collectSourceFiles(routes: readonly unknown[]): Map<string, string> {
  const sourceFileByRoute = new Map<string, string>();
  const walk = (nodes: readonly unknown[]): void => {
    for (const route of nodes as Array<{
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
  walk(routes);
  return sourceFileByRoute;
}

/**
 * Reads one page's front matter and turns it into an entry, or skips it.
 *
 * @param routePath - Site-relative route path, always leading-slashed.
 * @param sourceFilePath - Source file path, relative to the site directory.
 * @param siteDir - Absolute path of the Docusaurus site directory.
 * @param siteUrl - Site origin, with no trailing slash.
 * @returns The entry, or `null` when the page has no `title` or no
 *   `description` — an untitled line teaches a crawler nothing, and a
 *   description-less one is exactly the page that needed the summary most.
 */
async function readEntry(
  routePath: string,
  sourceFilePath: string,
  siteDir: string,
  siteUrl: string,
): Promise<PageEntry | null> {
  const absolutePath = nodePath.resolve(siteDir, sourceFilePath);
  const fileContent = await fs.readFile(absolutePath, 'utf8');
  const {frontMatter} = await DEFAULT_PARSE_FRONT_MATTER({
    filePath: absolutePath,
    fileContent,
  });

  const title = frontMatter.title;
  const description = frontMatter.description;
  if (typeof title !== 'string' || typeof description !== 'string') {
    return null;
  }

  // Blog dates live in the filename (`2026-07-12-slug.md`), not front matter.
  const dateMatch = /(\d{4}-\d{2}-\d{2})/.exec(nodePath.basename(sourceFilePath));

  return {
    url: `${siteUrl}${routePath}`,
    routePath,
    title: toSingleLine(title),
    description: toSingleLine(description),
    sidebarPosition:
      typeof frontMatter.sidebar_position === 'number'
        ? frontMatter.sidebar_position
        : undefined,
    date: dateMatch?.[1],
  };
}

/**
 * Resolves {@link FEATURED_ROUTE_PATHS} against the pages that actually exist.
 *
 * @param entries - Every page collected from the route tree.
 * @returns The featured entries, in the order they are listed in the constant.
 * @throws {Error} When a featured path matches no real route. The whole point
 *   of this file is to hand crawlers a short list of URLs worth fetching, so a
 *   featured link that 404s is worse than no featured list at all — and because
 *   nothing else references these paths, a rename would otherwise break them
 *   silently.
 */
function resolveFeatured(entries: readonly PageEntry[]): PageEntry[] {
  const byRoutePath = new Map(entries.map((entry) => [entry.routePath, entry]));
  const missing: string[] = [];
  const featured: PageEntry[] = [];

  for (const routePath of FEATURED_ROUTE_PATHS) {
    const entry = byRoutePath.get(routePath);
    if (entry) {
      featured.push(entry);
    } else {
      missing.push(routePath);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `llms.txt: ${missing.length} featured page(s) no longer exist: ` +
        `${missing.join(', ')}. Update FEATURED_ROUTE_PATHS in ` +
        `plugins/llms-txt.ts to point at the pages that replaced them.`,
    );
  }
  return featured;
}

/** Renders one entry as an llms.txt list item. */
function renderEntry(entry: PageEntry): string {
  return `- [${entry.title}](${entry.url}): ${entry.description}`;
}

/**
 * Builds the complete file contents.
 *
 * @param entries - Every page collected from the route tree.
 * @param siteUrl - Site origin, with no trailing slash.
 * @returns The full text of `llms.txt`, newline-terminated.
 * @throws {Error} When a featured page is missing, via {@link resolveFeatured}.
 */
function renderLlmsTxt(entries: readonly PageEntry[], siteUrl: string): string {
  const lines: string[] = [
    '# AcruxCore',
    '',
    '> AcruxCore is an open-source platform for teams building on LLMs: version your' +
      ' prompts, route every model call through one OpenAI-compatible gateway, trace' +
      ' what happened, catalog the tools your models can call, evaluate the result, and' +
      ' read an audit trail of every change a person made. Apache 2.0, self-hostable,' +
      ' with published SDKs for Python and TypeScript.',
    '',
    'The gateway sits in the request path, so a trace records the request that was' +
      ' actually sent rather than a copy reported alongside it. That is the design' +
      ' decision most of these pages come back to.',
    '',
    'This documentation is Apache 2.0 and free to use, quote, and train on. Pages are' +
      ' written to be read in full: guides and tutorials each carry the real commands' +
      ' and the real output from a run against a live server, and every benchmark links' +
      ' the script that produced its numbers.',
    '',
    `The product site is ${siteUrl.replace('docs.', '')}. The source is at` +
      ' https://github.com/AcruxCore/AcruxCore.',
    '',
    '## Start here',
    '',
    'The shortest path to understanding what AcruxCore does and how it compares.',
    '',
  ];

  for (const entry of resolveFeatured(entries)) {
    lines.push(renderEntry(entry));
  }

  const claimed = new Set<string>();
  for (const section of SECTIONS) {
    const sectionEntries = entries
      .filter((entry) => !claimed.has(entry.routePath) && section.match(entry.routePath))
      .sort(section.sort);
    if (sectionEntries.length === 0) {
      continue;
    }
    for (const entry of sectionEntries) {
      claimed.add(entry.routePath);
    }

    lines.push('', `## ${section.heading}`, '', section.intro, '');
    for (const entry of sectionEntries) {
      lines.push(renderEntry(entry));
    }
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Emits `/llms.txt` — a Markdown index of the site written for AI crawlers.
 *
 * Why generate rather than commit a static file: the site is 60-odd pages that
 * gain a guide or a post most weeks, and a hand-maintained index would be
 * stale within a month of the last person who remembered to edit it. Every
 * title and description here is read from the page's own front matter at build
 * time, which the docs site already requires on every page, so the index cannot
 * drift from what it indexes. Curation survives in two places that generation
 * cannot supply: the ordered {@link SECTIONS} and the hand-picked
 * {@link FEATURED_ROUTE_PATHS}.
 *
 * The file is written straight into the build output rather than `static/`
 * because `static/` is copied verbatim and would need the same manual upkeep
 * this plugin exists to remove.
 *
 * @param context - Docusaurus load context, for `siteDir` and `siteConfig.url`.
 * @returns The plugin, whose only hook is `postBuild`.
 * @throws {Error} During `postBuild`, when a featured page no longer exists, or
 *   when no page at all could be collected — either means the route metadata
 *   this reads has changed shape and the file would ship empty.
 */
export default function llmsTxtPlugin(context: LoadContext): Plugin<void> {
  const siteUrl = context.siteConfig.url.replace(/\/$/, '');

  return {
    name: 'acruxcore-llms-txt',

    async postBuild({routes, outDir}) {
      const sourceFileByRoute = collectSourceFiles(routes);

      const collected = await Promise.all(
        [...sourceFileByRoute].map(async ([routePath, sourceFilePath]) => {
          if (EXCLUDED_ROUTE_PATTERNS.some((pattern) => pattern.test(routePath))) {
            return null;
          }
          return readEntry(routePath, sourceFilePath, context.siteDir, siteUrl);
        }),
      );

      const entries = collected.filter((entry): entry is PageEntry => entry !== null);
      if (entries.length === 0) {
        throw new Error(
          'llms.txt: collected 0 pages from the route tree. The route metadata ' +
            'shape this reads (route.metadata.sourceFilePath) has probably changed.',
        );
      }

      await fs.writeFile(
        nodePath.join(outDir, 'llms.txt'),
        renderLlmsTxt(entries, siteUrl),
        'utf8',
      );
      console.log(`[llms.txt] Indexed ${entries.length} pages.`);
    },
  };
}
