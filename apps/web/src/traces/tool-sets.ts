import type { Span, TraceDetail } from '@/api/types';

/**
 * Puts each span's tool list back on its payload, as `payload.tools`.
 *
 * `GET /traces/:id` returns every distinct tool list once, under `toolSets`, and each
 * gateway `llm` span's payload names its list by `toolSetId`: a tool loop sends the same
 * list on every round, and repeating it per span made the response grow with the round
 * count. The span panel reads `payload.tools`, so the lookup happens here, once per fetch.
 * The spans share one array per list, so this adds no copies.
 *
 * @param detail - The trace detail as the API returned it.
 * @returns The same detail with `payload.tools` set on every span that has a `toolSetId`.
 */
export function attachToolSets(detail: TraceDetail): TraceDetail {
  const sets = detail.toolSets ?? {};
  const visit = (span: Span): Span => {
    const id = span.payload?.toolSetId;
    const payload = id && id in sets ? { ...span.payload, tools: sets[id] } : span.payload;
    return { ...span, payload, children: span.children.map(visit) };
  };
  return { ...detail, spans: detail.spans.map(visit) };
}
