import { type ReactNode } from 'react';
import { MarketingShell } from '../MarketingShell';
import { cssToStyle, Eyebrow, CtaSection, Ic, useDocumentTitle, ExternalArrow } from '../marketing-chrome';
import { ACRUX_CORE, COMPARISON_LIST, type Fact } from '../comparisons';

/**
 * The verdict a single cell carries. Ties are marked as loudly as wins, so a reader
 * can tell "we checked and it's even" apart from an unscored row — the same reason
 * both win directions are marked rather than only ours.
 */
type Verdict = 'ours' | 'theirs' | 'tie';

/**
 * Each verdict's pill: its label, the token it borrows, and its glyph. A tie takes
 * `--faint` rather than an accent so it reads as the quiet outcome it is, and does not
 * compete with the wins for attention when a column is scanned top to bottom.
 *
 * The glyph carries no meaning the label does not already state — it is there so a
 * reader scanning a column downwards can tell the three verdicts apart before reading
 * any word, which is why it is `aria-hidden` in {@link FactCell}. The amber triangle is
 * the same one `/best-open-source-llmops-platforms` uses for a limitation, so the two
 * pages read as one vocabulary: amber triangle always means "this is where we are
 * behind", never "this competitor is bad".
 */
const VERDICTS: Record<Verdict, { label: string; color: string; icon: ReactNode }> = {
  ours: {
    label: 'Our edge',
    color: 'var(--accent)',
    icon: (
      <Ic size={12} sw={2.8}>
        <path d="M20 6 9 17l-5-5" />
      </Ic>
    ),
  },
  theirs: {
    label: 'Their edge',
    color: 'var(--warn)',
    icon: (
      <Ic size={12} sw={2.2}>
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
      </Ic>
    ),
  },
  tie: {
    label: 'Tie',
    color: 'var(--faint)',
    icon: (
      <Ic size={12} sw={2.4}>
        <path d="M5 9h14" />
        <path d="M5 15h14" />
      </Ic>
    ),
  },
};

/**
 * The verdict for a whole row, shown once on the AcruxCore cell — set only when every
 * competitor lands the same way. A verdict that holds against all six is a statement
 * about the row, so it is made once; repeating "Our edge" in all six competitor
 * columns said the same thing six times and drowned out the rows that differ.
 *
 * @returns The row-level verdict, or `undefined` when the competitors disagree — in
 *   which case each competitor column speaks for itself via {@link cellVerdict}.
 */
function rowVerdict(row: MatrixRow): Verdict | undefined {
  if (COMPARISON_LIST.every((c) => row.competitor(c).acruxWins)) return 'ours';
  if (COMPARISON_LIST.every((c) => row.competitor(c).tie)) return 'tie';
  return undefined;
}

/**
 * The verdict for one competitor's cell on a row the competitors disagree about.
 *
 * "Our edge" is deliberately absent here: on a mixed row it is already implied by the
 * columns that carry a "Their edge" or "Tie" and by the ones that carry nothing, and
 * printing it per column is what made the matrix repetitive.
 *
 * @returns The cell's verdict, or `undefined` when the row already carries one.
 */
function cellVerdict(fact: Fact, row: Verdict | undefined): Verdict | undefined {
  if (row) return undefined;
  if (fact.competitorWins) return 'theirs';
  if (fact.tie) return 'tie';
  return undefined;
}

/**
 * A cell's fact plus an optional source link and verdict pill. The verdict is passed
 * in rather than read off the fact, because it depends on the whole row: the AcruxCore
 * column shares one `Fact` across every competitor, so its pill can only be decided by
 * looking at all six at once (see {@link rowVerdict}).
 *
 * The pill stays last, under the fact, and is found by its glyph rather than by its
 * position. Two rejected alternatives, both tried: putting it first pushes that one
 * cell's prose down so the facts no longer start on the same line, which is what reading
 * a row across to compare platforms depends on; pinning it to the bottom of the row
 * leaves it floating in empty space on the rows where only one or two cells carry one,
 * detached from the fact it is judging.
 *
 * A fact carrying its own `checkedOn` prints it under the value: the column header's
 * date covers the original sweep, and a row added later must not claim that evidence.
 */
