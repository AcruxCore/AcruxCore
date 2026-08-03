import { useRef, useState } from 'react';
import type { ChatMessage, CompletionBody, ToolSummary } from '@/api';
import { ApiError, executeTool, gatewayComplete, renderStoredPrompt } from '@/api';
import type { ToolCallStatus } from '../ToolCallCard';
import { appendToolResults, MAX_TOOL_ITERATIONS, nextLoopStep } from '../tool-loop';
import type { PendingToolCall, ToolResultInput } from '../tool-loop';
import type { PlaygroundTelemetry } from './usePlaygroundTelemetry';

/**
 * One model-requested tool call as tracked by the Playground's tool-calling
 * loop, plus its live resolution state and (once resolved) result content.
 */
export interface DisplayToolCall extends PendingToolCall {
  status: ToolCallStatus;
  result: string | null;
  error: string | null;
}

/**
 * Owns the tool-calling loop (TC5): resolving each model-requested call
 * (auto-run for http tools, hand-supplied otherwise), re-sending until a
 * final response, and the live `ToolCallCard` state that drives. Shares the
 * request-lifecycle telemetry with the single-shot path via `telemetry`.
 */
export function useToolLoop(telemetry: PlaygroundTelemetry) {
  // Model-requested tool calls for the round currently awaiting resolution
  // (auto-run for http tools, hand-supplied for client tools), rendered as
  // one ToolCallCard each. Cleared when the loop reaches a final response.
  const [activeCalls, setActiveCalls] = useState<DisplayToolCall[]>([]);
  // Resolvers for tool calls paused on a user action: a `client`-executor
  // call (or one naming a tool that isn't attached/executable) waits here
  // for a hand-typed result; a failed `http` call waits here for "Re-run".
  // Refs (not state) because they hold Promise callbacks, not render data.
  const manualResolversRef = useRef<Map<string, (value: string) => void>>(new Map());
  const retryResolversRef = useRef<Map<string, () => void>>(new Map());

  /** Replaces one call's entry in an `activeCalls` array by id, leaving the rest untouched. */
  function patchCall(id: string, patch: Partial<DisplayToolCall>) {
    setActiveCalls((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  /**
   * Pauses the loop for one tool call until the user supplies a result by
   * hand — used for `client`-executor calls, and as the fallback when a
   * call names a tool that isn't attached (or has no server-side executor).
   */
  function waitForManualResult(callId: string): Promise<string> {
    patchCall(callId, { status: 'manual', error: null });
    return new Promise<string>((resolve) => {
      manualResolversRef.current.set(callId, (value) => {
        patchCall(callId, { status: 'done', result: value });
        resolve(value);
      });
    });
  }

  /** Pauses until the user clicks "Re-run" on a failed http call's card. */
  function waitForRetrySignal(callId: string): Promise<void> {
    return new Promise<void>((resolve) => {
      retryResolversRef.current.set(callId, resolve);
    });
  }

  /** Wired to a card's manual-submit textarea button. */
  function submitManualResult(callId: string, value: string) {
    const resolve = manualResolversRef.current.get(callId);
    if (!resolve) return;
    manualResolversRef.current.delete(callId);
    resolve(value);
  }

  /** Wired to a card's "Re-run" button. */
  function retryCall(callId: string) {
    const resolve = retryResolversRef.current.get(callId);
    if (!resolve) return;
    retryResolversRef.current.delete(callId);
    resolve();
  }

  /**
   * Resolves one pending tool call to its result content: auto-executes an
   * `http` tool via the catalog's execute endpoint (retrying on failure via
   * "Re-run"), or falls back to a hand-typed result — either because the
   * catalog says the resolved version has no server-side executor
   * (`client`, surfaced as a 422 `NOT_EXECUTABLE`), or because the call
   * names a tool the user never attached.
   *
   * @param call - The pending call (name + parsed arguments) from the model.
   * @param tool - The attached tool matching `call.name`, or `undefined`.
   * @param traceId - Trace to nest this tool's span into (bundles the run into one trace).
   * @returns The result content to send back as the `tool` message.
   */
  async function resolveToolCall(
    call: PendingToolCall,
    tool: ToolSummary | undefined,
    traceId: string,
  ): Promise<string> {
    if (!tool) return waitForManualResult(call.id);
    for (;;) {
      patchCall(call.id, { status: 'running', error: null });
      try {
        const exec = await executeTool(tool.id, {
          arguments: call.arguments,
          traceContext: { traceId },
        });
        const content = typeof exec.result === 'string' ? exec.result : JSON.stringify(exec.result, null, 2);
        patchCall(call.id, { status: 'done', result: content });
        return content;
      } catch (e) {
        if (e instanceof ApiError && e.code === 'NOT_EXECUTABLE') {
          return waitForManualResult(call.id);
        }
        const message = e instanceof Error ? e.message : 'Tool execution failed.';
        patchCall(call.id, { status: 'error', error: message });
        await waitForRetrySignal(call.id);
        // loop retries the execute call
      }
    }
  }

  /**
   * Runs the tool-calling loop: sends `initialBody`, and for every tool-call
   * response resolves each pending call (auto or hand-supplied — see
   * {@link resolveToolCall}), appends the results, and re-sends — up to
   * {@link MAX_TOOL_ITERATIONS} times — until the model returns a normal
   * response. Mirrors the single-shot path's telemetry/error state updates
   * so the Telemetry/Response sections behave the same either way.
   *
   * @param buildBody - Builds the request body from the current editor state; may throw
   *   a user-facing validation error, in which case telemetry is left untouched apart
   *   from the error/state fields (matches the single-shot path's validation behavior).
   * @param attached - Tools attached to this request (drives `tool_refs` and resolution).
   */
  async function run(buildBody: () => CompletionBody, attached: ToolSummary[]): Promise<void> {
    let initialBody: CompletionBody;
    try {
      initialBody = buildBody();
    } catch (e) {
      telemetry.setError(e instanceof Error ? e.message : 'Invalid request');
      telemetry.setState('error');
      return;
    }

    const toolsByName = new Map(attached.map((t) => [t.name, t]));
    const baseBody: CompletionBody = { ...initialBody, tool_refs: attached.map((t) => ({ name: t.name })) };

    telemetry.reset();
    setActiveCalls([]);

    // The client-side tool loop needs a concrete message list to append the
    // assistant tool-call and tool-result turns to each round. Messages mode and
    // an edited template already provide raw `messages`. An untouched stored
    // prompt sends a `{name, alias}` reference instead — so render it to concrete
    // messages first (variables applied server-side), then drive the loop with
    // those, dropping the reference from the per-iteration body.
    let messages: ChatMessage[];
    if (initialBody.messages) {
      messages = initialBody.messages;
    } else if (initialBody.prompt) {
      try {
        const rendered = await renderStoredPrompt(
          initialBody.prompt.name,
          initialBody.prompt.alias,
          initialBody.prompt.variables,
        );
        messages = rendered.messages;
      } catch (e) {
        telemetry.fail(e, 'Could not render the stored prompt.');
        return;
      }
      baseBody.prompt = undefined;
    } else {
      telemetry.setError('Add at least one message with content.');
      telemetry.setState('error');
      return;
    }

    // Fold the whole run — every completion round-trip plus each tool
    // execution — into a single trace, so it reads as one input → tool →
    // output flow instead of scattering across separate top-level traces.
    const traceId = crypto.randomUUID();
    const firstUser = messages.find((m) => m.role === 'user')?.content?.trim();
    const traceName = firstUser ? firstUser.slice(0, 80) : 'Playground run';

    try {
      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        const result = await gatewayComplete({ ...baseBody, messages }, { traceId, traceName });
        telemetry.setMeta(result.meta);
        telemetry.setLatencyMs(result.latencyMs);
        telemetry.setUsage({
          prompt: result.completion.usage.prompt_tokens,
          completion: result.completion.usage.completion_tokens,
        });
        const choice = result.completion.choices[0];
        if (!choice) throw new Error('The gateway returned no completion choice.');

        const step = nextLoopStep(messages, choice);
        if (step.done) {
          telemetry.setResponse(choice.message.content ?? '');
          // Leave the resolved tool-call cards on screen so the run stays
          // legible (input → tool → output). They're cleared at the start of
          // the next run(), not here.
          telemetry.setState('done');
          return;
        }

        setActiveCalls(step.pendingCalls.map((c) => ({ ...c, status: 'running', result: null, error: null })));
        const results: ToolResultInput[] = await Promise.all(
          step.pendingCalls.map(async (call): Promise<ToolResultInput> => {
            const content = await resolveToolCall(call, toolsByName.get(call.name), traceId);
            return { toolCallId: call.id, content };
          }),
        );
        messages = appendToolResults(messages, step.assistantMessage, results);
      }
      telemetry.setError(`Stopped after ${MAX_TOOL_ITERATIONS} tool iterations without a final response.`);
      telemetry.setState('error');
    } catch (e) {
      telemetry.fail(e, 'Request failed');
    }
  }

  return { activeCalls, setActiveCalls, run, submitManualResult, retryCall };
}
