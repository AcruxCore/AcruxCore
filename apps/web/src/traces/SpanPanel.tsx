import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Badge, Button, MonoBlock, useToast } from '@/ui';
import { usePatchFeedback, usePostFeedback } from '@/api';
import { useAuth } from '@/auth/AuthContext';
import { buildPrefillFromSpan } from '@/gateway/playground-prefill';
import { formatCount, formatLatency, formatPayload, formatUsd } from './format';
import { Collapsible } from './Collapsible';
import { KeyValueRows } from './KeyValueRows';
import { summarizeAttempts } from './attempt-trail';
import type { Feedback, Span } from '@/api/types';

export interface SpanPanelProps {
  span: Span;
  traceId: string;
  /** This span's own feedback rows (already filtered by the caller), newest-first. */
  feedback: Feedback[];
}

/**
 * Readable names for the `errorType` a classifier wrote onto the span (issue #452).
 * Mirrors `SpanErrorType` in `apps/api/src/traces/spans/span-failure.ts`. A slug we do
 * not recognise is shown verbatim rather than hidden — a newer API writing a type this
 * build has not heard of must still be readable.
 */
const ERROR_TYPE_LABELS: Record<string, string> = {
  transport: 'Never reached the server',
  http_status: 'Upstream returned an error status',
  tool_declared: 'The tool reported a failure',
  schema_mismatch: 'Result did not match the declared shape',
  transform: 'A transform failed',
  provider_error: 'The model provider failed',
};

/** The classifier's own fields, as they are written into `span.attributes`. */
interface FailureAttributes {
  errorType?: string;
  /** The tool owner's own slug, when the classification came from the tool rather than a
   *  platform rule. Open-ended, so it is shown verbatim beside the readable label. */
  errorCode?: string;
  errorDetail?: string;
  warning?: { type?: string; message?: string };
  httpStatus?: number;
  attempts?: number;
  trail?: unknown[];
}

/** One metric row (label + monospace value). */
function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-line-soft py-1.5 text-[13px] last:border-0">
      <span className="text-muted">{label}</span>
      <span className="font-mono text-ink">{value}</span>
    </div>
  );
}

/**
 * The inline panel that expands below a span row in {@link SpanTree} (Q17 — replaces
 * the old `SpanDetailDrawer` sidebar). Shows the span's metrics, its own tags
 * (distinct from the trace's, Q19), platform-written attributes, collapsible metadata,
 * captured payload (or a "not captured" hint), and a compact thumbs up/down feedback
 * control (Q16, Q22).
 *
 * Rendered as a sibling of the clickable row, never nested inside it — it contains
 * its own buttons/inputs, which cannot be descendants of the row's `<button>`.
 */