function FactCell({ fact, verdict }: { fact: Fact; verdict?: Verdict }): ReactNode {
  const pill = verdict ? VERDICTS[verdict] : undefined;
  // A tie is information, not an advantage, so it does not promote the text to --ink
  // the way a win on either side does.
  const emphasised = verdict === 'ours' || verdict === 'theirs';
  return (
    <div style={cssToStyle('display:flex;flex-direction:column;align-items:flex-start;gap:5px;')}>
      <span
        style={cssToStyle(
          `font-size:13.5px;line-height:1.5;color:${emphasised ? 'var(--ink)' : 'var(--muted)'};text-wrap:pretty;`,
        )}
      >
        {fact.value}
      </span>
      {fact.checkedOn ? (
        <span style={cssToStyle('font-size:11px;color:var(--faint);')}>Checked {fact.checkedOn}</span>
      ) : null}
      {fact.source ? (
        <a
          href={fact.source.href}
          target="_blank"
          rel="noreferrer"
          style={cssToStyle('font-size:11.5px;color:var(--accent);text-decoration:none;')}
        >
          {fact.source.label} ↗
        </a>
      ) : null}
      {pill ? (
        <span
          style={cssToStyle(
            `display:inline-flex;align-items:center;gap:5px;margin-top:3px;font-size:10.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${pill.color};`,
          )}
        >
          <span
            aria-hidden="true"
            style={cssToStyle(
              `display:inline-flex;align-items:center;justify-content:center;flex:none;width:18px;height:18px;border-radius:5px;background:color-mix(in oklch, ${pill.color} 16%, transparent);`,
            )}
          >
            {pill.icon}
          </span>
          {pill.label}
        </span>
      ) : null}
    </div>
  );
}

/** One matrix row: a label, AcruxCore's fact, and each competitor's fact. */
interface MatrixRow {
  label: string;
  acrux: Fact;
  competitor: (c: (typeof COMPARISON_LIST)[number]) => Fact;
}

const ROWS: MatrixRow[] = [
  { label: 'License', acrux: ACRUX_CORE.license, competitor: (c) => c.license },
  { label: 'Self-hosting', acrux: ACRUX_CORE.selfHost, competitor: (c) => c.selfHost },
  { label: 'Gateway', acrux: ACRUX_CORE.gateway, competitor: (c) => c.gateway },
  { label: 'Tool catalog', acrux: ACRUX_CORE.toolCatalog, competitor: (c) => c.toolCatalog },
  { label: 'Team & org structure', acrux: ACRUX_CORE.teamStructure, competitor: (c) => c.teamStructure },
  { label: 'Pricing', acrux: ACRUX_CORE.pricing, competitor: (c) => c.pricingSummary },
  { label: 'RBAC', acrux: ACRUX_CORE.rbac, competitor: (c) => c.rbac },
  { label: 'Audit log (who changed what)', acrux: ACRUX_CORE.auditLog, competitor: (c) => c.auditLog },
  { label: 'Prompt templating logic', acrux: ACRUX_CORE.promptTemplating, competitor: (c) => c.promptTemplating },
  { label: 'Prompt optimizer', acrux: ACRUX_CORE.promptOptimizer, competitor: (c) => c.promptOptimizer },
];

const TH_BASE =
  'text-align:left;padding:10px 12px;font-size:12px;font-weight:650;letter-spacing:.02em;color:var(--muted);border-bottom:1px solid var(--line);white-space:nowrap;position:sticky;top:0;background:var(--surface);';
const TD_BASE = 'padding:14px 12px;border-bottom:1px solid var(--line-soft);vertical-align:top;min-width:172px;';

