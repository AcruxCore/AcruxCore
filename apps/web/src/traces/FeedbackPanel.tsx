import { useState } from 'react';
import { Button, Input, useToast } from '@/ui';
import { usePatchFeedback, usePostFeedback } from '@/api';
import { useAuth } from '@/auth/AuthContext';
import { SOURCE_LABELS } from './format';
import { timeAgo } from '@/lib/format';
import type { Feedback } from '@/api/types';

export interface FeedbackPanelProps {
  traceId: string;
  feedback: Feedback[];
}

/**
 * Renders a trace's feedback list and a compact add/edit form (rating ▲/▼ +
 * optional label/comment). Each feedback row the caller authored gets an Edit
 * affordance that switches the same form into edit mode (Q21 — author-only,
 * in place, no version history).
 */
export function FeedbackPanel({ traceId, feedback }: FeedbackPanelProps) {
  const toast = useToast();
  const { me } = useAuth();
  const post = usePostFeedback(traceId);
  const patch = usePatchFeedback(traceId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rating, setRating] = useState<number | null>(null);
  const [label, setLabel] = useState('');
  const [comment, setComment] = useState('');

  const resetForm = () => {
    setEditingId(null);
    setRating(null);
    setLabel('');
    setComment('');
  };

  const startEdit = (f: Feedback) => {
    setEditingId(f.id);
    setRating(f.rating);
    setLabel(f.label ?? '');
    setComment(f.comment ?? '');
  };

  const submit = () => {
    if (rating === null && !label && !comment) {
      toast.error('Add a rating, label, or comment.');
      return;
    }
    if (editingId) {
      patch.mutate(
        { feedbackId: editingId, body: { rating, label: label || null, comment: comment || null } },
        {
          onSuccess: () => {
            toast.success('Feedback updated');
            resetForm();
          },
          onError: () => toast.error('Could not update feedback'),
        },
      );
      return;
    }
    post.mutate(
      { rating: rating ?? undefined, label: label || undefined, comment: comment || undefined, source: 'developer' },
      {
        onSuccess: () => {
          toast.success('Feedback added');
          resetForm();
        },
        onError: () => toast.error('Could not add feedback'),
      },
    );
  };

  const isPending = post.isPending || patch.isPending;

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4" data-testid="feedback-panel">
      <h2 className="text-[15px] font-semibold">Feedback</h2>
      <ul className="flex flex-col gap-2">
        {feedback.length === 0 && <li className="text-[13px] text-faint">No feedback yet.</li>}
        {feedback.map((f) => (
          <li
            key={f.id}
            className="flex flex-wrap items-center gap-2 border-b border-line-soft pb-2 text-[13px] last:border-0"
            data-testid="feedback-item"
          >
            {f.rating !== null && (
              <span className={`font-mono ${f.rating < 0 ? 'text-danger' : 'text-ok'}`}>
                {f.rating > 0 ? `▲ ${f.rating}` : f.rating < 0 ? '▼' : '0'}
              </span>
            )}
            {f.label && (
              <span className="rounded border border-line-soft px-1.5 py-0.5 text-[11px] text-muted">{f.label}</span>
            )}
            {f.comment && <span className="text-ink">{f.comment}</span>}
            <span className="ml-auto text-[11px] text-faint">
              {SOURCE_LABELS[f.source] ?? f.source} · {timeAgo(f.createdAt)}
              {/* createdAt (DB default) and updatedAt (Prisma @updatedAt) come from different
                  clocks and can differ by a few ms even on a fresh, never-edited row — a >1s
                  gap is a real edit, not clock skew. */}
              {new Date(f.updatedAt).getTime() - new Date(f.createdAt).getTime() > 1000 && ' (edited)'}
            </span>
            {me?.user.id && f.createdBy === me.user.id && (
              <Button
                size="sm"
                onClick={() => startEdit(f)}
                data-testid={`feedback-edit-${f.id}`}
                aria-label="Edit this feedback"
              >
                Edit
              </Button>
            )}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-end gap-2 border-t border-line-soft pt-3" data-testid="feedback-form">
        <div className="flex gap-1">
          <Button
            variant={rating === 1 ? 'primary' : 'default'}
            size="sm"
            onClick={() => setRating(1)}
            data-testid="feedback-up"
            aria-label="Thumbs up"
          >
            ▲
          </Button>
          <Button
            variant={rating === -1 ? 'danger' : 'default'}
            size="sm"
            onClick={() => setRating(-1)}
            data-testid="feedback-down"
            aria-label="Thumbs down"
          >
            ▼
          </Button>
        </div>
        <Input
          placeholder="Label (optional)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="w-40"
          data-testid="feedback-label"
        />
        <Input
          placeholder="Comment (optional)"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          className="flex-1"
          data-testid="feedback-comment"
        />
        <Button variant="primary" size="sm" onClick={submit} disabled={isPending} data-testid="feedback-submit">
          {editingId ? 'Save changes' : 'Add feedback'}
        </Button>
        {editingId && (
          <Button size="sm" onClick={resetForm} data-testid="feedback-cancel-edit">
            Cancel
          </Button>
        )}
      </div>
    </section>
  );
}
