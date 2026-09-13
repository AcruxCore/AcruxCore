import { describe, expect, it } from 'vitest';
import {
  applyFilterExpression,
  applyFilterInput,
  filterStateToParams,
  parseFilterState,
  removeChip,
  stateToChips,
  type FilterState,
} from './chips';

/** Serialises then re-parses, which is exactly the trip a saved view makes. */
function roundTrip(state: FilterState): FilterState {
  return parseFilterState(filterStateToParams(state));
}

describe('filter grammar — round trip', () => {
  it('survives every filter at once', () => {
    const state: FilterState = {
      q: 'visit london',
      qIn: 'input',
      promptId: 'a290cf2f-a724-4389-8bea-da8b53229e00',
      promptVersionId: '4772e4b5-b34f-4cda-bc9e-f3df4de9426f',
      tags: ['prod', 'eu'],
      metadata: { env: 'prod', lang: 'nl' },
      model: 'gpt-4o-mini',
      status: 'error',
      sessionId: 'sess-1',
      minScore: 80,
      maxScore: 95,
      minLatencyMs: 1200,
      minCostUsd: 0.01,
      minTokens: 500,
      rating: 'down',
      source: 'developer',
      label: 'hallucination',
      hasComment: true,
      from: '2026-09-01',
      to: '2026-09-08',
    };
    expect(roundTrip(state)).toEqual(state);
  });

  it('keeps has_comment false rather than reading it as unset', () => {
    expect(roundTrip({ hasComment: false })).toEqual({ hasComment: false });
  });

  it('drops the default scope from the URL but reads back the same state', () => {
    const params = filterStateToParams({ q: 'london', qIn: 'all' });
    expect(params.get('q_in')).toBeNull();
    expect(parseFilterState(params)).toEqual({ q: 'london' });
  });

  it('clears a filter that is no longer in the state, keeping unrelated params', () => {
    const base = new URLSearchParams('status=error&tags=prod&page=3&view=grid');
    const params = filterStateToParams({ tags: ['staging'] }, base);
    expect(params.get('status')).toBeNull();
    expect(params.getAll('tags')).toEqual(['staging']);
    // Pagination and anything else the bar does not own is left alone.
    expect(params.get('page')).toBe('3');
    expect(params.get('view')).toBe('grid');
  });

  it('ignores a param it does not recognise instead of failing', () => {
    // A saved view stores its query verbatim, so a retired param must simply
    // stop filtering.
    expect(parseFilterState(new URLSearchParams('retired_filter=1&status=ok'))).toEqual({ status: 'ok' });
  });

  it('ignores a value outside the allowed set', () => {
    expect(parseFilterState(new URLSearchParams('status=maybe&rating=sideways'))).toEqual({});
  });
});

