// Unit test for scripts/check-cross-host-links.ts against small fixture builds.
import assert from 'node:assert/strict';
import nodePath from 'node:path';
import {describe, it} from 'node:test';
import {findBrokenCrossHostLinks} from '../scripts/check-cross-host-links.ts';

const FIXTURES = nodePath.resolve(import.meta.dirname, 'fixtures/cross-host');

describe('findBrokenCrossHostLinks', () => {
  it('reports exactly the dead links in each direction', () => {
    const broken = findBrokenCrossHostLinks(
      nodePath.join(FIXTURES, 'docs'),
      nodePath.join(FIXTURES, 'blog'),
    );
    assert.deepEqual(broken.sort(), [
      'blog/index.html -> https://docs.acruxcore.com/docs/guides/gone-guide',
      'docs/index.html -> https://acruxcore.com/blog/missing-post',
    ]);
  });
});
