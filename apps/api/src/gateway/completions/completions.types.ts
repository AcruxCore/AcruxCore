import { z } from 'zod';
import type { ChatMessage, NormalizedRequest, NormalizedResponse } from '../providers/types';

/** OpenAI tool (function) definition. `parameters` is an arbitrary JSON Schema object. */
export const ToolDefinitionSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.unknown()).optional(),
  }),
});

/** OpenAI tool_choice. */
export const ToolChoiceSchema = z.union([
  z.enum(['auto', 'none', 'required']),
  z.object({ type: z.literal('function'), function: z.object({ name: z.string().min(1) }) }),
]);

/** A model-emitted tool call (arguments is a JSON string). */
export const ToolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal('function'),
  function: z.object({ name: z.string().min(1), arguments: z.string() }),
});

/** Catalog reference: resolve a stored tool version to an OpenAI tool definition. */
export const ToolRefSchema = z.object({ name: z.string().min(1), alias: z.string().optional() });

/** A single chat message (canonical OpenAI shape), including tool calls and tool results. */
export const ChatMessageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'tool'], {
      errorMap: () => ({ message: "role must be 'system', 'user', 'assistant', or 'tool'" }),
    }),
    // `.default(null)` (not the brief's bare `.optional()`) so a caller may still
    // OMIT `content` — valid OpenAI shape for an assistant message that only carries
    // `tool_calls` — while the inferred DTO type collapses to `string | null` (no
    // `undefined`), matching `ChatMessage.content` exactly. superRefine below still
    // rejects a missing/null content where the role requires a real string.
    content: z.string().nullable().default(null),
    tool_calls: z.array(ToolCallSchema).optional(),
    tool_call_id: z.string().optional(),
  })
  .superRefine((m, ctx) => {
    if (m.role === 'tool' && (m.tool_call_id === undefined || m.tool_call_id.length === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A tool message requires tool_call_id.' });
    }
    if (m.role === 'tool' && (m.content === undefined || m.content === null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A tool message requires string content.' });
    }
    // system/user must have non-empty content; assistant may have null content when tool_calls present.
    if ((m.role === 'system' || m.role === 'user') && (m.content === undefined || m.content === null || m.content.length === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'content must not be empty' });
    }
    if (m.role === 'assistant' && (m.content === undefined || m.content === null) && (m.tool_calls === undefined || m.tool_calls.length === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'assistant message needs content or tool_calls' });
    }
  });

/**
 * A prompt reference (G8) — resolve a stored prompt by name + alias and render it
 * with Phase 1's engine to produce the `messages`. Supplied instead of `messages`.
 */
export const PromptRefSchema = z.object({
  name: z.string().min(1, 'prompt.name is required'),
  alias: z.string().min(1, 'prompt.alias is required'),
  variables: z.record(z.unknown()).default({}),
});

/** Validated prompt reference (G8). */
export type PromptRef = z.infer<typeof PromptRefSchema>;

/**
 * Optional per-request gateway control knobs (G5). Stripped from the body before it
 * reaches the provider adapter so the outgoing request stays OpenAI-compatible.
 */
export const GatewayControlSchema = z
  .object({
    /** Max retries on the SAME connection for a transient error (default 1, capped at 5). */
    maxRetries: z.number().int().min(0).max(5).optional(),
    /** Whether to fall back to the next connection on failure (default true). Reserved for v1. */
    fallback: z.boolean().optional(),
  })
  .strict();

/** Validated gateway control object (G5). */
export type GatewayControl = z.infer<typeof GatewayControlSchema>;

/** Structured-output response format schema (OpenAI shape). */
export const ResponseFormatSchema = z.union([
  z.object({ type: z.literal('text') }),
  z.object({ type: z.literal('json_object') }),
  z.object({
    type: z.literal('json_schema'),
    json_schema: z.object({
      name: z.string(),
      schema: z.record(z.unknown()).optional(),
      strict: z.boolean().optional(),
    }),
  }),
]);

