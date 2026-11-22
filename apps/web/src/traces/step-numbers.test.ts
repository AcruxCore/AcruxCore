import { describe, expect, it } from 'vitest';
import { numberSteps } from './step-numbers';
import type { Span } from '@/api/types';

const span = (spanId: string, kind: Span['kind'], startedAt = '2026-01-01T00:00:00.000Z') => ({ span: { spanId, kind, startedAt } as Span });

describe('numberSteps', () => {
  it('numbers tool and retrieval spans in row order, skipping model calls', () => {
    const steps = numberSteps([span('a', 'agent'), span('l1', 'llm'), span('t1', 'tool'), span('l2', 'llm'), span('r1', 'retrieval'), span('t2', 'tool')]);
    expect([...steps.entries()]).toEqual([['t1', 1], ['r1', 2], ['t2', 3]]);
  });
  it('is empty for a trace with no tool steps', () => {
    expect(numberSteps([span('l1', 'llm')]).size).toBe(0);
  });
  it('numbers by start time, so parallel branches agree with "repeated from step N"', () => {
    // Agent A starts first but its search runs late; agent B's search runs early.
    const steps = numberSteps([
      span('a', 'agent', '2026-01-01T00:00:00.000Z'),
      span('a2', 'retrieval', '2026-01-01T00:00:00.500Z'),
      span('b', 'agent', '2026-01-01T00:00:00.050Z'),
      span('b1', 'retrieval', '2026-01-01T00:00:00.100Z'),
    ]);
    expect([...steps.entries()]).toEqual([['b1', 1], ['a2', 2]]);
  });
});
