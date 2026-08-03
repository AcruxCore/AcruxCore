import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Badge, Button, MonoBlock, useToast } from '@/ui';
import { usePatchFeedback, usePostFeedback } from '@/api';
import { useAuth } from '@/auth/AuthContext';
import { buildPrefillFromSpan } from '@/gateway/playground-prefill';
import { formatCount, formatLatency, formatUsd } from './format';
import { Collapsible } from './Collapsible';
import type { Feedback, Span } from '@/api/types';

export interface SpanPanelProps {
  span: Span;
  traceId: string;
  /** This span's own feedback rows (already filtered by the caller), newest-first. */
  feedback: Feedback[];
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
        {span.model != null && <Metric label="Model" value={span.model} />}
        {span.provider != null && <Metric label="Provider" value={span.provider} />}
        {span.totalTokens != null && <Metric label="Tokens" value={formatCount(span.totalTokens)} />}
        {span.costUsd != null && <Metric label="Cost" value={formatUsd(span.costUsd)} />}
        <Metric label="Latency" value={formatLatency(span.latencyMs)} />
        {span.errorMessage && <Metric label="Error" value={<span className="text-danger">{span.errorMessage}</span>} />}
      </section>

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
        <div className="flex flex-wrap gap-1.5" data-testid="span-tags">
          {span.tags.map((tag) => (
            <Badge key={tag} className="px-2 py-0.5 text-[11px]">{tag}</Badge>
          ))}
        </div>
      )}

      {hasAttributes && (
        <section className="rounded-lg border border-line-soft bg-surface px-3 py-2" data-testid="span-attributes">
          {/* Platform-written facts about the span, as opposed to the caller-supplied
              metadata below: which executor ran a tool, which tool version it was, whether
              a response transform applied, whether a completion was a cache hit. */}
          <Collapsible label="Attributes" defaultOpen testId="span-attributes-toggle">
            {Object.entries(span.attributes).map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-3 border-b border-line-soft py-1.5 text-[13px] last:border-0">
                <span className="text-muted">{k}</span>
                <span className="truncate font-mono text-ink">{typeof v === 'string' ? v : JSON.stringify(v)}</span>
              </div>
            ))}
          </Collapsible>
        </section>
      )}

      {hasMetadata && (
        <section className="rounded-lg border border-line-soft bg-surface px-3 py-2" data-testid="span-metadata">
          <Collapsible label="Metadata" testId="span-metadata-toggle">
            {Object.entries(span.metadata).map(([k, v]) => (
              <div key={k} className="flex items-center justify-between border-b border-line-soft py-1.5 text-[13px] last:border-0">
                <span className="text-muted">{k}</span>
                <span className="font-mono text-ink">{typeof v === 'string' ? v : JSON.stringify(v)}</span>
              </div>
            ))}
          </Collapsible>
        </section>
      )}

      {hasPayload ? (
        <div className="flex flex-col gap-3">
          {span.payload!.input !== undefined && (
            <MonoBlock label="Input" value={JSON.stringify(span.payload!.input, null, 2)} />
          )}
          {span.payload!.output !== undefined && (
            <MonoBlock label="Output" value={JSON.stringify(span.payload!.output, null, 2)} />
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
