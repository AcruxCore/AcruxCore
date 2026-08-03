import {
  IngestBatchSchema,
  IngestTraceSchema,
  IngestSpanSchema,
} from './ingest.types';

/** Minimal valid span used as a base for mutation in individual tests. */
const validSpan = {
  spanId: 'span-1',
  name: 'call-llm',
  kind: 'llm' as const,
  status: 'ok' as const,
  startTime: '2026-07-05T10:00:00.000Z',
  endTime: '2026-07-05T10:00:01.000Z',
  model: 'gpt-4o',
  provider: 'openai',
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  costUsd: 0.001,
};

const validTrace = {
  sessionId: 'session-1',
  name: 'chat-turn',
  spans: [validSpan],
};

describe('IngestBatchSchema', () => {
  it('accepts a well-formed batch with a single trace and span', () => {
    const result = IngestBatchSchema.safeParse({ traces: [validTrace] });
    expect(result.success).toBe(true);
  });

  it('accepts a batch with multiple traces and multiple spans per trace', () => {
    const result = IngestBatchSchema.safeParse({
      traces: [
        { spans: [validSpan, { ...validSpan, spanId: 'span-2', parentSpanId: 'span-1' }] },
        { traceId: '11111111-1111-4111-8111-111111111111', spans: [validSpan] },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a batch with an empty traces array', () => {
    const result = IngestBatchSchema.safeParse({ traces: [] });
    expect(result.success).toBe(false);
  });

  it('rejects a batch missing the traces field', () => {
    const result = IngestBatchSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('IngestTraceSchema', () => {
  it('rejects a trace with an empty spans array', () => {
    const result = IngestTraceSchema.safeParse({ ...validTrace, spans: [] });
    expect(result.success).toBe(false);
  });

  it('rejects a trace missing the spans field', () => {
    const { spans: _spans, ...rest } = validTrace;
    const result = IngestTraceSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects a duplicate spanId within the same trace', () => {
    const result = IngestTraceSchema.safeParse({
      ...validTrace,
      spans: [validSpan, { ...validSpan }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.') === 'spans');
      expect(issue?.message).toContain('Duplicate spanId');
    }
  });

  it('accepts the same spanId reused across two different traces', () => {
    const result = IngestBatchSchema.safeParse({
      traces: [
        { spans: [validSpan] },
        { spans: [validSpan] },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-UUID traceId', () => {
    const result = IngestTraceSchema.safeParse({ ...validTrace, traceId: 'not-a-uuid' });
    expect(result.success).toBe(false);
  });

  describe('IngestTraceSchema — T8 tags/metadata', () => {
    const baseSpan = { spanId: 's1', name: 'step', startTime: '2026-07-05T10:00:00Z' };

    it('accepts tags and metadata', () => {
      const result = IngestTraceSchema.safeParse({
        name: 'checkout-flow',
        tags: ['prod', 'nl'],
        metadata: { env: 'prod', retries: 2 },
        spans: [baseSpan],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.tags).toEqual(['prod', 'nl']);
        expect(result.data.metadata).toEqual({ env: 'prod', retries: 2 });
      }
    });

    it('tags/metadata are optional', () => {
      const result = IngestTraceSchema.safeParse({ spans: [baseSpan] });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.tags).toBeUndefined();
        expect(result.data.metadata).toBeUndefined();
      }
    });

    it('rejects a non-string entry in tags', () => {
      const result = IngestTraceSchema.safeParse({ tags: ['ok', 5], spans: [baseSpan] });
      expect(result.success).toBe(false);
    });
  });
});

describe('IngestSpanSchema', () => {
  it('rejects an invalid span kind', () => {
    const result = IngestSpanSchema.safeParse({ ...validSpan, kind: 'bogus' });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid span status', () => {
    const result = IngestSpanSchema.safeParse({ ...validSpan, status: 'bogus' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-ISO startTime', () => {
    const result = IngestSpanSchema.safeParse({ ...validSpan, startTime: 'not-a-date' });
    expect(result.success).toBe(false);
  });

  it('rejects an ISO datetime without a timezone offset', () => {
    const result = IngestSpanSchema.safeParse({ ...validSpan, startTime: '2026-07-05T10:00:00.000' });
    expect(result.success).toBe(false);
  });

  it('rejects a negative usage token count', () => {
    const result = IngestSpanSchema.safeParse({
      ...validSpan,
      usage: { promptTokens: -1 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-integer usage token count', () => {
    const result = IngestSpanSchema.safeParse({
      ...validSpan,
      usage: { promptTokens: 1.5 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a negative costUsd', () => {
    const result = IngestSpanSchema.safeParse({ ...validSpan, costUsd: -0.5 });
    expect(result.success).toBe(false);
  });

  it('rejects an empty spanId or name', () => {
    expect(IngestSpanSchema.safeParse({ ...validSpan, spanId: '' }).success).toBe(false);
    expect(IngestSpanSchema.safeParse({ ...validSpan, name: '' }).success).toBe(false);
  });

  it('rejects a non-UUID promptVersionId', () => {
    const result = IngestSpanSchema.safeParse({ ...validSpan, promptVersionId: 'not-a-uuid' });
    expect(result.success).toBe(false);
  });

  it('rejects endTime earlier than startTime', () => {
    const result = IngestSpanSchema.safeParse({
      ...validSpan,
      startTime: '2026-07-05T10:00:01.000Z',
      endTime: '2026-07-05T10:00:00.000Z',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.') === 'endTime');
      expect(issue?.message).toContain('endTime must be greater than or equal to startTime');
    }
  });

  it('accepts a span with only required fields', () => {
    const result = IngestSpanSchema.safeParse({
      spanId: 'span-minimal',
      name: 'minimal-span',
      startTime: '2026-07-05T10:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('allows arbitrary attributes and unknown input/output payloads', () => {
    const result = IngestSpanSchema.safeParse({
      ...validSpan,
      attributes: { foo: 'bar', nested: { a: 1 } },
      input: { messages: [{ role: 'user', content: 'hi' }] },
      output: 'plain text output',
    });
    expect(result.success).toBe(true);
  });
});
