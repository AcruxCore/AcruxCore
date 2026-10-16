import { cn } from '@/lib/cn';
import type { RunNamedScore } from '@/api/types';

/**
 * The named scores of one local-run result (`items_exact`, `total_exact`, a
 * judge…), one line each: name, pass/fail word, the 0–100 score, and the
 * scorer's reason when it gave one. Renders nothing for a server-side result,
 * which has no named scores.
 *
 * @param scores - The result's named scores; undefined or empty renders nothing.
 * @param highlight - The score the surrounding view is classifying on, shown in bold.
 */
export function NamedScoreList({ scores, highlight }: { scores: RunNamedScore[] | undefined; highlight?: string | null }) {
  if (!scores || scores.length === 0) return null;
  return (
    <div className="flex flex-col gap-1" data-testid="named-scores">
      <span className="text-[11px] uppercase tracking-[0.06em] text-faint">Scores</span>
      <ul className="flex flex-col gap-1">
        {scores.map((s) => (
          <li key={s.name} className="flex flex-col text-[13px]" data-testid="named-score" data-name={s.name}>
            <span className="flex flex-wrap items-baseline gap-2">
              <span className={cn('font-mono text-ink', highlight === s.name && 'font-semibold')}>{s.name}</span>
              {s.score === null ? (
                <span className="text-faint">Unscored</span>
              ) : (
                <span className={s.passed ? 'text-ok' : 'text-danger'}>
                  {s.passed ? 'Pass' : 'Fail'}
                  <span className="ml-1.5 font-mono text-[12px] text-muted">{Math.round(s.score)}</span>
                </span>
              )}
            </span>
            {s.reason && <span className="text-[12px] text-muted">{s.reason}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
