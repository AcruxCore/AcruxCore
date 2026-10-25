// The GA4 head tags both Docusaurus sites share (site-shared.ts). The module
// reads the environment when it loads, so it is imported after setting it.
import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

process.env.GA4_MEASUREMENT_ID = 'G-TEST123';
process.env.NODE_ENV = 'production';
const {analyticsHeadTags} = await import('../site-shared.ts');

describe('analyticsHeadTags', () => {
  const tags = analyticsHeadTags();
  const inline = tags.map((tag) => tag.innerHTML ?? '').join('\n');

  // gtag.js is 194 KiB. As an async <script src> in the head it downloaded and
  // ran during the page's own first render; it now waits for the load event.
  it('does not put the gtag.js script in the head', () => {
    for (const tag of tags) {
      assert.doesNotMatch(String(tag.attributes?.src ?? ''), /googletagmanager/);
    }
  });

  it('injects gtag.js from the inline bootstrap, after the load event', () => {
    assert.match(inline, /addEventListener\('load'/);
    assert.match(inline, /googletagmanager\.com\/gtag\/js\?id=G-TEST123/);
  });

  it('still queues the consent default before the config command', () => {
    const consent = inline.indexOf("gtag('consent', 'default'");
    const config = inline.indexOf("gtag('config'");
    assert.ok(consent >= 0 && config > consent, 'consent default must come first');
  });
});
