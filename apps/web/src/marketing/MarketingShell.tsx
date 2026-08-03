import { type ReactNode } from 'react';
import {
  cssToStyle,
  MARKETING_CSS,
  MarketingHeader,
  MarketingFooter,
  Eyebrow,
  useDocumentTitle,
} from './marketing-chrome';

/**
 * Full-page shell for public marketing content pages (About, Security, legal).
 *
 * Wraps children in the scoped `.acx-landing` container so the marketing design
 * tokens apply and cannot leak into the app, injects {@link MARKETING_CSS} once,
 * and renders the shared {@link MarketingHeader} / {@link MarketingFooter}. The
 * landing page renders its own body but reuses the same header/footer directly.
 *
 * @param children - Page body, placed inside the centered `<main>`.
 * @param wide - Use the landing page's 1160px measure instead of the 820px
 *   reading measure. Set for pages built from cards and grids (features,
 *   pricing); leave off for prose pages, where a long line hurts readability.
 * @returns The rendered page with nav, content, and footer.
 */
export function MarketingShell({ children, wide = false }: { children: ReactNode; wide?: boolean }): ReactNode {
  return (
    <div
      className="acx-landing"
      style={cssToStyle(
        'min-height:100vh;background:var(--bg);color:var(--ink);font-family:var(--sans);overflow-x:hidden;display:flex;flex-direction:column;',
      )}
    >
      <style>{MARKETING_CSS}</style>
      <MarketingHeader />
      <main
        style={cssToStyle(
          `position:relative;z-index:1;flex:1;max-width:${wide ? 1160 : 820}px;width:100%;margin:0 auto;padding:0 24px;`,
        )}
      >
        {children}
      </main>
      <MarketingFooter />
    </div>
  );
}

/**
 * Standard header block for a content page: an eyebrow, an `<h1>` title, an
 * optional lead paragraph, and an optional "Last updated" line for legal pages.
 *
 * Also sets the browser tab title to `"{title} — Acrux Core"` (override with
 * `docTitle`) so client-side navigation between marketing pages keeps the tab
 * accurate; the prerendered HTML already carries the correct title on first load.
 *
 * @param eyebrow - Small uppercase accent label above the title.
 * @param title - The page `<h1>`.
 * @param lead - Optional intro paragraph shown under the title.
 * @param updated - Optional ISO-ish date string; rendered as "Last updated …".
 * @param docTitle - Optional override for the browser tab title.
 * @returns The rendered page header.
 */
export function ContentHeader({
  eyebrow,
  title,
  lead,
  updated,
  docTitle,
}: {
  eyebrow: string;
  title: string;
  lead?: string;
  updated?: string;
  docTitle?: string;
}): ReactNode {
  useDocumentTitle(docTitle ?? `${title} — Acrux Core`);
  return (
    <header style={cssToStyle('padding:clamp(48px,8vw,88px) 0 clamp(24px,4vw,40px);border-bottom:1px solid var(--line-soft);margin-bottom:clamp(32px,5vw,48px);')}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <h1
        style={cssToStyle(
          'font-size:clamp(30px,4.4vw,48px);line-height:1.05;letter-spacing:-.026em;font-weight:700;margin:0;text-wrap:balance;',
        )}
      >
        {title}
      </h1>
      {lead ? (
        <p
          style={cssToStyle(
            'font-size:clamp(16px,1.6vw,18px);line-height:1.6;color:var(--muted);margin:20px 0 0;max-width:60ch;text-wrap:pretty;',
          )}
        >
          {lead}
        </p>
      ) : null}
      {updated ? (
        <p style={cssToStyle('font-size:13px;color:var(--faint);margin:20px 0 0;font-family:var(--mono);')}>
          Last updated {updated}
        </p>
      ) : null}
    </header>
  );
}