describe('filter grammar — typed input', () => {
  it('parses each prefix into the field it names', () => {
    expect(applyFilterInput({}, 'tag:prod')).toEqual({ tags: ['prod'] });
    expect(applyFilterInput({}, 'meta.env:prod')).toEqual({ metadata: { env: 'prod' } });
    expect(applyFilterInput({}, 'model:gpt-4o-mini')).toEqual({ model: 'gpt-4o-mini' });
    expect(applyFilterInput({}, 'status:error')).toEqual({ status: 'error' });
    expect(applyFilterInput({}, 'session:sess-1')).toEqual({ sessionId: 'sess-1' });
    expect(applyFilterInput({}, 'rating:down')).toEqual({ rating: 'down' });
    expect(applyFilterInput({}, 'source:developer')).toEqual({ source: 'developer' });
    expect(applyFilterInput({}, 'comment:yes')).toEqual({ hasComment: true });
    expect(applyFilterInput({}, 'comment:no')).toEqual({ hasComment: false });
  });

  it('maps input:/output:/name: onto q plus its scope', () => {
    expect(applyFilterInput({}, 'input:london')).toEqual({ q: 'london', qIn: 'input' });
    expect(applyFilterInput({}, 'output:camden')).toEqual({ q: 'camden', qIn: 'output' });
    expect(applyFilterInput({}, 'name:trip-planner')).toEqual({ q: 'trip-planner', qIn: 'name' });
  });

  it('reads comparisons, and refuses an upper bound the API cannot express', () => {
    expect(applyFilterInput({}, 'score>80')).toEqual({ minScore: 80 });
    expect(applyFilterInput({}, 'score<50')).toEqual({ maxScore: 50 });
    expect(applyFilterInput({}, 'latency>1200ms')).toEqual({ minLatencyMs: 1200 });
    expect(applyFilterInput({}, 'cost>0.01')).toEqual({ minCostUsd: 0.01 });
    expect(applyFilterInput({}, 'tokens>500')).toEqual({ minTokens: 500 });
    // There is no max_latency_ms, so this must not silently become a minimum.
    expect(applyFilterInput({}, 'latency<100')).toEqual({});
  });

  it('takes bare text as an unscoped search', () => {
    expect(applyFilterInput({}, 'I want to visit London')).toEqual({
      q: 'I want to visit London',
      qIn: 'all',
    });
  });

  it('treats an unknown prefix as text, not as a filter', () => {
    // "hello: world" is a sentence. Inventing a `hello` filter from it would
    // silently drop the search the person actually typed.
    expect(applyFilterInput({}, 'hello: world')).toEqual({ q: 'hello: world', qIn: 'all' });
  });

  it('says why nothing applied instead of discarding it in silence', () => {
    expect(applyFilterExpression({ status: 'ok' }, 'status:maybe')).toEqual({
      state: { status: 'ok' },
      error: 'status: takes ok, error or unset.',
    });
    expect(applyFilterExpression({}, 'rating:sideways').error).toBe('rating: takes up, down or none.');
    expect(applyFilterExpression({}, 'comment:perhaps').error).toBe('comment: takes yes or no.');
    expect(applyFilterExpression({}, 'source:robot').error).toBe(
      'source: takes user, developer, end_user or api.',
    );
    expect(applyFilterExpression({}, 'tag:').error).toBe('tag: needs a value after the colon.');
    expect(applyFilterExpression({}, 'meta.env:').error).toBe('meta.env: needs a value after the colon.');
    expect(applyFilterExpression({}, 'score>lots').error).toBe('score> needs a number, for example score>80.');
    expect(applyFilterExpression({}, 'latency<100').error).toBe(
      'latency filters on a minimum only — try latency>100.',
    );
  });

  it('reports no error for anything it does apply', () => {
    for (const input of ['tag:prod', 'score>80', 'visit london', 'hello: world', '', '   ']) {
      expect(applyFilterExpression({}, input).error).toBeNull();
    }
  });

  it('strips quotes so a value can hold a space', () => {
    expect(applyFilterInput({}, 'label:"needs review"')).toEqual({ label: 'needs review' });
  });

  it('rejects an invalid enum value instead of storing it', () => {
    expect(applyFilterInput({ status: 'ok' }, 'status:maybe')).toEqual({ status: 'ok' });
    expect(applyFilterInput({}, 'rating:sideways')).toEqual({});
  });

  it('applies two filters typed in one go', () => {
    // Issue #421: this used to split at the first colon, fail the rating enum on
    // "down comment:yes", and silently discard the whole string.
    expect(applyFilterInput({}, 'rating:down comment:yes')).toEqual({
      rating: 'down',
      hasComment: true,
    });
    expect(applyFilterInput({}, 'tag:prod tag:eu status:error')).toEqual({
      tags: ['prod', 'eu'],
      status: 'error',
    });
    expect(applyFilterInput({}, 'score>80 latency>1200ms meta.env:prod')).toEqual({
      minScore: 80,
      minLatencyMs: 1200,
      metadata: { env: 'prod' },
    });
  });

  it('keeps a spaced value whole rather than reading it as two filters', () => {
    // The second token names no filter, so the whole string is still one tag.
    expect(applyFilterInput({}, 'tag:my tag')).toEqual({ tags: ['my tag'] });
    expect(applyFilterInput({}, 'label:needs review')).toEqual({ label: 'needs review' });
    expect(applyFilterInput({}, 'how do I rotate a key')).toEqual({
      q: 'how do I rotate a key',
      qIn: 'all',
    });
  });

  it('applies nothing at all when one of several tokens is invalid', () => {
    // Half-applying would leave the box holding a string that is now partly live.
    const result = applyFilterExpression({}, 'rating:down comment:maybe');
    expect(result.state).toEqual({});
    expect(result.error).toBeTruthy();
  });

  it('appends tags and never duplicates one', () => {
    const once = applyFilterInput({}, 'tag:prod');
    const twice = applyFilterInput(once, 'tag:eu');
    expect(twice.tags).toEqual(['prod', 'eu']);
    expect(applyFilterInput(twice, 'tag:eu').tags).toEqual(['prod', 'eu']);
  });

  it('ignores blank input and a prefix with no value', () => {
    expect(applyFilterInput({ status: 'ok' }, '   ')).toEqual({ status: 'ok' });
    expect(applyFilterInput({ status: 'ok' }, 'tag:')).toEqual({ status: 'ok' });
  });
});