/**
 * Validated body for POST /gateway/chat/completions (OpenAI-compatible).
 *
 * A caller supplies EITHER raw `messages` OR a `prompt` reference (G8) — exactly
 * one. Supplying both or neither is a validation error (superRefine). When
 * `prompt` is present the pipeline fills `messages` from Phase 1's render engine.
 */
export const ChatCompletionRequestSchema = z
  .object({
    model: z.string().min(1).optional(),
    messages: z.array(ChatMessageSchema).min(1, 'messages must be a non-empty array').optional(),
    /** G8: resolve a stored prompt instead of sending raw messages. */
    prompt: PromptRefSchema.optional(),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().positive().optional(),
    top_p: z.number().min(0).max(1).optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    stream: z.boolean().optional(),
    /** G5: optional routing/retry control; stripped before the adapter call. */
    gateway: GatewayControlSchema.optional(),
    /** B1: values for `{{ placeholders }}` in ad-hoc `messages`; rendered server-side. */
    variables: z.record(z.unknown()).optional(),
    /** Q5: inline OpenAI-shaped tool definitions. */
    tools: z.array(ToolDefinitionSchema).optional(),
    /** Q5: tool usage control. */
    tool_choice: ToolChoiceSchema.optional(),
    /** Q5: resolve stored tool versions from the catalog and merge into `tools`. */
    tool_refs: z.array(ToolRefSchema).optional(),
    /** Structured-output response format. */
    response_format: ResponseFormatSchema.optional(),
  })
  .superRefine((data, ctx) => {
    const hasMessages = data.messages !== undefined;
    const hasPrompt = data.prompt !== undefined;
    if (hasMessages === hasPrompt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide exactly one of `messages` or `prompt`.',
      });
    }
    // B1: top-level `variables` only applies to ad-hoc `messages`. A `prompt` ref
    // has its own `variables` and is rendered by the prompt path — combining them
    // would double-render, so reject it.
    if (data.prompt !== undefined && data.variables !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Put variables inside `prompt.variables`; top-level `variables` is only for raw `messages`.',
      });
    }
    // Fast path for the common case: inline `tools`/`tool_choice`/`tool_refs`
    // alongside `response_format` on the same raw body. This is cheaper than
    // waiting for the service layer, but it is NOT the full guarantee — a
    // stored prompt's auto-attached tools, or a `tool_refs` lookup's resolved
    // tools, don't exist yet at this point (they're populated by
    // `GatewayService.mergeAutoAttachedTools`/`resolveAndMergeTools` after this
    // schema runs). The authoritative check is `GatewayService`'s
    // `assertResponseFormatToolsCompatible`, which re-checks post-merge.
    if (
      data.response_format !== undefined &&
      (data.tools !== undefined || data.tool_choice !== undefined || data.tool_refs !== undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'response_format cannot be combined with tools, tool_choice, or tool_refs on the same request',
        path: ['response_format'],
      });
    }
  });

/** Typed request DTO; structurally a NormalizedRequest plus the optional gateway control. */
export type ChatCompletionRequestDto = z.infer<typeof ChatCompletionRequestSchema>;

/**
 * Request type the pipeline accepts (G5): the canonical adapter-facing
 * {@link NormalizedRequest} plus the optional `gateway` control field.
 * `GatewayService.complete` destructures `gateway` off before building the
 * `NormalizedRequest` handed to the adapter.
 */
export type GatewayCompletionRequest = Omit<NormalizedRequest, 'messages' | 'model'> & {
  /** Optional at the pipeline boundary: filled from a version's bound model (#12)
   * when absent, or rejected (400) if still empty after resolution. */
  model?: string;
  /** Optional at the pipeline boundary: filled from `prompt` (G8) when absent. */
  messages?: ChatMessage[];
  /** G8 prompt reference; the pipeline renders it into `messages` and strips it. */
  prompt?: PromptRef;
  /** B1: values for `{{ }}` in ad-hoc `messages`; rendered then stripped. */
  variables?: Record<string, unknown>;
  gateway?: GatewayControl;
  /** Q5: catalog references, resolved+merged into `tools` in the service (Task 5). */
  tool_refs?: { name: string; alias?: string }[];
};

