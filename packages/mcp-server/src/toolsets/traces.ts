import { z } from 'zod';
import { listSummary, okResult } from '../format';
import { defineTool, type AnyToolDefinition } from './types';

/** A span as returned inside a trace tree, with its children. */
interface SpanNode {
  payload?: unknown;
  children?: SpanNode[];
  [key: string]: unknown;
}

/**
 * Removes captured input/output payloads from a span tree, in place on a copy.
 *
 * Payload capture is on by default for new teams, and a single LLM span can carry the
 * whole conversation. Reading one trace should not be able to spend a client's entire
 * context budget by accident, so the caller can ask for the shape without the contents.
 *
 * @param spans - Span tree from `GET /traces/:id`.
 * @returns A copy with every `payload` replaced by a marker.
 */
function stripPayloads(spans: SpanNode[]): SpanNode[] {
  return spans.map((span) => {
    const copy: SpanNode = { ...span };
    if (copy.payload !== undefined && copy.payload !== null) {
      copy.payload = '[omitted — call get_trace with include_payloads=true]';
    }
    if (Array.isArray(copy.children)) copy.children = stripPayloads(copy.children);
    return copy;
  });
}

/**
 * Tools for observability: find runs, read one, aggregate them, and attach feedback.
 *
 * A trace is one request end to end; a span is one step inside it (`llm`, `tool`,
 * `retrieval`, …); a session groups traces belonging to one conversation. Those three
 * words appear in every description because picking the wrong level is the usual failure
 * — "why was yesterday slow" is `get_trace_analytics`, not a hundred `get_trace` calls.
 */
