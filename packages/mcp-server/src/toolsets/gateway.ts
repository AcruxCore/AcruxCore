import { z } from 'zod';
import { okResult } from '../format';
import { resolvePromptIdAndName } from '../refs';
import { defineTool, type AnyToolDefinition } from './types';

/** OpenAI-shaped chat message accepted by the raw completion tool. */
const chatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']).describe('Message role.'),
  content: z.string().describe('Message content.'),
});

/** Headers the gateway sets on every completion, worth surfacing back to the model. */
const GATEWAY_HEADERS = [
  'x-gateway-request-id',
  'x-gateway-provider',
  'x-gateway-model',
  'x-gateway-cost-usd',
  'x-gateway-cache',
  'x-gateway-trace-id',
  'x-gateway-span-id',
] as const;

/**
 * Pulls the `x-gateway-*` metadata off a completion response.
 *
 * These are not decoration: `x-gateway-trace-id` is how the caller finds the completion
 * again in the trace explorer, and `x-gateway-cost-usd` is the only place the price of
 * the call appears. Both would be lost if only the body were returned.
 *
 * @param headers - Response headers from the gateway.
 * @returns Present headers, keyed without the `x-gateway-` prefix.
 */
function gatewayMeta(headers: Headers): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const name of GATEWAY_HEADERS) {
    const value = headers.get(name);
    if (value !== null && value !== '') meta[name.replace('x-gateway-', '')] = value;
  }
  return meta;
}

/**
 * The trace pointer for a summary line, or nothing when the gateway sent no trace id.
 *
 * The id has to be in the summary, not only in the JSON below it. The JSON also carries
 * `request-id`, another UUID, and a client that grabs the first UUID it sees passes
 * that one to `get_trace` and gets a 404. Naming the argument removes the guess.
 */
function traceSuffix(meta: Record<string, string>): string {
  return meta['trace-id'] ? ` Open it with get_trace, trace_id ${meta['trace-id']}.` : '';
}

/** First choice's text, for the human-readable summary line. */
function firstChoiceText(body: unknown): string {
  const choice = (body as { choices?: Array<{ message?: { content?: string | null } }> })?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === 'string' && content.trim() !== '') return content.trim();
  return '(no text content — check tool_calls)';
}

/**
 * Tools that actually run models: the stored-prompt path, the raw path, the model
 * registry and spend.
 *
 * `run_prompt` is the one that matters. It is the whole platform in a single call —
 * registry render, alias resolution, bound tools, provider routing, pricing and tracing —
 * and it is what makes an MCP client able to *try* a prompt rather than only read it.
 */
