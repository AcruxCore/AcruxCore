// Structured data, titles, share images and response headers of the built docs
// site (build/) and blog (build-blog/). Run after both builds: `npm test`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import nodePath from 'node:path';
import {describe, it} from 'node:test';
import {listBlogSlugs} from './blog-slugs.ts';

const SITE_DIR = nodePath.resolve(import.meta.dirname, '..');
const REPO = nodePath.resolve(SITE_DIR, '../..');
const DOCS = nodePath.join(SITE_DIR, 'build');
const BLOG = nodePath.join(SITE_DIR, 'build-blog');
const BLOG_URL = 'https://acruxcore.com/blog';
const ORG_ID = 'https://acruxcore.com/#org';
const slugs = listBlogSlugs(nodePath.join(SITE_DIR, 'blog'));

function read(root: string, relative: string): string {
  return fs.readFileSync(nodePath.join(root, relative), 'utf8');
}

type Node = Record<string, unknown>;

/** Every JSON-LD node on a page: top-level blocks plus the members of any @graph. */
function jsonLd(html: string): Node[] {
  const blocks = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)];
  assert.ok(blocks.length > 0, 'no JSON-LD on the page');
  return blocks.flatMap((m) => {
    const parsed = JSON.parse(m[1]) as Node;
    return Array.isArray(parsed['@graph']) ? (parsed['@graph'] as Node[]) : [parsed];
  });
}

function titleOf(html: string): string {
  return html.match(/<title[^>]*>([^<]*)<\/title>/)?.[1] ?? '';
}

function descriptionOf(html: string): string {
  return (
    html.match(/<meta[^>]*name=["']?description["']?[^>]*content="([^"]*)"/)?.[1] ??
    html.match(/<meta[^>]*name=["']?description["']?[^>]*content=([^ >]*)/)?.[1] ??
    ''
  );
}

/** sameAs of the marketing site's Organization, the list every host must repeat. */
function marketingSameAs(): string[] {
  const html = read(REPO, 'apps/web/index.html');
  const org = jsonLd(html).find((n) => n['@type'] === 'Organization');
  return org?.sameAs as string[];
}

function assertOrganization(html: string): void {
  const org = jsonLd(html).find((n) => n['@type'] === 'Organization');
  assert.ok(org, 'no Organization node');
  assert.equal(org['@id'], ORG_ID);
  assert.equal(org.url, 'https://acruxcore.com/');
  const logo = org.logo as Node;
  assert.match(String(logo.url), /^https:\/\/acruxcore\.com\/.+\.png$/);
  assert.deepEqual(org.sameAs, marketingSameAs());
}

describe('docs site structured data', () => {
  // The docs site carried its own, stripped Organization (no @id, no logo, no
  // sameAs, and a url on docs.), which read as a second company.
  it('describes the same Organization entity as acruxcore.com', () => {
    assertOrganization(read(DOCS, 'index.html'));
  });
});

describe('blog index', () => {
  const html = read(BLOG, 'index.html');

  it('has a visible H1', () => {
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1].replace(/<[^>]+>/g, '').trim();
    assert.ok(h1 && h1.length > 0, 'no <h1> on the blog index');
  });

  it('has a title that names the topic and the brand once', () => {
    const title = titleOf(html);
    assert.ok(title.length <= 60, title);
    assert.equal(title.match(/AcruxCore/g)?.length, 1, title);
    assert.match(title, /LLMOps/);
  });

  it('has a description within the 90-160 character budget', () => {
    const description = descriptionOf(html);
    assert.ok(description.length >= 90 && description.length <= 160, `${description.length}: ${description}`);
  });

  it('describes the same Organization entity as acruxcore.com', () => {
    assertOrganization(html);
  });
});

describe('blog posts', () => {
  for (const slug of slugs) {
    it(`/blog/${slug} has a publisher and a Home > Blog > post breadcrumb`, () => {
      const html = read(BLOG, `${slug}.html`);
      const nodes = jsonLd(html);
      const post = nodes.find((n) => n['@type'] === 'BlogPosting');
      assert.ok(post, 'no BlogPosting');
      assert.deepEqual(post.publisher, {'@id': ORG_ID});
      assertOrganization(html);

      const crumbs = nodes.find((n) => n['@type'] === 'BreadcrumbList');
      assert.ok(crumbs, 'no BreadcrumbList');
      const items = crumbs.itemListElement as Node[];
      assert.deepEqual(
        items.map((i) => [i.position, i.item]),
        [
          [1, 'https://acruxcore.com/'],
          [2, `${BLOG_URL}/`],
          [3, `${BLOG_URL}/${slug}`],
        ],
      );
      assert.equal(items[2].name, post.headline);
    });
  }

  it('keeps the latency benchmark title and description within budget', () => {
    const html = read(BLOG, 'full-cycle-latency-benchmark.html');
    assert.ok(titleOf(html).length <= 60, titleOf(html));
    assert.ok(descriptionOf(html).length <= 160, descriptionOf(html));
  });
});

describe('share card', () => {
  // Every docs page and most blog posts share this one file.
  it('is a 1200x630 PNG under 100 KB', () => {
    const bytes = fs.readFileSync(nodePath.join(SITE_DIR, 'static/img/social-card.png'));
    assert.equal(bytes.readUInt32BE(16), 1200);
    assert.equal(bytes.readUInt32BE(20), 630);
    assert.ok(bytes.length < 100_000, `${bytes.length} bytes`);
  });
});

describe('Cloudflare Pages _headers', () => {
  it('long-caches the content-hashed docs assets and sends HSTS and X-Frame-Options', () => {
    const headers = read(DOCS, '_headers');
    assert.match(headers, /^\/assets\/\*\n\s+Cache-Control: public, max-age=31536000, immutable$/m);
    assert.match(headers, /Strict-Transport-Security: max-age=31536000; includeSubDomains/);
    assert.match(headers, /X-Frame-Options: DENY/);
    assert.match(headers, /^\/llms\.txt\n\s+Content-Type: text\/markdown; charset=utf-8$/m);
  });

  // The blog is served through the marketing site's nginx, which adds the
  // security headers itself; Pages only needs the cache and type rules.
  it('long-caches the blog assets under /blog/ and leaves security headers to nginx', () => {
    const headers = read(BLOG, '_headers');
    assert.match(headers, /^\/blog\/assets\/\*\n\s+Cache-Control: public, max-age=31536000, immutable$/m);
    assert.match(headers, /^\/blog\/llms\.txt\n\s+Content-Type: text\/markdown; charset=utf-8$/m);
    assert.doesNotMatch(headers, /Strict-Transport-Security|X-Frame-Options/);
  });

  // Pages only reads _headers at the project root, and the blog deploy nests
  // the build under blog/ — so CI has to move it, as it does _redirects.
  it('is moved to the root of the blog deploy folder in CI', () => {
    const workflow = read(REPO, '.github/workflows/docs.yml');
    assert.match(workflow, /mv apps\/docs\/deploy-blog\/blog\/_headers apps\/docs\/deploy-blog\/_headers/);
  });
});
