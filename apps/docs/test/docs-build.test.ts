// Checks the built docs site (build/, from `npm run build`) after the blog moved
// to https://acruxcore.com/blog. Run after the build: `npm test`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import nodePath from 'node:path';
import {describe, it} from 'node:test';
import {BLOG_REDIRECTS, OLD_BLOG_RULES} from '../redirects.ts';

const BUILD = nodePath.resolve(import.meta.dirname, '..', 'build');

function read(relative: string): string {
  return fs.readFileSync(nodePath.join(BUILD, relative), 'utf8');
}

describe('docs build without the blog', () => {
  it('has no blog pages', () => {
    assert.equal(fs.existsSync(nodePath.join(BUILD, 'blog')), false);
    assert.equal(fs.existsSync(nodePath.join(BUILD, 'blog.html')), false);
  });

  it('keeps serving the blog images that published articles embed', () => {
    assert.ok(fs.existsSync(nodePath.join(BUILD, 'img/blog')));
  });

  it('lists no blog URL in the sitemap or llms.txt', () => {
    assert.doesNotMatch(read('sitemap.xml'), /docs\.acruxcore\.com\/blog/);
    assert.doesNotMatch(read('llms.txt'), /docs\.acruxcore\.com\/blog/);
  });

  it('links the navbar to the blog on the main domain', () => {
    assert.match(read('index.html'), /href=["']?https:\/\/acruxcore\.com\/blog\/["' >]/);
  });

  it('301s every old blog URL to the new host in one hop', () => {
    const lines = read('_redirects').trim().split('\n');
    // The two splat rules come last, so every specific rule above them wins.
    assert.deepEqual(lines.slice(-OLD_BLOG_RULES.length), [...OLD_BLOG_RULES]);
    const firstSplat = lines.length - OLD_BLOG_RULES.length;
    for (const {from, to} of BLOG_REDIRECTS) {
      for (const source of [from, `${from}/`]) {
        const index = lines.indexOf(`${source} https://acruxcore.com${to} 301`);
        assert.ok(index >= 0 && index < firstSplat, `${source} -> ${to}`);
      }
    }
  });
});
