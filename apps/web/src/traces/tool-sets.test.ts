import { describe, expect, it } from 'vitest';
import type { Span, TraceDetail } from '@/api/types';
import { attachToolSets } from './tool-sets';

function span(id: string, toolSetId: string | null, children: Span[] = []): Span {
  return { spanId: id, payload: { input: [], toolSetId, toolChoice: 'auto' }, children } as unknown as Span;
}

describe('attachToolSets', () => {
  it("gives every span, nested ones too, the tool list its payload points at", () => {
    const tools = [{ type: 'function', function: { name: 'get_order_status' } }];
    const detail = {
      toolSets: { set1: tools },
      spans: [span('agent', null, [span('round1', 'set1'), span('round2', 'set1')])],
    } as unknown as TraceDetail;

    const out = attachToolSets(detail);

    expect(out.spans[0].payload!.tools).toBeUndefined();
    expect(out.spans[0].children[0].payload!.tools).toEqual(tools);
    expect(out.spans[0].children[1].payload!.tools).toEqual(tools);
  });

  it('leaves a response without toolSets (an older API) as it was', () => {
    const detail = { spans: [span('a', null)] } as unknown as TraceDetail;
    expect(attachToolSets(detail).spans[0].payload!.tools).toBeUndefined();
  });
});
