import { describe, expect, it } from 'vitest';
import {
  ACRUX_CORE,
  COMPARISON_LIST,
  PLATFORMS_BY_COMMUNITY,
  platformListStructuredData,
} from './comparisons';
import { DECISION_POINTS } from './pages/BestLlmOpsPlatformsPage';

/**
 * `comparisons.tsx` is the single source of truth for every competitive claim
 * the marketing site makes — the matrix, the FAQ, and the category page all read
 * it. Three separate pages restating the same facts from memory is how the blog
 * came to claim we lacked budgets and rate limits we had shipped two phases
 * earlier, so these tests guard the properties that keep it usable as a source:
 * every competitor carries the same fields, and nothing derived from it can
 * quietly become a ranking.
 */
describe('comparison data', () => {
  it.each(COMPARISON_LIST.map((c) => [c.name, c] as const))(
    '%s has a best-for and a limitations sentence',
    (_name, competitor) => {
      expect(competitor.bestFor.length).toBeGreaterThan(60);
      expect(competitor.limitations.length).toBeGreaterThan(60);
      expect(competitor.bestFor.endsWith('.')).toBe(true);
      expect(competitor.limitations.endsWith('.')).toBe(true);
    },
  );

  // The category page is only credible while our own entry is held to the same
  // shape as everyone else's, limitations included.
  it('holds AcruxCore to the same fields as the competitors', () => {
    expect(ACRUX_CORE.bestFor.length).toBeGreaterThan(60);
    expect(ACRUX_CORE.limitations.length).toBeGreaterThan(60);
    expect(ACRUX_CORE.tagline.length).toBeGreaterThan(20);
  });

  // `/faq` and the category page both state these two gaps in prose, naming the
  // competitors. If one of them ships the feature and this file is corrected,
  // the prose becomes a false claim about a competitor with nothing to catch it
  // — earlier posts already claimed we lacked budgets and rate limits we had
  // shipped two phases before, in exactly this way, but pointed at ourselves.
  it('keeps the audit-log gap the FAQ and category page assert in prose', () => {
    for (const competitor of COMPARISON_LIST) {
      expect(
        competitor.auditLog.acruxWins,
        `${competitor.name} no longer loses the audit row — rewrite the audit answer on /faq and the audit question on /best-open-source-llmops-platforms before changing this`,
      ).toBe(true);
    }
  });

  it('keeps the tool-catalog gap the category page calls unique', () => {
    for (const competitor of COMPARISON_LIST) {
      expect(
        competitor.toolCatalog.acruxWins,
        `${competitor.name} no longer loses the tool-catalog row — the "Unique in this comparison" fact on the category page is no longer true`,
      ).toBe(true);
    }
  });

  it('orders the platforms by community size, largest first', () => {
    const stars = PLATFORMS_BY_COMMUNITY.map((c) => Number(c.communityStars.replace(/,/g, '')));
    expect(stars).toEqual([...stars].sort((a, b) => b - a));
    expect(PLATFORMS_BY_COMMUNITY).toHaveLength(COMPARISON_LIST.length);
  });
});

describe('platform list structured data', () => {
  it('parses as an ItemList naming every platform', () => {
    const parsed = JSON.parse(platformListStructuredData()) as {
      '@type': string;
      itemListOrder: string;
      numberOfItems: number;
      itemListElement: { position: number; item: { name: string; description: string } }[];
    };

    expect(parsed['@type']).toBe('ItemList');
    expect(parsed.itemListElement).toHaveLength(COMPARISON_LIST.length + 1);
    expect(parsed.numberOfItems).toBe(parsed.itemListElement.length);

    const names = parsed.itemListElement.map((entry) => entry.item.name);
    expect(names).toContain(ACRUX_CORE.name);
    expect(new Set(names).size).toBe(names.length);
    for (const entry of parsed.itemListElement) {
      expect(entry.item.description.length).toBeGreaterThan(60);
    }
  });

  // An ItemList is read as a ranking unless it says otherwise, and the page it
  // describes opens by saying there is no single best platform. Leaving the
  // default would put a verdict in the markup that the prose contradicts.
  it('declares itself unordered', () => {
    const parsed = JSON.parse(platformListStructuredData()) as { itemListOrder: string };
    expect(parsed.itemListOrder).toBe('https://schema.org/ItemListUnordered');
  });

  it('produces JSON with no sequence that can close the script tag', () => {
    expect(platformListStructuredData()).not.toContain('</');
  });
});

/**
 * The category page's seven questions are prose rather than facts, so nothing
 * in `comparisons.tsx` constrains them. They are held here because they restate
 * that file's rows, and because the owner's short-sentence rule (2026-09-09)
 * eroded on this page before it eroded anywhere else: the audit answer reached
 * a 279-character sentence while `/faq` kept its own under 230.
 */
describe('best-open-source-llmops-platforms decision points', () => {
  it('keeps every sentence under 230 characters', () => {
    for (const point of DECISION_POINTS) {
      for (const sentence of point.answer.split(/(?<=[.!?])\s+/)) {
        expect(sentence.length, `too long in "${point.question}": ${sentence}`).toBeLessThan(230);
      }
    }
  });

  // The audit question is the one a compliance review arrives with, and the
  // claim that separates us is the price rather than the capability — Langfuse
  // ships an audit log too.
  it('asks the audit question about the whole account, and names the price', () => {
    const audit = DECISION_POINTS.find((point) => /audit|who changed/i.test(point.question));
    expect(audit, 'no decision point asks about the audit trail').toBeDefined();
    expect(audit!.question).toMatch(/who changed what/i);
    expect(audit!.answer).toMatch(/every plan/);
    expect(audit!.answer).toMatch(/Enterprise|top paid plan/);
  });
});
