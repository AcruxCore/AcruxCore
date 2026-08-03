import { describe, it, expect, vi } from 'vitest';
import { SpanQueue } from '../../src/span-queue';
import type { IngestSpan, TraceInput } from '../../src/types';

/** One trace entry carrying `count` spans. */
function entry(traceId: string | undefined, count = 1): TraceInput {
  const spans: IngestSpan[] = Array.from({ length: count }, (_, i) => ({
    spanId: `${traceId ?? 'anon'}-s${i}`,
    name: 'span',
    kind: 'llm' as const,
    status: 'ok' as const,
    startTime: '2026-07-30T00:00:00.000Z',
    endTime: '2026-07-30T00:00:00.000Z',
  }));
  return { ...(traceId ? { traceId } : {}), name: 'test', spans };
}

/** Trace ids of every entry in every batch, flattened. */
function traceIdsOf(batches: TraceInput[][]): string[] {
  return batches.flat().map((e) => e.traceId ?? 'anon');
}

/** Spans in one batch, across its entries. */
function spansIn(batch: TraceInput[]): number {
  return batch.reduce((n, e) => n + e.spans.length, 0);
}

describe('SpanQueue', () => {
  it('sends in the same tick as enqueue — there is no timer to wait for', () => {
    const sent: TraceInput[][] = [];
    const q = new SpanQueue(async (b) => {
      sent.push(b);
    });

    q.enqueue(entry('t1'));

    // Not awaited: the request must already have been handed to `send` synchronously.
    expect(sent).toHaveLength(1);
    expect(sent[0][0].traceId).toBe('t1');
  });

  it('enqueue returns without waiting for the send to finish', () => {
    const q = new SpanQueue(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const before = Date.now();
    q.enqueue(entry('t1'));
    expect(Date.now() - before).toBeLessThan(10);
    expect(q.pendingSpanCount).toBe(0);
  });

  it('coalesces everything enqueued while a send is in flight into the next batch', async () => {
    const sent: TraceInput[][] = [];
    let releaseFirst!: () => void;
    const firstInFlight = new Promise<void>((r) => {
      releaseFirst = r;
    });
    let call = 0;
    const q = new SpanQueue(async (b) => {
      sent.push(b);
      if (++call === 1) await firstInFlight;
    });

    q.enqueue(entry('t1'));
    q.enqueue(entry('t2'));
    q.enqueue(entry('t3'));
    releaseFirst();
    await q.flush();

    expect(sent).toHaveLength(2);
    expect(sent[0].map((e) => e.traceId)).toEqual(['t1']);
    expect(sent[1].map((e) => e.traceId)).toEqual(['t2', 't3']);
  });

  it('never runs two sends at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const q = new SpanQueue(async () => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    for (let i = 0; i < 10; i++) q.enqueue(entry(`t${i}`));
    await q.flush();
    expect(maxInFlight).toBe(1);
  });

  it('merges entries that share a trace id, preserving span order', async () => {
    const sent: TraceInput[][] = [];
    let release!: () => void;
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    let call = 0;
    const q = new SpanQueue(async (b) => {
      sent.push(b);
      if (++call === 1) await blocked;
    });

    q.enqueue(entry('same', 1)); // goes out alone, opening the request
    q.enqueue({ traceId: 'same', name: 'a', spans: entry('same', 1).spans });
    q.enqueue({ traceId: 'same', name: 'b', spans: entry('same', 2).spans });
    q.enqueue(entry('other', 1));
    release();
    await q.flush();

    // Second batch: one entry for `same` holding both its reports, plus `other`.
    expect(sent[1]).toHaveLength(2);
    expect(sent[1][0].traceId).toBe('same');
    expect(sent[1][0].spans).toHaveLength(3);
    expect(sent[1][1].traceId).toBe('other');
  });

  it('does not merge entries that have no trace id — each mints its own trace', async () => {
    const sent: TraceInput[][] = [];
    let release!: () => void;
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    let call = 0;
    const q = new SpanQueue(async (b) => {
      sent.push(b);
      if (++call === 1) await blocked;
    });

    q.enqueue(entry('opener'));
    q.enqueue(entry(undefined));
    q.enqueue(entry(undefined));
    release();
    await q.flush();

    expect(sent[1]).toHaveLength(2);
    expect(sent[1].every((e) => e.traceId === undefined)).toBe(true);
  });

  it('splits at the span cap rather than sending an oversized batch', async () => {
    const sent: TraceInput[][] = [];
    const q = new SpanQueue(
      async (b) => {
        sent.push(b);
      },
      { maxBatchSpans: 200 },
    );
    q.enqueue(entry('t1', 150));
    q.enqueue(entry('t2', 150));
    await q.flush();

    expect(Math.max(...sent.map(spansIn))).toBeLessThanOrEqual(200);
    expect(sent.reduce((n, b) => n + spansIn(b), 0)).toBe(300);
    expect(traceIdsOf(sent)).toEqual(['t1', 't2']);
  });

  it('splits a single over-cap entry across requests when it has a trace id', async () => {
    const sent: TraceInput[][] = [];
    const q = new SpanQueue(
      async (b) => {
        sent.push(b);
      },
      { maxBatchSpans: 100 },
    );
    q.enqueue(entry('big', 250));
    await q.flush();

    expect(sent.map(spansIn)).toEqual([100, 100, 50]);
    // Order is preserved across the split, so a parent still precedes its child.
    const order = sent.flat().flatMap((e) => e.spans.map((s) => s.spanId));
    expect(order[0]).toBe('big-s0');
    expect(order[249]).toBe('big-s249');
    expect(sent.flat().every((e) => e.traceId === 'big')).toBe(true);
  });

  it('sends an over-cap entry with no trace id whole, since splitting would fork the trace', async () => {
    const sent: TraceInput[][] = [];
    const q = new SpanQueue(
      async (b) => {
        sent.push(b);
      },
      { maxBatchSpans: 100 },
    );
    q.enqueue(entry(undefined, 250));
    await q.flush();

    expect(sent).toHaveLength(1);
    expect(spansIn(sent[0])).toBe(250);
  });

  it('drops the oldest on overflow and warns exactly once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sent: TraceInput[][] = [];
    let release!: () => void;
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    const q = new SpanQueue(
      async (b) => {
        sent.push(b);
        await blocked;
      },
      { maxQueuedSpans: 5 },
    );

    q.enqueue(entry('inflight')); // taken immediately, so the buffer starts empty
    for (let i = 0; i < 8; i++) q.enqueue(entry(`t${i}`));
    release();
    await q.flush();

    const seen = traceIdsOf(sent);
    expect(seen).not.toContain('t0'); // oldest dropped
    expect(seen).not.toContain('t2');
    expect(seen).toContain('t3');
    expect(seen).toContain('t7'); // newest kept
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('dropping the oldest'))).toHaveLength(1);
    warn.mockRestore();
  });

  it('a failing send warns once per error kind, drops the batch, and keeps draining', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: string[] = [];
    let call = 0;
    const q = new SpanQueue(async (b) => {
      if (++call <= 2) throw new Error('boom');
      seen.push(...b.map((e) => e.traceId!));
    });

    q.enqueue(entry('a'));
    await q.flush();
    q.enqueue(entry('b'));
    await q.flush();
    q.enqueue(entry('c'));
    await q.flush();

    expect(seen).toEqual(['c']); // a and b were dropped, not retried
    expect(warn.mock.calls).toHaveLength(1); // one warning for the one error kind
    expect(String(warn.mock.calls[0][0])).toContain('boom');
    warn.mockRestore();
  });

  it('warns again for a different error kind', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let call = 0;
    const q = new SpanQueue(async () => {
      throw new Error(`failure ${++call}`);
    });
    q.enqueue(entry('a'));
    await q.flush();
    q.enqueue(entry('b'));
    await q.flush();

    expect(warn.mock.calls).toHaveLength(2);
    warn.mockRestore();
  });

  it('flush resolves when the queue is empty and the loop is idle', async () => {
    const q = new SpanQueue(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    q.enqueue(entry('t1'));
    await q.flush();
    expect(q.pendingSpanCount).toBe(0);
  });

  it('flush waits for spans enqueued while an earlier flush was in flight', async () => {
    const sent: TraceInput[][] = [];
    const q = new SpanQueue(async (b) => {
      sent.push(b);
      await new Promise((r) => setTimeout(r, 10));
    });
    q.enqueue(entry('t1'));
    const flushing = q.flush();
    q.enqueue(entry('t2'));
    await flushing;
    expect(traceIdsOf(sent)).toEqual(['t1', 't2']);
  });

  it('enqueue after close warns once and discards', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sent: TraceInput[][] = [];
    const q = new SpanQueue(async (b) => {
      sent.push(b);
    });
    await q.close();
    q.enqueue(entry('t1'));
    q.enqueue(entry('t2'));

    expect(sent).toHaveLength(0);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('closed'))).toHaveLength(1);
    warn.mockRestore();
  });

  it('close flushes what is buffered, and is idempotent', async () => {
    const sent: TraceInput[][] = [];
    const q = new SpanQueue(async (b) => {
      sent.push(b);
      await new Promise((r) => setTimeout(r, 10));
    });
    q.enqueue(entry('t1'));
    await q.close();
    expect(traceIdsOf(sent)).toEqual(['t1']);
    await expect(q.close()).resolves.toBeUndefined();
  });

  it('flush never rejects, even when every send fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const q = new SpanQueue(async () => {
      throw new Error('always down');
    });
    q.enqueue(entry('t1'));
    await expect(q.flush()).resolves.toBeUndefined();
    warn.mockRestore();
  });
});
