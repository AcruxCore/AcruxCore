import type { SpanKind } from '@/api/types';

export { formatUsd, formatCount, formatLatency, formatPercent } from '@/gateway/format';

/** Icon glyph + short label per span kind, for the kind chip in the span tree/table. */
export const KIND_META: Record<SpanKind, { label: string; glyph: string }> = {
  llm: { label: 'LLM', glyph: '◆' },
  tool: { label: 'Tool', glyph: '⚙' },
  retrieval: { label: 'Retrieval', glyph: '⛃' },
  embedding: { label: 'Embedding', glyph: '≋' },
  agent: { label: 'Agent', glyph: '☰' },
  chain: { label: 'Chain', glyph: '⛓' },
  other: { label: 'Other', glyph: '•' },
};

/** Human labels for the feedback `source` enum. */
export const SOURCE_LABELS: Record<string, string> = {
  user: 'User',
  developer: 'Developer',
  end_user: 'End user',
  api: 'API',
};
