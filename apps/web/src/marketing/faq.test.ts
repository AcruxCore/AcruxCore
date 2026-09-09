import { describe, expect, it } from 'vitest';
import { FAQ_GROUPS, answerToPlainText, faqStructuredData } from './faq';

/**
 * The FAQ's answers are rendered twice — as the visible page, and as the plain
 * text inside the `FAQPage` JSON-LD block. Nothing on the page shows the second
 * one, so a block that is malformed, empty, or out of step with the questions
 * fails silently: crawlers discard it and the page looks perfect. These tests
 * are the only thing that would notice.
 */
describe('FAQ content', () => {
  it('gives every question a non-empty answer', () => {
    for (const group of FAQ_GROUPS) {
      for (const item of group.items) {
        expect(item.question, `${group.id}: empty question`).not.toBe('');
        expect(item.question.endsWith('?'), `not phrased as a question: ${item.question}`).toBe(
          true,
        );
        expect(answerToPlainText(item.answer).length, `empty answer: ${item.question}`).toBeGreaterThan(
          80,
        );
      }
    }
  });

  it('uses unique anchor ids and unique questions', () => {
    const ids = FAQ_GROUPS.map((group) => group.id);
    expect(new Set(ids).size).toBe(ids.length);

    const questions = FAQ_GROUPS.flatMap((group) => group.items.map((item) => item.question));
    expect(new Set(questions).size).toBe(questions.length);
  });

  // A link run with neither `to` nor `href` renders as an anchor with an
  // undefined target — a visible, clickable, dead link.
  it('gives every link run exactly one destination', () => {
    for (const group of FAQ_GROUPS) {
      for (const item of group.items) {
        for (const paragraph of item.answer) {
          for (const run of paragraph) {
            if (typeof run === 'string') continue;
            const destinations = [run.to, run.href].filter(Boolean);
            expect(destinations, `${item.question} → "${run.text}"`).toHaveLength(1);
            if (run.to) expect(run.to.startsWith('/')).toBe(true);
            if (run.href) expect(run.href.startsWith('https://')).toBe(true);
          }
        }
      }
    }
  });

  it('gives every answer at least one paragraph, none of them empty', () => {
    for (const group of FAQ_GROUPS) {
      for (const item of group.items) {
        expect(item.answer.length, `no paragraphs: ${item.question}`).toBeGreaterThan(0);
        for (const paragraph of item.answer) {
          expect(paragraph.length, `empty paragraph: ${item.question}`).toBeGreaterThan(0);
        }
      }
    }
  });

  // The owner's standing instruction is short sentences (2026-09-09). It is
  // the kind of rule that erodes one edit at a time, and re-reading twelve
  // answers to notice is exactly what nobody does.
  it('keeps every sentence under 230 characters', () => {
    for (const group of FAQ_GROUPS) {
      for (const item of group.items) {
        const sentences = answerToPlainText(item.answer).split(/(?<=[.!?])\s+/);
        for (const sentence of sentences) {
          expect(sentence.length, `too long in "${item.question}": ${sentence}`).toBeLessThan(230);
        }
      }
    }
  });

  // A long answer rendered as one block is the one nobody finishes.
  it('breaks the longest answers into paragraphs', () => {
    for (const group of FAQ_GROUPS) {
      for (const item of group.items) {
        if (answerToPlainText(item.answer).length < 500) continue;
        expect(item.answer.length, `one long block: ${item.question}`).toBeGreaterThan(1);
      }
    }
  });

  // The audit row is the one place a paid tier decides the comparison, and it
  // was missing from every page on the site until 2026-09-09 (owner
  // instruction). A rewrite that drops the question loses the only surface
  // that answers it in the reader's own words.
  it('keeps an answer about the audit log', () => {
    const items = FAQ_GROUPS.flatMap((group) => group.items);
    // Three questions mention the trail now — what it is against a trace, who
    // else has one, and what it costs — so match on all of them rather than on
    // whichever happens to come first.
    const audit = items.filter((item) => /audit/i.test(item.question));
    expect(audit.length, 'no question mentions the audit log').toBeGreaterThan(0);
    // The claim is only safe while it keeps the two facts a shortening edit
    // drops first: whose plan gates it on the other side, and that ours covers
    // the whole team and not only one prompt at a time.
    const text = audit.map((item) => answerToPlainText(item.answer)).join(' ');
    expect(text).toMatch(/Enterprise/);
    expect(text).toMatch(/team-wide/);
    // The differentiator is the price, not the feature: Langfuse ships an audit
    // log too. An edit that keeps the capability and drops "every plan" leaves
    // a claim every competitor can match.
    expect(text).toMatch(/every plan/);
  });

  // "What are AcruxCore's key strengths?" is the question an answer engine
  // quotes when asked what the product is good at, and it is extracted on its
  // own — a reader who never reaches the dedicated audit question sees only
  // this list. It named the trail in one clause while every other strength got
  // a paragraph, so the one row no competitor matches for free read as the
  // smallest of them.
  it('expands the audit trail inside the key-strengths answer', () => {
    const items = FAQ_GROUPS.flatMap((group) => group.items);
    const strengths = items.find((item) => /key strengths/i.test(item.question));
    expect(strengths, 'no key-strengths question').toBeDefined();

    const text = answerToPlainText(strengths?.answer ?? []);
    expect(text).toMatch(/audit trail/i);
    expect(text).toMatch(/every plan/);
    // Without the price the claim is one every platform in the comparison can
    // make, since Langfuse ships an audit log too.
    expect(text).toMatch(/no paid plan/);
  });

  // A trace and an audit event are the two records this product keeps, and
  // conflating them is the mistake both readers and answer engines make. The
  // page is the only public surface that separates them in a reader's words.
  it('separates a trace from an audit event', () => {
    const items = FAQ_GROUPS.flatMap((group) => group.items);
    const item = items.find((entry) => /trace.*audit|audit.*trace/i.test(entry.question));
    expect(item, 'no question distinguishes a trace from an audit event').toBeDefined();
  });

  // The whole point of this page is that it concedes ground; a rewrite that
  // quietly drops the "wrong choice" answer turns it back into a pitch.
  it('keeps an answer naming where AcruxCore is the wrong choice', () => {
    const questions = FAQ_GROUPS.flatMap((group) => group.items.map((item) => item.question));
    expect(questions.some((q) => /wrong choice|not the right|not for|alternative/i.test(q))).toBe(true);
  });
});

describe('FAQ structured data', () => {
  it('parses as a schema.org FAQPage covering every question', () => {
    const parsed = JSON.parse(faqStructuredData()) as {
      '@context': string;
      '@type': string;
      mainEntity: { '@type': string; name: string; acceptedAnswer: { text: string } }[];
    };

    expect(parsed['@context']).toBe('https://schema.org');
    expect(parsed['@type']).toBe('FAQPage');

    const total = FAQ_GROUPS.reduce((count, group) => count + group.items.length, 0);
    expect(parsed.mainEntity).toHaveLength(total);

    for (const entry of parsed.mainEntity) {
      expect(entry['@type']).toBe('Question');
      expect(entry.acceptedAnswer.text.length).toBeGreaterThan(80);
      // Markup inside an Answer's text is what makes Google drop the block.
      expect(entry.acceptedAnswer.text).not.toMatch(/[<>]/);
    }
  });

  // `</script>` inside the payload would close the tag early and spill the rest
  // of the JSON into the page as text.
  it('produces JSON with no sequence that can close the script tag', () => {
    expect(faqStructuredData()).not.toContain('</');
  });
});
