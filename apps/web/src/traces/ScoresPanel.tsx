import { Link } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { timeAgo } from '@/lib/format';
import type { EvalScoreDto } from '@/api/types';

export interface ScoresPanelProps {
  evalScores: EvalScoreDto[];
}

/** Score chip: `—` when unscored (payload capture was off, so the judge never ran). */
function ScoreChip({ score, passed }: { score: number | null; passed: boolean | null }) {
  if (score === null) return <span className="font-mono text-[13px] font-semibold text-faint">—</span>;
  return (
    <span className={cn('font-mono text-[13px] font-semibold', passed === false ? 'text-danger' : 'text-ok')}>
      {score}
    </span>
  );
}

/**
 * Renders a trace's online-eval rule scores, read-only — scores are
 * machine-written by the eval worker, so unlike `FeedbackPanel` this has no
 * add/edit form. Both `score` and `judgeTraceId` can be `null` when a rule
 * matched a span but couldn't judge it (payload capture off for the team),
 * in which case the trailing judge-trace link is omitted rather than
 * pointing at `/traces/null`.
 */
export function ScoresPanel({ evalScores }: ScoresPanelProps) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4" data-testid="scores-panel">
      <h2 className="text-[15px] font-semibold">Scores</h2>
      <ul className="flex flex-col gap-2">
        {evalScores.length === 0 && <li className="text-[13px] text-faint">No rule scores yet.</li>}
        {evalScores.map((s) => (
          <li
            key={s.id}
            className="flex flex-wrap items-center gap-2 border-b border-line-soft pb-2 text-[13px] last:border-0"
            data-testid="score-item"
          >
            <span className="rounded border border-line-soft px-1.5 py-0.5 text-[11px] text-muted">{s.ruleName}</span>
            <ScoreChip score={s.score} passed={s.passed} />
            {s.reason && <span className="text-ink">{s.reason}</span>}
            <span className="ml-auto text-[11px] text-faint">
              {timeAgo(s.createdAt)}
              {s.judgeTraceId && (
                <>
                  {' · '}
                  <Link to={`/traces/${s.judgeTraceId}`} className="text-varhi hover:underline">
                    View judge trace →
                  </Link>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