/**
 * The wash behind the AcruxCore column. Six competitor columns sit to its right and the
 * table scrolls sideways, so without it the one column every row is measured against is
 * found by counting from the left edge on every row. It is mixed into `--surface` rather
 * than laid over it as a transparent tint because the header cells are `position:sticky`
 * and would otherwise show the rows sliding underneath.
 */
const ACRUX_WASH = 'background:color-mix(in oklch, var(--accent) 7%, var(--surface));';

const thStyle = cssToStyle(TH_BASE);
const thAcruxStyle = cssToStyle(TH_BASE + ACRUX_WASH);
const tdLabelStyle = cssToStyle(
  'text-align:left;padding:14px 12px;font-size:13px;font-weight:600;color:var(--ink);border-bottom:1px solid var(--line-soft);white-space:nowrap;',
);
const tdStyle = cssToStyle(TD_BASE);
const tdAcruxStyle = cssToStyle(TD_BASE + ACRUX_WASH);

/**
 * `/compare` — the full open-source/self-hosted-alternative comparison table.
 *
 * Holds the five aspects the restructured `acruxcore-vs-<competitor>` posts moved
 * out of their prose (license/self-hosting, team/org structure, pricing, security &
 * access control, community & maturity) — nobody read those as prose, and a fact
 * here can be corrected in place instead of edited across three syndicated copies.
 * Every fact links to where it came from and carries the date it was checked.
 *
 * @returns The rendered comparison matrix.
 */
