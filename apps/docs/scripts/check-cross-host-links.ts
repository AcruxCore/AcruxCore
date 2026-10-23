// Checks the links between the docs build and the blog build.
//
// Each Docusaurus build fails on its own broken links, but only within itself:
// once the blog moved to https://acruxcore.com/blog (cross-cutting FAQ Q129),
// docs -> blog and blog -> docs links became absolute URLs on another host,
// and neither build checks those. This does, against the two build folders.
//
// Usage: node --experimental-strip-types scripts/check-cross-host-links.ts build build-blog
import fs from 'node:fs';
import nodePath from 'node:path';
import {fileURLToPath} from 'node:url';

const BLOG_ORIGIN = 'https://acruxcore.com/blog';
const DOCS_ORIGIN = 'https://docs.acruxcore.com';

/** Every `.html` file under `dir`, recursively. */
function htmlFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, {recursive: true, encoding: 'utf8'})
    .filter((file) => file.endsWith('.html'))
    .map((file) => nodePath.join(dir, file));
}

/**
 * True when a built site would serve `path`.
 *
 * Mirrors how Cloudflare Pages resolves a request against static files: the
 * exact file (`rss.xml`, an image), `<path>.html`, or `<path>/index.html`.
 */
function servesPath(buildDir: string, path: string): boolean {
  const clean = path.replace(/^\/+|\/+$/g, '');
  const candidates = clean === '' ? ['index.html'] : [clean, `${clean}.html`, `${clean}/index.html`];
  return candidates.some((candidate) => {
    const file = nodePath.join(buildDir, candidate);
    return fs.existsSync(file) && fs.statSync(file).isFile();
  });
}

/**
 * Finds links from one build to the other that point at a page the other build
 * does not have.
 *
 * Fragments and query strings are dropped before matching: a missing anchor is
 * not a 404, and the target build has no notion of query strings.
 *
 * @param docsBuild - The docs build folder (`build/`), served at docs.acruxcore.com.
 * @param blogBuild - The blog build folder (`build-blog/`), served at acruxcore.com/blog.
 * @returns One `"<source file> -> <url>"` line per broken link, the source file
 *   relative to the parent of the two folders. Empty when every link resolves.
 */
export function findBrokenCrossHostLinks(docsBuild: string, blogBuild: string): string[] {
  const directions = [
    {from: docsBuild, to: blogBuild, origin: BLOG_ORIGIN},
    {from: blogBuild, to: docsBuild, origin: DOCS_ORIGIN},
  ];
  const root = nodePath.dirname(nodePath.resolve(docsBuild));
  const broken = new Set<string>();

  for (const {from, to, origin} of directions) {
    // Attribute values may be unquoted in minified output.
    const pattern = new RegExp(
      `href=["']?(${origin.replace(/[.]/g, '\\.')}(?:[/?#][^"' >]*)?)["' >]`,
      'g',
    );
    for (const file of htmlFiles(from)) {
      for (const [, url] of fs.readFileSync(file, 'utf8').matchAll(pattern)) {
        const path = url.slice(origin.length).replace(/[?#].*$/, '');
        if (!servesPath(to, path)) {
          broken.add(`${nodePath.relative(root, file)} -> ${url}`);
        }
      }
    }
  }
  return [...broken];
}

// Run as a script (not when the test imports findBrokenCrossHostLinks).
if (process.argv[1] && nodePath.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [docsBuild, blogBuild] = process.argv.slice(2);
  if (!docsBuild || !blogBuild) {
    console.error('usage: check-cross-host-links.ts <docs build dir> <blog build dir>');
    process.exit(2);
  }
  const broken = findBrokenCrossHostLinks(docsBuild, blogBuild);
  if (broken.length > 0) {
    console.error(`${broken.length} broken link(s) between the docs and the blog:`);
    for (const line of broken) console.error(`  ${line}`);
    process.exit(1);
  }
  console.log('Every link between the docs and the blog resolves.');
}