export const traceTools: AnyToolDefinition[] = [
  defineTool({
    name: 'search_traces',
    title: 'Search traces',
    toolset: 'traces',
    readOnlyHint: true,
    description:
      'Find traces — one row per request — newest first, with cost, token count, span ' +
      'count and duration. Filter by status, model, session, prompt version, free text, ' +
      'or minimum latency/cost/tokens. The default window is the last 30 days. Use this ' +
      'to locate a run, then get_trace to open it.',
    inputSchema: {
      q: z.string().optional().describe('Free text over trace/span names and span attributes.'),
      status: z.enum(['ok', 'error', 'unset']).optional().describe('Trace status filter.'),
      model: z.string().optional().describe('Exact model name on any span in the trace.'),
      session_id: z.string().optional().describe('Restrict to one session.'),
      prompt_version_id: z.string().uuid().optional().describe('Traces attributed to one prompt version.'),
      from: z.string().optional().describe('ISO 8601 start of the window.'),
      to: z.string().optional().describe('ISO 8601 end of the window.'),
      min_latency_ms: z.number().int().positive().optional().describe('Inclusive lower bound.'),
      min_cost_usd: z.number().positive().optional().describe('Inclusive lower bound.'),
      min_tokens: z.number().int().positive().optional().describe('Inclusive lower bound.'),
      page: z.number().int().positive().optional().describe('1-based page number.'),
      limit: z.number().int().positive().max(100).optional().describe('Results per page, max 100.'),
    },
    async handler(args, { client, config }) {
      const result = await client.get<{ data?: unknown[]; total?: number }>('/traces', {
        q: args.q,
        status: args.status,
        model: args.model,
        session_id: args.session_id,
        prompt_version_id: args.prompt_version_id,
        from: args.from,
        to: args.to,
        min_latency_ms: args.min_latency_ms,
        min_cost_usd: args.min_cost_usd,
        min_tokens: args.min_tokens,
        page: args.page,
        limit: args.limit,
      });
      return okResult(listSummary('traces', result), result, config.maxTextBytes);
    },
  }),

  defineTool({
    name: 'get_trace',
    title: 'Get one trace with its span tree',
    toolset: 'traces',
    readOnlyHint: true,
    description:
      'Open one trace: the header plus every span assembled into a parent/child tree, ' +
      'each with its model, tokens, cost, latency, error message and — when the team ' +
      'captures payloads — the input and output. Set include_payloads=false when the ' +
      'trace is large and you only need its shape and timings.',
    inputSchema: {
      trace_id: z.string().uuid().describe('Trace UUID, from search_traces or a gateway call.'),
      include_payloads: z
        .boolean()
        .optional()
        .describe('Include captured span input/output. Default true.'),
    },
    async handler({ trace_id, include_payloads }, { client, config }) {
      const result = await client.get<{ trace?: Record<string, unknown>; spans?: SpanNode[] }>(
        `/traces/${trace_id}`,
      );
      const spans = include_payloads === false ? stripPayloads(result.spans ?? []) : result.spans;
      const header = result.trace ?? {};
      return okResult(
        `Trace "${header.name}" — status ${header.status}, ${header.spanCount} span(s), ` +
          `${header.totalTokens ?? 0} tokens, $${header.totalCostUsd ?? 0}.`,
        { trace: header, spans },
        config.maxTextBytes,
      );
    },
  }),

  defineTool({
    name: 'get_trace_analytics',
    title: 'Aggregate trace metrics',
    toolset: 'traces',
    readOnlyHint: true,
    description:
      'Aggregate span metrics over a window: request count, error rate, tokens, cost and ' +
      'p50/p95/p99 latency, bucketed by day, model, session or prompt version. Default ' +
      'window is the last 30 days. This is the tool for "did latency regress", "which ' +
      'model errors most", "what does this prompt version cost".',
    inputSchema: {
      from: z.string().optional().describe('ISO date, start of the window.'),
      to: z.string().optional().describe('ISO date, end of the window.'),
      group_by: z
        .enum(['day', 'model', 'session', 'prompt_version'])
        .optional()
        .describe('Bucket dimension. Default "day".'),
      kind: z
        .enum(['llm', 'tool', 'retrieval', 'embedding', 'agent', 'chain', 'other'])
        .optional()
        .describe('Restrict to one span kind.'),
      model: z.string().optional().describe('Restrict to one exact model.'),
    },
    async handler(args, { client, config }) {
      const result = await client.get<{
        totals?: { requests?: number; errorRate?: number; costUsd?: number };
        buckets?: unknown[];
      }>('/traces/analytics', args);
      const totals = result.totals ?? {};
      return okResult(
        `${totals.requests ?? 0} span(s), error rate ${totals.errorRate ?? 0}, $${
          totals.costUsd ?? 0
        }, in ${result.buckets?.length ?? 0} bucket(s).`,
        result,
        config.maxTextBytes,
      );
    },
  }),

  defineTool({
    name: 'list_sessions',
    title: 'List sessions',
    toolset: 'traces',
    readOnlyHint: true,
    description:
      'List sessions — groups of traces belonging to one conversation — with the most ' +
      'recent activity first. Default window is the last 30 days.',
    inputSchema: {
      q: z.string().optional().describe('Case-insensitive substring match on the session id.'),
      from: z.string().optional().describe('ISO 8601 start of the window.'),
      to: z.string().optional().describe('ISO 8601 end of the window.'),
      page: z.number().int().positive().optional().describe('1-based page number.'),
      limit: z.number().int().positive().max(100).optional().describe('Results per page, max 100.'),
    },
    async handler(args, { client, config }) {
      const result = await client.get<{ data?: unknown[]; total?: number }>('/sessions', args);
      return okResult(listSummary('sessions', result), result, config.maxTextBytes);
    },
  }),

  defineTool({
    name: 'get_session',
    title: 'Get one session',
    toolset: 'traces',
    readOnlyHint: true,
    description:
      'One session\'s summary plus its traces, newest first, capped at 100. Not date ' +
      'filtered — the lookup is by session id alone.',
    inputSchema: {
      session_id: z.string().min(1).describe('The session id as your application set it.'),
    },
    async handler({ session_id }, { client, config }) {
      const result = await client.get<{ traces?: unknown[] }>(
        `/sessions/${encodeURIComponent(session_id)}`,
      );
      return okResult(
        `Session "${session_id}" — ${result.traces?.length ?? 0} trace(s).`,
        result,
        config.maxTextBytes,
      );
    },
  }),

  defineTool({
    name: 'submit_trace_feedback',
    title: 'Attach feedback to a trace',
    toolset: 'traces',
    readOnlyHint: false,
    description:
      'Record a rating, label and/or comment against a trace, or against one span inside ' +
      'it. At least one of rating, label or comment is required. Feedback is what later ' +
      'becomes an evaluation dataset via the "from feedback" path, so a clear label is ' +
      'worth more than a bare rating.',
    inputSchema: {
      trace_id: z.string().uuid().describe('Trace UUID.'),
      rating: z.number().int().min(-1).max(5).optional().describe('Integer rating, -1 to 5.'),
      label: z.string().max(200).optional().describe('Short label, e.g. "wrong_answer".'),
      comment: z.string().max(5000).optional().describe('Free-text detail.'),
      span_id: z.string().optional().describe('Span reference, for span-level feedback.'),
      source: z
        .enum(['user', 'developer', 'end_user', 'api'])
        .optional()
        .describe('Who the feedback came from. Default "user".'),
    },
    async handler({ trace_id, span_id, ...rest }, { client, config }) {
      const body: Record<string, unknown> = { ...rest };
      if (span_id !== undefined) body.spanId = span_id;
      const result = await client.post<{ id?: string }>(`/traces/${trace_id}/feedback`, body);
      return okResult(`Feedback recorded on trace ${trace_id}.`, result, config.maxTextBytes);
    },
  }),
];