/**
 * Auth/scope/limit context threaded into the pipeline. In G2 it is built from the
 * session / personal API key (teamId + actorId only). G3 populates the rest from a
 * virtual key.
 */
export interface GatewayCallContext {
  teamId: string;
  virtualKeyId?: string;
  actorId?: string;
  allowedModels?: string[] | null;
  allowedProviders?: string[] | null;
  maxRpm?: number | null;
  maxTpm?: number | null;
  cacheTtlSeconds?: number | null;
  /** T1 trace context: an existing trace to nest this call's span under. */
  traceId?: string;
  /** T1 trace context: the parent span's opaque ref (OTel span id). */
  parentSpanRef?: string;
  /** T1 trace context: session id, used only when minting a new trace. */
  sessionId?: string;
  /** T1 trace context: per-request payload-capture override (FAQ Q5). */
  capturePayloads?: boolean;
  /**
   * T8 trace context: caller-supplied trace name; absent → timestamp fallback (FAQ
   * Q12). On an existing trace, supplying this overwrites the current name
   * (last-explicit-write-wins, T9, FAQ Q11 revised); omitting it never resets one.
   */
  traceName?: string;
  /** T8 trace context: tags to set (new trace) or merge into (existing trace, FAQ Q11). */
  traceTags?: string[];
  /** T8 trace context: JSON metadata to set (new trace) or merge into (existing trace, FAQ Q11). */
  traceMetadata?: Record<string, unknown>;
  /** T9: caller-supplied name for THIS call's span; absent → timestamp fallback (FAQ Q15). */
  spanName?: string;
  /** T9: caller-supplied tags for THIS call's span (no merge — always a new span row, FAQ Q13). */
  spanTags?: string[];
  /** T9: caller-supplied JSON metadata for THIS call's span (FAQ Q13). */
  spanMetadata?: Record<string, unknown>;
}

/** Result of a completed gateway call: the OpenAI body plus metadata for headers/logging. */
export interface GatewayResult {
  body: NormalizedResponse;
  provider: string;
  model: string;
  costUsd: number | null;
  cacheHit: boolean;
  requestId: string;
  /** RPM headroom after this call; undefined when no RPM limit applies. Surfaced as x-gateway-ratelimit-remaining. (G4) */
  rateLimitRemaining?: number;
  /**
   * The trace this call's `llm` span landed in — either the caller-supplied
   * `x-trace-id` or the one the gateway minted. Surfaced as `x-gateway-trace-id`
   * so a client-side tool loop can thread all its spans into one trace. Undefined
   * when the best-effort span write produced nothing.
   */
  traceId?: string;
  /**
   * The opaque ref of the `llm` span this call recorded. Surfaced as
   * `x-gateway-span-id` so a caller can nest child (e.g. `tool`) spans under it.
   */
  spanRef?: string;
}

/**
 * Input for GatewayRepository.recordRequest — one gateway_requests row. `promptVersionId`
 * is populated by G8 lineage and `meta` by G5 routing; both are absent/null in G2.
 */
export interface RecordRequestInput {
  /**
   * Optional pre-generated row id. Streaming (G7) supplies this so the id flushed
   * in the `x-gateway-request-id` header (before the row is written at stream end)
   * matches the persisted row. Omitted for non-streaming — the DB default generates it.
   */
  id?: string;
  teamId: string;
  virtualKeyId?: string | null;
  providerConnectionId?: string | null;
  /** The registered model (deployment) that served this request; null when unresolved. */
  gatewayModelId?: string | null;
  provider?: string | null;
  requestedModel: string;
  resolvedModel?: string | null;
  status: 'success' | 'error' | 'cache_hit';
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd?: number | null;
  latencyMs?: number | null;
  cacheHit: boolean;
  /** Populated by G8 lineage; null in G2. */
  promptVersionId?: string | null;
  /** Populated by G5 routing (needs the `meta` JSONB column added in G5); absent in G2. */
  meta?: Record<string, unknown> | null;
  errorCode?: string | null;
}
