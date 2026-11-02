// The "Updated" date must sit in the post header, beside the publish date.
// Docusaurus only prints it in the footer, under the whole post, where a reader
// never sees it. Run after `npm run build:blog`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import nodePath from 'node:path';
import {describe, it} from 'node:test';

const SITE_DIR = nodePath.resolve(import.meta.dirname, '..');
// The post's own front matter is the source of both dates, so the test reads
// them from there and keeps passing when the post is edited again.
const source = fs.readFileSync(
  nodePath.join(SITE_DIR, 'blog', '2026-07-27-tool-agent-sdk-langchain-vs-acruxcore.md'),
  'utf8',
);
const published = source.match(/^date: (\d{4}-\d{2}-\d{2})$/m)?.[1];
const updated = source.match(/^last_update:\n\s+date: (\d{4}-\d{2}-\d{2})$/m)?.[1];
const html = fs.readFileSync(
  nodePath.join(SITE_DIR, 'build-blog', 'tool-agent-sdk-langchain-vs-acruxcore.html'),
  'utf8',
);

describe('blog post header', () => {
  it('shows the last-updated date before the post body', () => {
    assert.ok(published && updated && published !== updated, 'post needs two different dates');
    const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    assert.match(header, new RegExp(String.raw`Published[^<]*(<!-- -->)?\s*<time[^>]*datetime=["']?${published}`, 'i'));
    assert.match(header, new RegExp(String.raw`Updated[^<]*(<!-- -->)?\s*<time[^>]*datetime=["']?${updated}`, 'i'));
  });
});