export const gatewayTools: AnyToolDefinition[] = [
  defineTool({
    name: 'run_prompt',
    title: 'Run a stored prompt through the gateway',
    toolset: 'gateway',
    readOnlyHint: false,
    description:
      'Render a stored prompt at an alias and send it to the model in one call. The ' +
      'gateway resolves the alias, substitutes the variables, attaches the tools bound ' +
      'to that alias, routes to the provider, prices the call and records a trace. ' +
      'Omit `model` to use the version\'s bound default model. Returns the completion ' +
      'plus the trace id, so the run can be inspected afterwards with get_trace. ' +
      'This is the tool for "test this prompt" or "what does this prompt answer for X".',
    inputSchema: {
      prompt: z.string().min(1).describe('Prompt name or UUID.'),
      alias: z.string().optional().describe('Alias to resolve. Default "production".'),
      variables: z.record(z.unknown()).optional().describe('Template variables for the render.'),
      model: z
        .string()
        .optional()
        .describe('Gateway model public name. Omit to use the version\'s bound default model.'),
      max_tokens: z.number().int().positive().optional().describe('Cap on generated tokens.'),
      temperature: z.number().min(0).max(2).optional().describe('Sampling temperature.'),
      trace_name: z
        .string()
        .optional()
        .describe('Name to give the trace, so this run is findable later.'),
    },
    async handler(args, { client, config }) {
      const { name } = await resolvePromptIdAndName(client, args.prompt);
      const body: Record<string, unknown> = {
        prompt: {
          name,
          alias: args.alias ?? 'production',
          variables: args.variables ?? {},
        },
      };
      if (args.model !== undefined) body.model = args.model;
      if (args.max_tokens !== undefined) body.max_tokens = args.max_tokens;
      if (args.temperature !== undefined) body.temperature = args.temperature;

      const headers: Record<string, string> = {};
      if (args.trace_name !== undefined) {
        // Free-text headers must be percent-encoded — a raw non-ASCII value is rejected
        // by fetch before the request leaves the process. The server decodes it back.
        headers['x-trace-name'] = encodeURIComponent(args.trace_name);
      }

      const response = await client.requestRaw<unknown>('POST', '/gateway/chat/completions', {
        body,
        headers,
      });
      const meta = gatewayMeta(response.headers);
      return okResult(
        `Ran "${name}"@${args.alias ?? 'production'} on ${meta.model ?? 'the resolved model'}` +
          `${meta['cost-usd'] ? ` for $${meta['cost-usd']}` : ''}.${traceSuffix(meta)} Reply: ` +
          firstChoiceText(response.data).slice(0, 400),
        { completion: response.data, gateway: meta },
        config.maxTextBytes,
      );
    },
  }),

  defineTool({
    name: 'chat_completion',
    title: 'Run a raw chat completion through the gateway',
    toolset: 'gateway',
    readOnlyHint: false,
    description:
      'Send your own messages through the AcruxCore gateway — OpenAI-compatible, but ' +
      'routed by the team\'s provider connections, priced, budget-checked and traced. ' +
      'Prefer run_prompt when the prompt already exists in the registry; use this for ' +
      'a one-off. Streaming is not available over MCP: the reply comes back whole.',
    inputSchema: {
      model: z.string().min(1).describe('Gateway model public name, e.g. "gpt-4o-mini".'),
      messages: z.array(chatMessageSchema).min(1).describe('Chat messages, in order.'),
      max_tokens: z.number().int().positive().optional().describe('Cap on generated tokens.'),
      temperature: z.number().min(0).max(2).optional().describe('Sampling temperature.'),
      tool_refs: z
        .array(
          z.object({
            name: z.string().describe('Catalog tool name.'),
            alias: z.string().optional().describe('Tool alias. Default "production".'),
            version: z.number().int().positive().optional().describe('Pin an exact version instead.'),
          }),
        )
        .optional()
        .describe(
          'Catalog tools to attach by name. Give an alias OR a version on a ref, never both.',
        ),
      trace_name: z.string().optional().describe('Name to give the trace.'),
    },
    async handler(args, { client, config }) {
      const body: Record<string, unknown> = { model: args.model, messages: args.messages };
      if (args.max_tokens !== undefined) body.max_tokens = args.max_tokens;
      if (args.temperature !== undefined) body.temperature = args.temperature;
      if (args.tool_refs !== undefined) body.tool_refs = args.tool_refs;

      const headers: Record<string, string> = {};
      if (args.trace_name !== undefined) headers['x-trace-name'] = encodeURIComponent(args.trace_name);

      const response = await client.requestRaw<unknown>('POST', '/gateway/chat/completions', {
        body,
        headers,
      });
      const meta = gatewayMeta(response.headers);
      return okResult(
        `Completion from ${meta.model ?? args.model}` +
          `${meta['cost-usd'] ? ` ($${meta['cost-usd']})` : ''}.${traceSuffix(meta)} Reply: ` +
          firstChoiceText(response.data).slice(0, 400),
        { completion: response.data, gateway: meta },
        config.maxTextBytes,
      );
    },
  }),

  defineTool({
    name: 'list_models',
    title: 'List gateway models',
    toolset: 'gateway',
    readOnlyHint: true,
    description:
      'List the models registered for this team, with the provider connection each one ' +
      'routes to. Only these public names are valid in run_prompt, chat_completion, or a ' +
      'version\'s bound default model.',
    inputSchema: {},
    async handler(_args, { client, config }) {
      const models = await client.get<unknown>('/gateway/models');
      const count = Array.isArray(models)
        ? models.length
        : ((models as { data?: unknown[] })?.data?.length ?? 0);
      return okResult(`${count} registered model(s).`, models, config.maxTextBytes);
    },
  }),

  defineTool({
    name: 'get_gateway_usage',
    title: 'Get gateway usage and spend',
    toolset: 'gateway',
    readOnlyHint: true,
    description:
      'Request counts, token counts, cost, cache-hit rate and error rate over a window, ' +
      'bucketed by day, model, provider or virtual key. Defaults to the last 30 days. ' +
      'Use this for "what did we spend" and "which model costs the most" questions.',
    inputSchema: {
      from: z.string().optional().describe('ISO date, inclusive start of the window.'),
      to: z.string().optional().describe('ISO date, exclusive end of the window.'),
      group_by: z
        .enum(['day', 'model', 'virtual_key', 'provider'])
        .optional()
        .describe('Bucket dimension. Default "day".'),
      virtual_key_id: z.string().uuid().optional().describe('Restrict to one virtual key.'),
    },
    async handler({ from, to, group_by, virtual_key_id }, { client, config }) {
      const usage = await client.get<{
        totals?: { requests?: number; costUsd?: number };
        buckets?: unknown[];
      }>('/gateway/usage', { from, to, group_by, virtual_key_id });
      const totals = usage.totals ?? {};
      return okResult(
        `${totals.requests ?? 0} request(s), $${totals.costUsd ?? 0} total, in ${
          usage.buckets?.length ?? 0
        } bucket(s).`,
        usage,
        config.maxTextBytes,
      );
    },
  }),

  defineTool({
    name: 'get_spending_limits',
    title: 'Get budgets and virtual-key limits',
    toolset: 'gateway',
    readOnlyHint: true,
    description:
      'Every spend budget on the team — team-wide or on one virtual key — with its period, ' +
      'limit, live spend, what is left and when it resets, plus each virtual key\'s rate ' +
      'limits and model/provider allow-lists. Use this after a gateway call is refused with ' +
      'HTTP 402 (budget spent) or 429 (rate limit) to see which limit caused it. Read-only: ' +
      'budgets and keys are changed in the dashboard.',
    inputSchema: {},
    async handler(_args, { client, config }) {
      const [budgets, keys] = await Promise.all([
        client.get<BudgetRow[]>('/gateway/budgets'),
        client.get<VirtualKeyRow[]>('/gateway/keys'),
      ]);
      const keyNames = new Map(keys.map((k) => [k.id, k.name]));
      const limits = budgets.map((b) => ({
        id: b.id,
        scope: b.virtualKeyId === null ? 'team' : 'virtual_key',
        virtualKeyId: b.virtualKeyId,
        virtualKeyName: b.virtualKeyId === null ? null : (keyNames.get(b.virtualKeyId) ?? null),
        period: b.period,
        limitUsd: b.limitUsd,
        spendUsd: b.spendUsd,
        remainingUsd: Math.max(0, b.limitUsd - b.spendUsd),
        exhausted: b.spendUsd >= b.limitUsd,
        resetsAt: b.resetsAt,
      }));

      const summary =
        limits.length === 0
          ? `No budgets on this team, so the gateway never refuses a call for spend. ${keys.length} virtual key(s).`
          : `${limits.length} budget(s), ${keys.length} virtual key(s). ` +
            limits
              .map(
                (l) =>
                  `${l.scope === 'team' ? 'Team' : `Key "${l.virtualKeyName ?? l.virtualKeyId}"`} ` +
                  `${l.period}: $${l.spendUsd} of $${l.limitUsd} spent` +
                  (l.exhausted ? ' (EXHAUSTED)' : '') +
                  (l.resetsAt ? `, resets ${l.resetsAt}` : ''),
              )
              .join('; ') +
            '.';
      return okResult(summary, { budgets: limits, virtualKeys: keys }, config.maxTextBytes);
    },
  }),
];

/** One row of `GET /gateway/budgets`. */
interface BudgetRow {
  id: string;
  virtualKeyId: string | null;
  period: string;
  limitUsd: number;
  spendUsd: number;
  resetsAt: string | null;
}

/** One row of `GET /gateway/keys` — already masked by the API: no token, no hash. */
interface VirtualKeyRow {
  id: string;
  name: string;
  [field: string]: unknown;
}
