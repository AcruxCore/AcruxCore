// Checks the built blog (build-blog/, from `npm run build:blog`) against what
// acruxcore.com/blog has to serve. Run after the build: `npm test`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import nodePath from 'node:path';
import {describe, it} from 'node:test';
import {listBlogSlugs} from './blog-slugs.ts';
import {BLOG_REDIRECTS} from '../redirects.ts';

const SITE_DIR = nodePath.resolve(import.meta.dirname, '..');
const BUILD = nodePath.join(SITE_DIR, 'build-blog');
const BLOG_URL = 'https://acruxcore.com/blog';
const slugs = listBlogSlugs(nodePath.join(SITE_DIR, 'blog'));

function read(relative: string): string {
  return fs.readFileSync(nodePath.join(BUILD, relative), 'utf8');
}

// The build minifies HTML and drops attribute quotes where it can, so every
// pattern here accepts a value with or without quotes.
const VALUE = String.raw`["']?([^"' >]+)["']?`;

function canonicalOf(html: string): string | undefined {
  return html.match(new RegExp(`<link[^>]*rel=["']?canonical["']?[^>]*href=${VALUE}`))?.[1];
}

function attrValues(html: string, tagPattern: string, attr: string): string[] {
  const re = new RegExp(`<${tagPattern}[^>]*\\b${attr}=${VALUE}`, 'g');
  return [...html.matchAll(re)].map((m) => m[1]);
}

describe('blog build', () => {
  it('found posts to check', () => {
    assert.ok(slugs.length >= 20, `only ${slugs.length} slugs found`);
  });

  for (const slug of slugs) {
    it(`serves /blog/${slug} with an acruxcore.com canonical`, () => {
      const html = read(`${slug}.html`);
      assert.equal(canonicalOf(html), `${BLOG_URL}/${slug}`);
      assert.deepEqual(attrValues(html, `meta[^>]*property=["']?og:url["']?`, 'content'), [
        `${BLOG_URL}/${slug}`,
      ]);
      const hrefs = attrValues(html, 'a', 'href');
      assert.ok(hrefs.length > 10, `only ${hrefs.length} links parsed`);
      // A relative docs link would 404 on the blog's host.
      for (const href of hrefs) {
        assert.doesNotMatch(href, /^\/(docs|api-reference|changelog)(\/|#|$)/, href);
        // Blog-to-blog links keep the /blog prefix exactly once.
        assert.doesNotMatch(href, /^\/blog\/blog\//, href);
      }
      // A raw <img src="/img/..."> skips Docusaurus's asset handling and would
      // resolve against the marketing site, not the blog.
      for (const src of attrValues(html, 'img', 'src')) {
        if (!src.startsWith('http') && !src.startsWith('data:')) {
          assert.ok(src.startsWith('/blog/'), `image ${src}`);
        }
      }
      for (const src of attrValues(html, 'script', 'src')) {
        if (!src.startsWith('http')) assert.ok(src.startsWith('/blog/'), `script ${src}`);
      }
      for (const href of attrValues(html, `link[^>]*rel=["']?stylesheet["']?`, 'href')) {
        assert.ok(href.startsWith('/blog/'), `stylesheet ${href}`);
      }
    });
  }

  it('serves the index at /blog/', () => {
    assert.equal(canonicalOf(read('index.html')), `${BLOG_URL}/`);
  });

  it('lists every post, with lastmod, and nothing else, in the sitemap', () => {
    const sitemap = read('sitemap.xml');
    const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    for (const url of urls) assert.ok(url.startsWith(`${BLOG_URL}/`), url);
    for (const slug of slugs) assert.ok(urls.includes(`${BLOG_URL}/${slug}`), slug);
    // Posts carry lastmod from git; the generated index has no source file.
    for (const slug of slugs) {
      assert.match(sitemap, new RegExp(`<loc>${BLOG_URL}/${slug}</loc><lastmod>`), slug);
    }
  });

  it('points the feeds at the new host', () => {
    for (const feed of ['rss.xml', 'atom.xml']) {
      const xml = read(feed);
      const links = [...xml.matchAll(/<(?:link|id)>(https?:[^<]+)<\/(?:link|id)>/g)].map((m) => m[1]);
      // Docusaurus caps a feed at the newest 20 posts.
      assert.ok(links.length >= 20, `${feed} has ${links.length} links`);
      for (const link of links) assert.ok(link.startsWith(`${BLOG_URL}`), `${feed}: ${link}`);
    }
  });

  it('ships the blog images', () => {
    assert.ok(fs.existsSync(nodePath.join(BUILD, 'img/blog')));
  });

  it('writes an llms.txt that only lists the new host', () => {
    const urls = [...read('llms.txt').matchAll(/\]\((https?:[^)]+)\)/g)].map((m) => m[1]);
    assert.ok(urls.length >= slugs.length, `${urls.length} links`);
    for (const url of urls) {
      if (url.includes('acruxcore.com') && !url.includes('github.com')) {
        assert.ok(url.startsWith(`${BLOG_URL}/`), url);
      }
    }
  });

  it('301s every retired tag page on the blog host itself', () => {
    const rules = read('_redirects');
    for (const {from, to} of BLOG_REDIRECTS) {
      assert.ok(rules.includes(`${from} ${to} 301\n`), `${from} -> ${to}`);
      assert.ok(rules.includes(`${from}/ ${to} 301\n`), `${from}/ -> ${to}`);
    }
  });
});
