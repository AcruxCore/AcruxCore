// Unit tests for the Cloudflare `_redirects` renderer and the redirect lists.
import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {renderRedirects} from '../plugins/cloudflare-redirects.ts';
import {BLOG_REDIRECTS, DOCS_REDIRECTS, OLD_BLOG_RULES, REDIRECTS} from '../redirects.ts';

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

describe('old blog rules', () => {
  it('send the index and every path under /blog to the new host', () => {
    assert.deepEqual([...OLD_BLOG_RULES], [
      '/blog https://acruxcore.com/blog/ 301',
      // A trailing slash is dropped here, or the new host would add a second hop.
      '/blog/:a/ https://acruxcore.com/blog/:a 301',
      '/blog/:a/:b/ https://acruxcore.com/blog/:a/:b 301',
      '/blog/:a/:b/:c/ https://acruxcore.com/blog/:a/:b/:c 301',
      '/blog/* https://acruxcore.com/blog/:splat 301',
    ]);
  });
});