export function ComparePage(): ReactNode {
  useDocumentTitle('LLM Observability Tools Compared (2026) | AcruxCore');

  return (
    <MarketingShell wide>
      <header style={cssToStyle('padding:clamp(44px,7vw,80px) 0 clamp(28px,4vw,40px);')}>
        <Eyebrow>Compare</Eyebrow>
        <h1
          style={cssToStyle(
            'font-size:clamp(30px,4.4vw,48px);line-height:1.05;letter-spacing:-.026em;font-weight:700;margin:0 0 18px;max-width:22ch;text-wrap:balance;',
          )}
        >
          AcruxCore next to six open-source alternatives.
        </h1>
        <p
          style={cssToStyle(
            'font-size:clamp(16px,1.6vw,18px);line-height:1.62;color:var(--muted);margin:0;max-width:64ch;text-wrap:pretty;',
          )}
        >
          Every fact below links to the competitor's own pricing page, license file, or docs, and carries the date it was
          checked. A row we win against every one of them is marked "Our edge," a row a competitor wins is marked "Their
          edge" in its own column, and a row where we land in the same place is marked "Tie" — nothing is buried. For
          the hands-on side — the same prompt, actually run on both platforms — read the full write-up linked in each
          column.
        </p>
      </header>

      <section className="acx-compare-matrix" style={cssToStyle('padding:0 0 clamp(40px,6vw,64px);')}>
        <p className="acx-compare-hint" style={cssToStyle('font-size:12.5px;color:var(--faint);margin:0 4px 10px;')}>
          Scroll right to see all six competitors →
        </p>
        <div style={cssToStyle('overflow-x:auto;border:1px solid var(--line);border-radius:14px;')}>
          <table style={cssToStyle('width:100%;border-collapse:collapse;background:var(--surface);')}>
            <thead>
              <tr>
                <th style={thStyle}></th>
                <th style={thAcruxStyle}>
                  AcruxCore
                  <div style={cssToStyle('font-size:11px;font-weight:400;color:var(--faint);margin-top:2px;')}>
                    Checked {ACRUX_CORE.checkedOn}
                  </div>
                </th>
                {COMPARISON_LIST.map((c) => (
                  <th key={c.slug} style={thStyle}>
                    <a href={c.postHref} target="_blank" rel="noreferrer" style={cssToStyle('color:var(--ink);text-decoration:none;')}>
                      {c.name}
                    </a>
                    <div style={cssToStyle('font-size:11px;font-weight:400;color:var(--faint);margin-top:2px;')}>
                      Checked {c.checkedOn}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => {
                // A verdict that holds against every competitor is said once, on the
                // AcruxCore cell; otherwise each competitor column speaks for itself.
                const rowWide = rowVerdict(row);
                return (
                  <tr key={row.label}>
                    <td style={tdLabelStyle}>{row.label}</td>
                    <td style={tdAcruxStyle}>
                      <FactCell fact={row.acrux} verdict={rowWide} />
                    </td>
                    {COMPARISON_LIST.map((c) => {
                      const fact = row.competitor(c);
                      return (
                        <td key={c.slug} style={tdStyle}>
                          <FactCell fact={fact} verdict={cellVerdict(fact, rowWide)} />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              <tr>
                <td style={tdLabelStyle}>GitHub stars</td>
                <td style={tdAcruxStyle}>
                  <span style={cssToStyle('font-size:13.5px;color:var(--muted);')}>Public mirror opened 2026-08-03</span>
                </td>
                {COMPARISON_LIST.map((c) => (
                  <td key={c.slug} style={tdStyle}>
                    <div style={cssToStyle('display:flex;flex-direction:column;gap:5px;')}>
                      <span style={cssToStyle('font-size:13.5px;color:var(--ink);font-weight:650;')}>
                        {c.communityStars}
                      </span>
                      <a
                        href={c.githubHref}
                        target="_blank"
                        rel="noreferrer"
                        style={cssToStyle('font-size:11.5px;color:var(--accent);text-decoration:none;')}
                      >
                        GitHub ↗
                      </a>
                      {c.communityNote ? (
                        <span style={cssToStyle('font-size:12px;line-height:1.5;color:var(--muted);text-wrap:pretty;')}>
                          {c.communityNote}
                        </span>
                      ) : null}
                    </div>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        <p style={cssToStyle('font-size:12.5px;color:var(--faint);margin:14px 4px 0;max-width:78ch;text-wrap:pretty;')}>
          Community stats are a footnote, not a scored comparison — a young project is not a weak one, and a mature
          project is not automatically the better fit for your team.
        </p>
      </section>

      <section style={cssToStyle('padding:0 0 clamp(40px,6vw,68px);border-top:1px solid var(--line-soft);padding-top:clamp(36px,5vw,56px);')}>
        <Eyebrow>The hands-on side</Eyebrow>
        <h2
          style={cssToStyle(
            'font-size:clamp(22px,2.8vw,28px);line-height:1.16;letter-spacing:-.02em;font-weight:700;margin:0 0 20px;text-wrap:balance;',
          )}
        >
          The same prompt, actually run on both platforms.
        </h2>
        <div style={cssToStyle('display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:14px;')}>
          {COMPARISON_LIST.map((c) => (
            <a
              key={c.slug}
              href={c.postHref}
              target="_blank"
              rel="noreferrer"
              className="acx-hover-lift"
              style={cssToStyle(
                'border:1px solid var(--line);background:var(--surface);border-radius:12px;padding:20px 20px;display:flex;flex-direction:column;gap:8px;color:var(--ink);transition:border-color .16s,transform .16s;',
              )}
            >
              <span style={cssToStyle('font-size:15.5px;font-weight:650;letter-spacing:-.01em;')}>
                {c.name}
              </span>
              <span style={cssToStyle('font-size:13.5px;line-height:1.55;color:var(--muted);text-wrap:pretty;')}>
                {c.tagline}
              </span>
              <span style={cssToStyle('font-size:13px;color:var(--accent);display:inline-flex;align-items:center;gap:4px;margin-top:4px;')}>
                Read the write-up <ExternalArrow />
              </span>
            </a>
          ))}
        </div>
      </section>

      <CtaSection
        title="See the platform, not just the table."
        body="No credit card required. Bring your own provider keys and route the first call in a few minutes."
      />
    </MarketingShell>
  );
}
