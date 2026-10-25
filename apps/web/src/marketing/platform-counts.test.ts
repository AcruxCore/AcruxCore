import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { render, ROUTES } from './entry-prerender';
import { buildLlmsTxt } from './llms-txt';
import { faqStructuredData } from './faq';
import { COMPARISON_LIST } from './comparisons';
import { COMPETITOR_COUNT, HANDS_ON_PLATFORM_COUNT, PLATFORM_COUNT, countWord } from './platform-counts';

/**
 * The site states how many platforms it compares in a dozen places. An SEO
 * audit (2026-10-25) found four different numbers for the same set — "six
 * other platforms" on /faq, "seven alternatives" on /compare, "eight" and
 * "nine" in llms.txt — because each sentence typed its own number. These tests
 * read everything a visitor or crawler sees and check every count against the
 * data it describes.
 */
const WORDS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

/** Every page and file that states a platform count, as plain text. */
function corpus(): Array<[string, string]> {
  const pages = ROUTES.map((r) => [r.path, render(r.path)] as [string, string]);
  return [
    ...pages,
    ['llms.txt', buildLlmsTxt(ROUTES, 'https://acruxcore.com')],
    ['faq structured data', faqStructuredData()],
    ['route descriptions', ROUTES.map((r) => `${r.title}. ${r.description}`).join(' ')],
  ].map(([name, text]) => [
    name,
    text
      .replace(/<!-- -->/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&#x27;|&rsquo;|’/g, "'")
      .replace(/\s+/g, ' '),
  ]);
}

/** A number, in words or digits, directly before "platforms", "alternatives" or "competitors". */
const COUNT = /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d+)\s+((?:other\s+|open-source\s+|LLMOps\s+|LLM-ops\s+)*)(platforms|alternatives|competitors)\b/gi;

describe('platform counts', () => {
  it('derives the counts from the comparison data', () => {
    expect(COMPETITOR_COUNT).toBe(COMPARISON_LIST.length);
    expect(PLATFORM_COUNT).toBe(COMPARISON_LIST.length + 1);
  });

  it.each(corpus())('%s states only counts that match the set it names', (_name, text) => {
    for (const match of text.matchAll(COUNT)) {
      const raw = match[1].toLowerCase();
      const n = WORDS[raw] ?? Number(raw);
      const before = text.slice(Math.max(0, match.index! - 60), match.index!).toLowerCase();
      const phrase = `…${before.slice(-40)}${match[0]}`;
      const after = text.slice(match.index! + match[0].length, match.index! + match[0].length + 30).toLowerCase();
      if (/hands-on/.test(before.slice(-30) + match[0] + after)) {
        expect(n, phrase).toBe(HANDS_ON_PLATFORM_COUNT);
      } else if (/other/i.test(match[2]) || /\bother\s*$/.test(before) || /alternatives|competitors/i.test(match[3])) {
        expect(n, phrase).toBe(COMPETITOR_COUNT);
      } else {
        expect(n, phrase).toBe(PLATFORM_COUNT);
      }
    }
  });

  it('matches the hands-on post, whose title states its own count', () => {
    const post = readFileSync(
      fileURLToPath(new URL('../../../docs/blog/2026-07-27-hands-on-llm-ops-comparison.md', import.meta.url)),
      'utf8',
    );
    const title = post.match(/^title: "(\d+) /m);
    expect(Number(title?.[1])).toBe(HANDS_ON_PLATFORM_COUNT);
  });

  it('makes no claim about the GitHub star count in llms.txt', () => {
    expect(buildLlmsTxt(ROUTES, 'https://acruxcore.com')).not.toMatch(/stars|dozen/i);
  });

  it('spells counts as words', () => {
    expect(countWord(7)).toBe('seven');
    expect(countWord(10, { capitalize: true })).toBe('Ten');
    expect(countWord(42)).toBe('42');
  });
});
