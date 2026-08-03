/** An OpenAI-shaped tool (function) definition, as sent by the client and forwarded to providers. */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    /** JSON Schema object for the function's parameters. */
    parameters?: Record<string, unknown>;
  };
}

/** OpenAI `tool_choice`: a mode string or a forced single function. */
export type ToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } };

/** Structured-output response format request (OpenAI shape). */
export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | {
      type: 'json_schema';
      json_schema: {
        name: string;
        schema?: Record<string, unknown>;
        strict?: boolean;
      };
    };

/** A single tool call emitted by the model (OpenAI shape). `arguments` is a JSON string. */
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  /** Position among parallel tool calls; populated on streaming deltas to correlate fragments of the same call across chunks, typically absent/unused on complete non-streaming tool calls. */
  index?: number;
}

/** A single chat message in the canonical (OpenAI) shape. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Null for an assistant message that only carries tool_calls, or a tool result's raw string. */
  content: string | null;
  /** Present on assistant messages that call tools. */
  tool_calls?: ToolCall[];
  /** Present on `tool` role messages — links the result to the assistant's call. */
  tool_call_id?: string;
}

/** Canonical chat-completion request. Identical to the OpenAI Chat Completions body we accept. */
export interface NormalizedRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stop?: string | string[];
  /** Handled in G7; false/absent in G2. */
  stream?: boolean;
  /** OpenAI-shaped tool definitions available to the model. */
  tools?: ToolDefinition[];
  /** How the model should use tools. */
  tool_choice?: ToolChoice;
  /** Structured-output request. OpenAI/Gemini translate natively; Anthropic is translated into a
   * forced tool call (see anthropic.adapter.ts). Never combined with `tools`/`tool_choice` by the
   * time a `NormalizedRequest` reaches an adapter: the gateway's Zod layer rejects the combination
   * when it appears directly on the raw request body, and `GatewayService.assertResponseFormatToolsCompatible`
   * re-checks after prompt-auto-attached tools and `tool_refs`-resolved tools have been merged onto
   * `tools` (both happen after Zod validation, so Zod alone cannot see them) — see
   * `gateway.service.ts`.
   *
   * Caveat: for an `openai_compatible` connection, `response_format` passes through unmodified to
   * whatever upstream/model is configured — the gateway cannot guarantee the upstream honors it, so
   * a caller may see it silently ignored (see the Supervisor Multi-Agent tutorial for a worked
   * example against OpenRouter). */
  response_format?: ResponseFormat;
}

/** Token accounting reported by the provider, in OpenAI field names. */
export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/**
 * Canonical chat-completion response (OpenAI shape).
 * `object` and `created` are optional passthroughs kept for byte-compatibility with
 * strict OpenAI clients (see contract note in the plan); consumers only rely on
 * `id`, `model`, `choices`, and `usage`.
 */
export interface NormalizedResponse {
  id: string;
  model: string;
  object?: string;
  created?: number;
  choices: { index: number; message: ChatMessage; finish_reason: string | null }[];
  usage: Usage;
}

/** Decrypted credentials handed to an adapter. `baseUrl` overrides the provider default. */
export interface ProviderCredentials {
  apiKey: string;
  baseUrl?: string;
}

/** A single streamed delta. Declared here; consumed by the G7 streaming step. */
export interface StreamChunk {
  delta: string;
  finish_reason: string | null;
  usage?: Usage;
  /** Incremental tool-call deltas (OpenAI streaming shape), when the model is calling tools. */
  tool_calls?: ToolCall[];
}
