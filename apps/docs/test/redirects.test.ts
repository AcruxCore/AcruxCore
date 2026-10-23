// Unit tests for the Cloudflare `_redirects` renderer and the redirect lists.
import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {renderRedirects} from '../plugins/cloudflare-redirects.ts';
import {BLOG_REDIRECTS, DOCS_REDIRECTS, REDIRECTS} from '../redirects.ts';

describe('renderRedirects', () => {
  it('writes both slash forms of each entry before any extra rule', () => {
    const lines = renderRedirects(
      [{from: '/blog/tags/x', to: 'https://acruxcore.com/blog/tags/y'}],
      ['/blog/* https://acruxcore.com/blog/:splat 301'],
    ).trim().split('\n');
    const plain = lines.indexOf('/blog/tags/x https://acruxcore.com/blog/tags/y 301');
    const slashed = lines.indexOf('/blog/tags/x/ https://acruxcore.com/blog/tags/y 301');
    const splat = lines.indexOf('/blog/* https://acruxcore.com/blog/:splat 301');
    assert.ok(plain > 0 && slashed > 0, lines.join('\n'));
    assert.ok(plain < splat && slashed < splat, 'retired entries must precede the splat');
    assert.equal(splat, lines.length - 1);
  });
});

describe('redirect lists', () => {
  it('splits every entry into exactly one of the blog and docs lists', () => {
    assert.equal(BLOG_REDIRECTS.length + DOCS_REDIRECTS.length, REDIRECTS.length);
    for (const entry of BLOG_REDIRECTS) assert.match(entry.from, /^\/blog\//);
    for (const entry of DOCS_REDIRECTS) assert.doesNotMatch(entry.from, /^\/blog\//);
    assert.ok(BLOG_REDIRECTS.length > 0);
  });
});
