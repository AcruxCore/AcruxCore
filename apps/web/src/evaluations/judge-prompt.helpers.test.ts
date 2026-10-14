import nunjucks from 'nunjucks';
import { describe, expect, it } from 'vitest';
import { STARTER_JUDGE_MESSAGES, judgeCoverageGap } from './judge-prompt.helpers';

describe('STARTER_JUDGE_MESSAGES', () => {
  const system = STARTER_JUDGE_MESSAGES[0].content as string;
  const render = (criteria: string, overallFeedback: string) =>
    nunjucks.renderString(system, { criteria, overallFeedback, output: 'x', history: '' });

  // An online rule passes the word `none` for a missing value; an experiment
  // run passes an empty string. Both must drop the block.
  it.each([['none'], ['']])('drops the guidance and criteria blocks when the value is %j', (missing) => {
    const out = render(missing, missing);
    expect(out).not.toContain('What this example expects');
    expect(out).not.toContain('Guidance for every example');
  });

  it('keeps a real value', () => {
    const out = render('Be polite', 'Short answers');
    expect(out).toContain('What this example expects:\nBe polite');
    expect(out).toContain('Guidance for every example:\nShort answers');
  });
});

describe('judgeCoverageGap', () => {
  const examples = [{ criteria: 'Expected total 12.50' }, { criteria: null }, { criteria: '  ' }];

  it('counts examples with no criteria when the template reads {{ criteria }}', () => {
    expect(judgeCoverageGap(['output', 'criteria'], examples, null)).toEqual({
      variables: ['criteria'],
      missing: 2,
      total: 3,
    });
  });

  it('is silent when the template holds its own rubric and reads no dataset value', () => {
    expect(judgeCoverageGap(['output', 'history'], examples, null)).toBeNull();
  });

  it('is silent when every example has criteria', () => {
    expect(judgeCoverageGap(['criteria', 'output'], [{ criteria: 'a' }, { criteria: 'b' }], null)).toBeNull();
  });

  it('treats dataset-wide overall feedback as covering every example when the template reads it', () => {
    expect(judgeCoverageGap(['criteria', 'overallFeedback'], examples, 'Be concise.')).toBeNull();
  });

  it('still warns when the dataset has overall feedback the template never reads', () => {
    expect(judgeCoverageGap(['criteria'], examples, 'Be concise.')?.missing).toBe(2);
  });

  it('counts every example when the template reads only overallFeedback and the dataset has none', () => {
    expect(judgeCoverageGap(['overallFeedback'], examples, null)).toEqual({
      variables: ['overallFeedback'],
      missing: 3,
      total: 3,
    });
  });
});
