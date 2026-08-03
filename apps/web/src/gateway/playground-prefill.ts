import type { MessageRole, Span } from '@/api/types';

/** How the Playground should open when navigated to from a trace/feedback. */
export interface PlaygroundPrefill {
  model?: string;
  /** Present when the span referenced a stored prompt — open stored-prompt mode. */
  promptVersionId?: string;
  /** Rendered messages actually sent (used when there is no prompt lineage). */
  messages?: { role: MessageRole; content: string }[];
  /** Variables captured on the span payload, if any. */
  variables?: Record<string, unknown>;
}

/**
 * Decides how to prefill the Playground from a span: prefer prompt lineage
 * (raw templates resolved later via useVersionById); else fall back to the
 * captured sent messages; else model-only.
 */
export function buildPrefillFromSpan(span: Span): PlaygroundPrefill {
  const model = span.model ?? undefined;
  if (span.promptVersionId) {
    return {
      model,
      promptVersionId: span.promptVersionId,
      variables: (span.payload?.variables as Record<string, unknown> | undefined) ?? undefined,
    };
  }
  const input = span.payload?.input;
  if (Array.isArray(input)) {
    return { model, messages: input as { role: MessageRole; content: string }[] };
  }
  return { model };
}

/**
 * Maps a model string captured on a span back to a registered model's
 * `publicName` — the value the Playground picker and the gateway both key on.
 *
 * A span records the *upstream* model actually served (e.g.
 * `xiaomi/mimo-v2.5-20260422`), not the public name the deployment is
 * registered under (e.g. `Mimo`). Sending the upstream string straight back to
 * the gateway fails with "model not registered", so the prefill must resolve it
 * first. We match on `publicName` before `upstreamModel` so a span that already
 * carries a public name still resolves; the upstream match is the common path.
 *
 * @param spanModel - The model string from the span (`span.model`).
 * @param models - The team's registered models.
 * @returns The matching model's `publicName`, or `null` if none matches (e.g.
 *   the deployment was renamed or deleted since the trace was recorded). When
 *   several deployments share one `upstreamModel`, the first is returned — the
 *   span only recorded the upstream string, so there is no finer signal.
 */
export function resolveModelPublicName(
  spanModel: string,
  models: { publicName: string; upstreamModel: string }[],
): string | null {
  return (
    models.find((m) => m.publicName === spanModel)?.publicName ??
    models.find((m) => m.upstreamModel === spanModel)?.publicName ??
    null
  );
}
