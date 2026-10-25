// Checks a blog post's dates and its hero image, in the source and in the built
// blog (build-blog/, from `npm run build:blog`). Run after the build: `npm test`.
//
// Dates: a post's "last updated" date is its last content change, set by hand
// in front matter (`last_update.date`). It used to come from the last git
// commit, so one sweep that rewrote a link host in every post re-dated 23 of 26
// posts to the same day. See cross-cutting FAQ "Blog post dates".
//
// Hero: the header image is the Largest Contentful Paint on the index and on
// the post. It must load eagerly, at high priority, and from a copy sized for
// the screen.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import nodePath from 'node:path';
import {describe, it} from 'node:test';
import {findHeroImageUrl, variantUrl} from '../plugins/blog-hero-image.ts';

const SITE_DIR = nodePath.resolve(import.meta.dirname, '..');
const BLOG_DIR = nodePath.join(SITE_DIR, 'blog');
const BUILD = nodePath.join(SITE_DIR, 'build-blog');
const BLOG_URL = 'https://acruxcore.com/blog';

interface Post {
  file: string;
  slug: string;
  published: string;
  lastUpdate?: string;
  heroUrl: string | null;
}

/** Every post, with the dates and hero its source declares. */
function posts(): Post[] {
  return fs
    .readdirSync(BLOG_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}-.*\.mdx?$/.test(f))
    .sort()
    .map((file) => {
      const source = fs.readFileSync(nodePath.join(BLOG_DIR, file), 'utf8');
      const fm = source.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
      return {
        file,
        slug: fm.match(/^slug:\s*['"]?([^'"\n]+?)['"]?\s*$/m)?.[1] ?? file.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.mdx?$/, ''),
        published: fm.match(/^date:\s*(\d{4}-\d{2}-\d{2})/m)?.[1] ?? file.slice(0, 10),
        lastUpdate: fm.match(/^last_update:\s*\n\s+date:\s*(\d{4}-\d{2}-\d{2})\s*$/m)?.[1],
        heroUrl: findHeroImageUrl(source),
      };
    });
}

function read(relative: string): string {
  return fs.readFileSync(nodePath.join(BUILD, relative), 'utf8');
}

/**
 * The `<img>` tags in a page that show this hero. Matched on the path of its
 * smallest copy in `srcset`, which is unique to the post: several posts name
 * their header `01-header.webp`, in different folders.
 */
function heroTags(html: string, heroUrl: string): string[] {
  const copy = `/blog${variantUrl(heroUrl, 480)} `;
  return [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]).filter((tag) => tag.includes(copy));
}

const ALL = posts();
const today = new Date().toISOString().slice(0, 10);

describe('blog post dates, in the source', () => {
  for (const post of ALL) {
    it(`${post.file} declares last_update.date, between its publish date and today`, () => {
      assert.ok(post.lastUpdate, 'no last_update.date in front matter');
      assert.ok(post.lastUpdate >= post.published, `${post.lastUpdate} is before ${post.published}`);
      assert.ok(post.lastUpdate <= today, `${post.lastUpdate} is in the future`);
    });
  }
});

describe('blog post dates, in the build', () => {
  const sitemap = read('sitemap.xml');
  const lastmodOf = (url: string) =>
    sitemap.match(new RegExp(`<loc>${url}</loc><lastmod>([^<]+)</lastmod>`))?.[1];

  for (const post of ALL) {
    it(`${post.slug}: the sitemap, the JSON-LD and the page all show ${post.lastUpdate}`, () => {
      assert.equal(lastmodOf(`${BLOG_URL}/${post.slug}`), post.lastUpdate);
      const html = read(`${post.slug}.html`);
      assert.match(html, new RegExp(`"dateModified":"${post.lastUpdate}`));
      assert.match(html, new RegExp(`<time datetime=["']?${post.lastUpdate}`));
    });
  }

  it('dates the index /blog/ to its newest post', () => {
    const newest = ALL.map((p) => p.lastUpdate ?? '').sort().at(-1);
    assert.equal(lastmodOf(`${BLOG_URL}/`), newest);
  });
});

describe('blog hero images, in the build', () => {
  const withHero = ALL.filter((p) => p.heroUrl);

  it('found posts with a hero image', () => {
    assert.ok(withHero.length >= 5, `only ${withHero.length}`);
  });

  for (const post of withHero) {
    it(`${post.slug}: the hero loads eagerly, at high priority, with a srcset`, () => {
      const [tag] = heroTags(read(`${post.slug}.html`), post.heroUrl!);
      assert.ok(tag, 'hero <img> not found');
      assert.match(tag, /loading=["']?eager/);
      assert.match(tag, /fetchpriority=["']?high/);
      assert.ok(tag.includes(`/blog${variantUrl(post.heroUrl!, 800)} 800w`), tag);
      assert.match(tag, /sizes=/);
      assert.ok(fs.existsSync(nodePath.join(BUILD, variantUrl(post.heroUrl!, 800))), 'the 800w copy is not in the build');
    });
  }

  it('on the index, only the first post’s hero loads eagerly', () => {
    const html = read('index.html');
    const heroes = withHero.flatMap((p) => heroTags(html, p.heroUrl!));
    assert.ok(heroes.length >= 2, `${heroes.length} heroes on the index`);
    const eager = heroes.filter((t) => /loading=["']?eager/.test(t));
    assert.equal(eager.length, 1, eager.join('\n'));
    assert.match(eager[0], /fetchpriority=["']?high/);
    const firstImg = html.match(/<article[\s\S]*?(<img\b[^>]*>)/)?.[1] ?? '';
    assert.equal(firstImg, eager[0], 'the eager hero is not the first image on the page');
  });
});
