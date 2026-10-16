import { Link } from 'react-router-dom';
import { LineChart } from '@/ui';
import { useTraceScores } from '@/api';
import { formatCount, formatPercent } from './format';
import { everyDay } from './score-days';

/** Share of `a` in `a + b`, or null when both are zero (a gap in the chart, not 0%). */
function share(a: number, b: number): number | null {
  return a + b === 0 ? null : a / (a + b);
}

/** One small figure inside the panel. */
function Figure({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  const color = tone === 'good' ? 'text-ok' : tone === 'bad' ? 'text-danger' : 'text-ink';
  return (
    <div>
      <div className="text-[11px] uppercase tracking-[0.06em] text-faint">{label}</div>
      <div className={`mt-1 font-mono text-[18px] ${color}`}>{value}</div>
    </div>
  );
}

/**
 * Quality next to traffic on `/observability`: thumbs feedback from people and verdicts
 * from online evaluation rules, over the same window as the rest of the page.
 *
 * Thumbs are ratings of exactly 1 and -1, which is what the trace screens write. The trend
 * plots the thumbs-up share and the judge pass rate per day; a day with neither is a gap,
 * because 0% would read as "everything failed".
 *
 * @param from - ISO start of the window, or undefined for the API's 30-day default.
 * @param to - ISO end of the window, or undefined for "now".
 */
export function QualityPanel({ from, to }: { from?: string; to?: string }) {
  const { data, isLoading, isError } = useTraceScores({ from, to });
  if (isLoading) return null;

  const header = (
    <div className="mb-3 flex flex-wrap items-baseline gap-2">
      <h2 className="text-[13px] font-medium text-ink">Quality</h2>
      <span className="text-[12px] text-muted">Thumbs from people and verdicts from online evaluation rules.</span>
    </div>
  );

  // A failed request keeps the panel on screen with a message, like every other section of
  // the page, so a failure never reads as "this feature is not here".
  if (isError || !data) {
    return (
      <section className="rounded-xl border border-line bg-surface p-4" data-testid="quality-panel">
        {header}
        <p className="text-[13px] font-medium text-ink">Couldn’t load quality scores</p>
        <p className="text-[13px] text-muted">Something went wrong. Try again.</p>
      </section>
    );
  }

  const { feedback, rules } = data;
  const days = everyDay(data.from, data.to, data.days);
  const hasAny = feedback.up + feedback.down > 0 || rules.length > 0;
  const upShare = share(feedback.up, feedback.down);

  return (
    <section className="rounded-xl border border-line bg-surface p-4" data-testid="quality-panel">
      {header}

      {!hasAny ? (
        <p className="text-[13px] text-muted">
          No feedback or online-evaluation verdicts in this range. Rate a trace, or{' '}
          <Link to="/evaluations/rules" className="text-accent hover:underline">
            add an online evaluation rule
          </Link>
          .
        </p>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-3 gap-3" data-testid="quality-feedback">
              <Figure label="Thumbs up" value={formatCount(feedback.up)} tone={feedback.up > 0 ? 'good' : undefined} />
              <Figure label="Thumbs down" value={formatCount(feedback.down)} tone={feedback.down > 0 ? 'bad' : undefined} />
              <Figure label="Positive" value={upShare === null ? '—' : formatPercent(upShare)} />
            </div>

            {rules.length > 0 && (
              <div className="overflow-x-auto rounded-lg border border-line-soft">
                <table className="w-full min-w-[420px] border-collapse text-left text-[13px]" data-testid="quality-rules">
                  <thead>
                    <tr className="border-b border-line-soft text-[11px] uppercase tracking-[0.06em] text-faint">
                      <th className="px-3 py-2 font-medium">Rule</th>
                      <th className="px-3 py-2 text-right font-medium">Verdicts</th>
                      <th className="px-3 py-2 text-right font-medium">Passed</th>
                      <th className="px-3 py-2 text-right font-medium">Failed</th>
                      <th className="px-3 py-2 text-right font-medium">Avg score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rules.map((r) => (
                      <tr key={r.ruleId} className="border-b border-line-soft last:border-b-0">
                        <td className="max-w-[220px] truncate px-3 py-2 text-ink" title={r.name}>
                          {r.name}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">{formatCount(r.scored)}</td>
                        <td className="px-3 py-2 text-right font-mono">{formatPercent(r.passed / r.scored)}</td>
                        <td className={`px-3 py-2 text-right font-mono ${r.failed > 0 ? 'text-danger' : ''}`}>
                          {formatCount(r.failed)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {r.avgScore === null ? '—' : Math.round(r.avgScore)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div data-testid="quality-trend">
            <div className="mb-2 text-[12px] text-muted">Per day</div>
            <LineChart
              xLabels={days.map((d) => d.day)}
              formatY={formatPercent}
              series={[
                { name: 'thumbs up', colorVar: 'accent', points: days.map((d) => share(d.up, d.down)) },
                { name: 'judge pass rate', colorVar: 'warn', points: days.map((d) => share(d.passed, d.failed)) },
              ]}
            />
          </div>
        </div>
      )}
    </section>
  );
}