describe('filter grammar — chips', () => {
  it('renders one chip per active filter, showing a prompt by name', () => {
    const state: FilterState = {
      q: 'london',
      qIn: 'input',
      promptId: 'a290cf2f-a724-4389-8bea-da8b53229e00',
      tags: ['prod'],
      metadata: { env: 'prod' },
      rating: 'down',
    };
    const chips = stateToChips(state, { prompts: { 'a290cf2f-a724-4389-8bea-da8b53229e00': 'checkout' } });
    expect(chips.map((c) => c.label)).toEqual([
      'input:london',
      'prompt:checkout',
      'tag:prod',
      'env:prod',
      'rating:down',
    ]);
  });

  it('falls back to a short id when the prompt name is not loaded yet', () => {
    const chips = stateToChips({ promptId: 'a290cf2f-a724-4389-8bea-da8b53229e00' });
    expect(chips[0].label).toBe('prompt:a290cf2f');
  });

  it('removes exactly the chip it is given', () => {
    const state: FilterState = { tags: ['prod', 'eu'], metadata: { env: 'prod', lang: 'nl' }, status: 'error' };
    expect(removeChip(state, 'tags:prod').tags).toEqual(['eu']);
    expect(removeChip(state, 'metadata:env').metadata).toEqual({ lang: 'nl' });
    expect(removeChip(state, 'status').status).toBeUndefined();
  });

  it('drops the last tag rather than leaving an empty array', () => {
    expect(removeChip({ tags: ['prod'] }, 'tags:prod')).toEqual({});
    expect(removeChip({ metadata: { env: 'prod' } }, 'metadata:env')).toEqual({});
  });

  it('removing the search also removes its scope', () => {
    // A scope with nothing to search is not a filter, and leaving it behind
    // would put `q_in` in the URL on its own.
    expect(removeChip({ q: 'london', qIn: 'input' }, 'q')).toEqual({});
  });

  it('every chip a state produces can be removed by its key', () => {
    const state: FilterState = {
      q: 'x', qIn: 'output', promptId: 'p', promptVersionId: 'v', tags: ['a'],
      metadata: { k: 'v' }, model: 'm', status: 'ok', sessionId: 's', minScore: 1,
      maxScore: 2, minLatencyMs: 3, minCostUsd: 4, minTokens: 5, rating: 'up',
      source: 'api', label: 'l', hasComment: true,
    };
    const cleared = stateToChips(state).reduce((acc, chip) => removeChip(acc, chip.key), state);
    expect(cleared).toEqual({});
  });
});
