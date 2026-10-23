import fs from 'node:fs';
import nodePath from 'node:path';

/**
 * Lists the URL slug of every blog post, the way Docusaurus derives it.
 *
 * Front matter `slug:` wins; without one, the slug is the file or folder name
 * minus its `YYYY-MM-DD-` date prefix and extension. The tests use this as the
 * list of URLs that must exist on the new host and redirect from the old one,
 * so a post added later is covered without editing a list by hand.
 *
 * @param blogDir - Path to `apps/docs/blog`.
 * @returns One slug per post, without a leading slash.
 */
export function listBlogSlugs(blogDir: string): string[] {
  const slugs: string[] = [];
  for (const entry of fs.readdirSync(blogDir, {withFileTypes: true})) {
    if (!/^\d{4}-\d{2}-\d{2}-/.test(entry.name)) {
      continue;
    }
    const source = entry.isDirectory()
      ? ['index.md', 'index.mdx']
          .map((f) => nodePath.join(blogDir, entry.name, f))
          .find((p) => fs.existsSync(p))
      : nodePath.join(blogDir, entry.name);
    if (!source || !/\.mdx?$/.test(source)) {
      continue;
    }
    const frontMatter = fs.readFileSync(source, 'utf8').match(/^---\n([\s\S]*?)\n---/);
    const declared = frontMatter?.[1].match(/^slug:\s*['"]?([^'"\n]+?)['"]?\s*$/m)?.[1];
    slugs.push(
      (declared ?? entry.name.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.mdx?$/, ''))
        .replace(/^\//, ''),
    );
  }
  return slugs.sort();
}
