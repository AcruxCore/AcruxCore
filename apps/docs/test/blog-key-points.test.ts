// Every blog post carries at least one "> **Key point:**" quote, which
// plugins/remark-blog-blocks.ts renders as the post's highlighted crux, and the
// built page shows it as one. Run after the build: `npm test`.
//
// A key point restates a fact the post already gives; it adds no new claim. See
// cross-cutting FAQ Q138.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import nodePath from 'node:path';
import {describe, it} from 'node:test';

const SITE_DIR = nodePath.resolve(import.meta.dirname, '..');
const BLOG_DIR = nodePath.join(SITE_DIR, 'blog');
const BUILD = nodePath.join(SITE_DIR, 'build-blog');
const KEY_POINT = /^> \*\*Key point:\*\* \S/m;

const posts = fs
  .readdirSync(BLOG_DIR)
  .filter((file) => /^\d{4}-\d{2}-\d{2}-.+\.mdx?$/.test(file))
  .map((file) => {
    const source = fs.readFileSync(nodePath.join(BLOG_DIR, file), 'utf8');
    const slug = source.match(/^slug:\s*(\S+)/m)?.[1];
    return {file, source, slug};
  });

describe('blog key points', () => {
  it('found posts to check', () => {
    assert.ok(posts.length >= 20, `only ${posts.length} posts found`);
  });

  for (const {file, source, slug} of posts) {
    it(`${file} has a key point, rendered as a crux`, () => {
      assert.match(source, KEY_POINT, 'add a "> **Key point:** …" quote that restates a fact from the post');
      assert.ok(slug, 'no slug in front matter');
      const html = fs.readFileSync(nodePath.join(BUILD, `${slug}.html`), 'utf8');
      assert.match(html, /<blockquote[^>]*class=["']?[^"'>]*acx-crux/, 'the build shows no acx-crux blockquote');
    });
  }
});
