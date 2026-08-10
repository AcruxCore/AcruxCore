import { type ReactNode } from 'react';
import { MarketingShell } from '../MarketingShell';
import { cssToStyle, Eyebrow, CtaSection, useDocumentTitle, ExternalArrow } from '../marketing-chrome';
import { ACRUX_CORE, COMPARISON_LIST, type Fact } from '../comparisons';

/**
 * A cell's fact plus an optional source link. `highlight`/`badgeLabel` are passed
 * in rather than read off `fact.competitorWins` directly, so the same cell can
 * render either side's edge (see {@link MatrixRow.acruxWinsEveryRow}).
 */
function FactCell({ fact, highlight, badgeLabel }: { fact: Fact; highlight?: boolean; badgeLabel?: string }): ReactNode {
  return (
    <div style={cssToStyle('display:flex;flex-direction:column;gap:5px;')}>
      <span
        style={cssToStyle(
          `font-size:13.5px;line-height:1.5;color:${highlight ? 'var(--ink)' : 'var(--muted)'};text-wrap:pretty;`,
        )}
      >
        {fact.value}
      </span>
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
      {highlight && badgeLabel ? (
        <span
          style={cssToStyle(
            'display:inline-flex;width:fit-content;font-size:10.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--accent);border:1px solid var(--accent);border-radius:999px;padding:2px 7px;',
          )}
        >
          {badgeLabel}
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
  { label: 'Audit log', acrux: ACRUX_CORE.auditLog, competitor: (c) => c.auditLog },
  { label: 'Prompt templating logic', acrux: ACRUX_CORE.promptTemplating, competitor: (c) => c.promptTemplating },
];

const thStyle = cssToStyle(
  'text-align:left;padding:10px 12px;font-size:12px;font-weight:650;letter-spacing:.02em;color:var(--muted);border-bottom:1px solid var(--line);white-space:nowrap;position:sticky;top:0;background:var(--surface);',
);
const tdLabelStyle = cssToStyle(
  'text-align:left;padding:14px 12px;font-size:13px;font-weight:600;color:var(--ink);border-bottom:1px solid var(--line-soft);white-space:nowrap;',
);
const tdStyle = cssToStyle('padding:14px 12px;border-bottom:1px solid var(--line-soft);vertical-align:top;min-width:172px;');

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
          AcruxCore next to five open-source alternatives.
        </h1>
        <p
          style={cssToStyle(
            'font-size:clamp(16px,1.6vw,18px);line-height:1.62;color:var(--muted);margin:0;max-width:64ch;text-wrap:pretty;',
          )}
        >
          Every fact below links to the competitor's own pricing page, license file, or docs, and carries the date it was
          checked. Whichever side clearly wins a row is marked "Their edge" or "Our edge," not buried. For the hands-on
          side — the same prompt, actually run on both platforms — read the full write-up linked in each column.
        </p>
      </header>

      <section style={cssToStyle('padding:0 0 clamp(40px,6vw,64px);')}>
        <p style={cssToStyle('font-size:12.5px;color:var(--faint);margin:0 4px 10px;')}>
          Scroll right to see all five competitors →
        </p>
        <div style={cssToStyle('overflow-x:auto;border:1px solid var(--line);border-radius:14px;')}>
          <table style={cssToStyle('width:100%;border-collapse:collapse;background:var(--surface);')}>
            <thead>
              <tr>
                <th style={thStyle}></th>
                <th style={thStyle}>
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
                // The shared AcruxCore cell appears once per row, next to every
                // competitor column, so its own "Our edge" badge is only honest
                // when the win holds against ALL of them — a mixed row (an edge
                // against some competitors, not others) stays unbadged on the
                // AcruxCore side; each competitor's own column still carries
                // its individual "Their edge" badge where that holds.
                const acruxWinsEveryRow = COMPARISON_LIST.every((c) => row.competitor(c).acruxWins);
                return (
                  <tr key={row.label}>
                    <td style={tdLabelStyle}>{row.label}</td>
                    <td style={tdStyle}>
                      <FactCell fact={row.acrux} highlight={acruxWinsEveryRow} badgeLabel="Our edge" />
                    </td>
                    {COMPARISON_LIST.map((c) => (
                      <td key={c.slug} style={tdStyle}>
                        <FactCell fact={row.competitor(c)} highlight={row.competitor(c).competitorWins} badgeLabel="Their edge" />
                      </td>
                    ))}
                  </tr>
                );
              })}
              <tr>
                <td style={tdLabelStyle}>GitHub stars</td>
                <td style={tdStyle}>
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
        <p style={cssToStyle('font-size:12.5px;color:var(--faint);margin:14px 4px 0;text-wrap:pretty;')}>
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