export function SpanPanel({ span, traceId, feedback }: SpanPanelProps) {
  const toast = useToast();
  const navigate = useNavigate();
  const { me } = useAuth();
  const post = usePostFeedback(traceId);
  const patch = usePatchFeedback(traceId);
  const hasPayload = span.payload && (span.payload.input !== undefined || span.payload.output !== undefined);
  const hasMetadata = Object.keys(span.metadata).length > 0;
  const hasAttributes = Object.keys(span.attributes ?? {}).length > 0;
  // Why this span is red, or what is odd about a green one. Read out of `attributes`
  // rather than being its own column, so a new failure kind needs no migration.
  const failure = (span.attributes ?? {}) as FailureAttributes;
  const warning = failure.warning;
  // "4 (retried or failed over)" never said which of the two happened, and the trail it
  // hid in a tooltip identified models by uuid — so the panel could not answer the only
  // two questions a reader has: retry or fallback, and which model actually answered.
  const attemptSummary = summarizeAttempts(failure.attempts, failure.trail);

  // The caller's own feedback row on this span, if any (Q22 — a real toggle:
  // switching arrows PATCHes this row instead of appending a new one).
  const myRow = me ? feedback.find((f) => f.createdBy === me.user.id) ?? null : null;

  const rate = (rating: 1 | -1) => {
    if (myRow) {
      if (myRow.rating === rating) return; // already your vote — no "neutral" state to fall back to
      patch.mutate(
        { feedbackId: myRow.id, body: { rating } },
        { onError: () => toast.error('Could not update feedback') },
      );
      return;
    }
    post.mutate(
      { rating, spanId: span.spanId, source: 'developer' },
      { onError: () => toast.error('Could not add feedback') },
    );
  };

  const isPending = post.isPending || patch.isPending;

  return (
    <div
      className="flex flex-col gap-3 border-b border-line-soft bg-bg px-4 py-3 last:border-b-0"
      style={{ paddingLeft: '2.5rem' }}
      data-testid="span-panel"
    >
      <section className="rounded-lg border border-line-soft bg-surface px-3 py-2" data-testid="span-metrics">
        {span.model != null && (
          <Metric
            label="Model"
            value={
              <Link to={`/traces?model=${encodeURIComponent(span.model)}`} className="text-varhi hover:underline">
                {span.model}
              </Link>
            }
          />
        )}
        {span.provider != null && <Metric label="Provider" value={span.provider} />}
        {span.totalTokens != null && <Metric label="Tokens" value={formatCount(span.totalTokens)} />}
        {span.costUsd != null && <Metric label="Cost" value={formatUsd(span.costUsd)} />}
        <Metric label="Latency" value={formatLatency(span.latencyMs)} />
        {failure.httpStatus != null && failure.httpStatus > 0 && (
          <Metric label="HTTP status" value={failure.httpStatus} />
        )}
        {attemptSummary && (
          <Metric
            label="Attempts"
            value={
              <span>
                {failure.attempts ?? attemptSummary.rows[0].attempts}
                <span className="ml-1.5 text-warn">{attemptSummary.verdict}</span>
              </span>
            }
          />
        )}
        {failure.errorType && (
          <Metric
            label="Failure"
            value={
              <span className={span.status === 'error' ? 'text-danger' : 'text-warn'}>
                {ERROR_TYPE_LABELS[failure.errorType] ?? failure.errorType}
                {failure.errorCode && (
                  <span className="ml-1.5 font-mono text-[11.5px] text-muted">{failure.errorCode}</span>
                )}
              </span>
            }
          />
        )}
        {span.errorMessage && <Metric label="Error" value={<span className="text-danger">{span.errorMessage}</span>} />}
        {!span.errorMessage && failure.errorDetail && (
          <Metric label="Detail" value={failure.errorDetail} />
        )}
      </section>

      {/* One row per model the gateway tried, in order. The Attempts metric says what
          happened; this says to whom, because a uuid in the raw trail cannot. */}
      {attemptSummary && (
        <section
          className="rounded-lg border border-line-soft bg-surface px-3 py-2"
          data-testid="span-attempt-trail"
        >
          <div className="mb-1 text-[11px] uppercase tracking-wide text-muted">Attempt trail</div>
          {attemptSummary.rows.map((row, i) => (
            <div
              key={`${row.model}-${i}`}
              className="border-b border-line-soft py-1 text-[13px] last:border-0"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate">
                  <span className="mr-1.5 font-mono text-[11px] text-faint">{i + 1}</span>
                  <span className="font-mono text-ink">{row.model}</span>
                  {row.upstreamModel && (
                    <span className="ml-1.5 font-mono text-[11.5px] text-muted">{row.upstreamModel}</span>
                  )}
                </span>
                <span className="shrink-0 font-mono text-[12px]">
                  {row.attempts > 1 && (
                    <span className="mr-1.5 text-muted">{row.attempts} calls</span>
                  )}
                  <span className={row.outcome === 'answered' ? 'text-ok' : 'text-danger'}>
                    {row.outcome}
                  </span>
                </span>
              </div>
              {/* The status says an attempt failed; only the provider's own words say why.
                  A model that answered after retries shows what those retries were for. */}
              {row.errorMessage && (
                <div className="mt-0.5 text-[12px] leading-snug text-muted">
                  {row.retriedAfterStatus && (
                    <span className="mr-1.5 font-mono text-warn">
                      earlier calls failed {row.retriedAfterStatus}
                    </span>
                  )}
                  {row.errorMessage}
                </div>
              )}
            </div>
          ))}
        </section>
      )}

      {/* A warning is not a verdict about the run, so it never turns the span red — it
          gets its own band instead, and its own `warning:yes` filter. */}
      {warning?.message && (
        <div
          className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[13px] text-ink"
          data-testid="span-warning"
        >
          <span className="font-mono text-[11.5px] uppercase tracking-wide text-warn">
            {warning.type ?? 'warning'}
          </span>
          <div className="mt-0.5">{warning.message}</div>
        </div>
      )}

      {(span.promptVersionId || span.gatewayRequestId || span.model != null) && (
        <div className="flex flex-col gap-1.5">
          {span.promptVersionId && (
            <Link
              to={`/traces?prompt_version_id=${span.promptVersionId}`}
              className="text-[13px] text-varhi hover:underline"
              data-testid="span-prompt-version"
            >
              View traces for this prompt version →
            </Link>
          )}
          {span.gatewayRequestId && (
            <div className="text-[12px] text-muted">
              Linked gateway request{' '}
              <span className="font-mono text-faint">{span.gatewayRequestId.slice(0, 8)}</span>
            </div>
          )}
          {span.model != null && (
            <Button
              size="sm"
              variant="ghost"
              className="self-start"
              onClick={() => navigate('/gateway/playground', { state: buildPrefillFromSpan(span) })}
              data-testid="span-open-in-playground"
            >
              Open in Playground →
            </Button>
          )}
        </div>
      )}

      {span.tags.length > 0 && (
        // Click-to-filter: a value you can see is a filter you should not have
        // to retype. Each tag opens the trace list already narrowed to it.
        <div className="flex flex-wrap gap-1.5" data-testid="span-tags">
          {span.tags.map((tag) => (
            <Link key={tag} to={`/traces?tags=${encodeURIComponent(tag)}`} title={`Filter traces by ${tag}`}>
              <Badge className="px-2 py-0.5 text-[11px] hover:border-varhi">{tag}</Badge>
            </Link>
          ))}
        </div>
      )}

      {hasAttributes && (
        <section className="rounded-lg border border-line-soft bg-surface px-3 py-2" data-testid="span-attributes">
          {/* Platform-written facts about the span, as opposed to the caller-supplied
              metadata below: which executor ran a tool, which tool version it was, whether
              a response transform applied, whether a completion was a cache hit. */}
          <Collapsible label="Attributes" defaultOpen testId="span-attributes-toggle">
            <KeyValueRows entries={span.attributes} />
          </Collapsible>
        </section>
      )}

      {hasMetadata && (
        <section className="rounded-lg border border-line-soft bg-surface px-3 py-2" data-testid="span-metadata">
          <Collapsible label="Metadata" testId="span-metadata-toggle">
            <KeyValueRows entries={span.metadata} />
          </Collapsible>
        </section>
      )}

      {hasPayload ? (
        <div className="flex flex-col gap-3">
          {span.payload!.input !== undefined && (
            <MonoBlock label="Input" value={formatPayload(span.payload!.input)} />
          )}
          {span.payload!.output !== undefined && (
            <MonoBlock label="Output" value={formatPayload(span.payload!.output)} />
          )}
        </div>
      ) : (
        <p className="text-[12px] text-faint" data-testid="span-payload-hint">
          Payload not captured.{' '}
          <Link to="/observability/settings" className="text-accent hover:underline">
            Enable payload capture
          </Link>{' '}
          to store message bodies.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-line-soft pt-2" data-testid="span-feedback">
        <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">Feedback</span>
        {feedback.map((f) => (
          <span key={f.id} className={`font-mono text-[13px] ${f.rating != null && f.rating < 0 ? 'text-danger' : 'text-ok'}`}>
            {f.rating != null && f.rating > 0 ? '▲' : f.rating != null && f.rating < 0 ? '▼' : ''}
          </span>
        ))}
        <div className="ml-auto flex gap-1">
          <Button
            variant={myRow?.rating === 1 ? 'primary' : 'default'}
            size="sm"
            onClick={() => rate(1)}
            disabled={isPending}
            data-testid="span-feedback-up"
            aria-label="Thumbs up this span"
          >
            ▲
          </Button>
          <Button
            variant={myRow?.rating === -1 ? 'danger' : 'default'}
            size="sm"
            onClick={() => rate(-1)}
            disabled={isPending}
            data-testid="span-feedback-down"
            aria-label="Thumbs down this span"
          >
            ▼
          </Button>
        </div>
      </div>
    </div>
  );
}
