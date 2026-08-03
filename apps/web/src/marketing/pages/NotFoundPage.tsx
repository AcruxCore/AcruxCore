import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { MarketingShell } from '../MarketingShell';
import {
  cssToStyle,
  Ic,
  Eyebrow,
  btnPrimary,
  btnSecondary,
  useDocumentTitle,
  DOCS,
  ExternalArrow,
  SUPPORT_EMAIL,
} from '../marketing-chrome';
import { FEATURE_LIST } from '../features';

/**
 * Public 404 page for any path the router does not recognise.
 *
 * Replaces the previous catch-all redirect to `/prompts`, which dropped a
 * signed-out visitor onto the login screen with no explanation — a mistyped URL
 * looked like a forced sign-in wall. Signed-in users keep their redirect into the
 * app; only genuinely unknown paths land here.
 *
 * Note the HTTP status is still 200: nginx serves the SPA shell for unknown paths
 * and cannot tell a typo from a dashboard route. The shell is sent with
 * `X-Robots-Tag: noindex` (see apps/web/nginx.conf), which is what keeps these out
 * of the index.
 *
 * @returns The rendered 404 page.
 */
export function NotFoundPage(): ReactNode {
  useDocumentTitle('Page not found — Acrux Core');

  return (
    <MarketingShell>
      <header style={cssToStyle('padding:clamp(56px,9vw,104px) 0 clamp(28px,4vw,40px);')}>
        <Eyebrow>Error 404</Eyebrow>
        <h1
          style={cssToStyle(
            'font-size:clamp(30px,4.4vw,48px);line-height:1.05;letter-spacing:-.026em;font-weight:700;margin:0;text-wrap:balance;',
          )}
        >
          That page does not exist.
        </h1>
        <p
          style={cssToStyle(
            'font-size:clamp(16px,1.6vw,18px);line-height:1.62;color:var(--muted);margin:20px 0 0;max-width:52ch;text-wrap:pretty;',
          )}
        >
          The link may be out of date, or the address may have a typo in it. Nothing is broken on your side — here is the
          way back.
        </p>
        <div style={cssToStyle('display:flex;flex-wrap:wrap;gap:12px;margin-top:30px;')}>
          <Link to="/" className="acx-hover-bright" style={cssToStyle(btnPrimary())}>
            Back to home
          </Link>
          <a
            href={DOCS.quickstart}
            target="_blank"
            rel="noreferrer"
            className="acx-hover-border"
            style={cssToStyle(btnSecondary())}
          >
            Search the docs
            <ExternalArrow />
          </a>
        </div>
      </header>

      <section style={cssToStyle('padding:clamp(28px,4vw,44px) 0 clamp(48px,7vw,80px);border-top:1px solid var(--line-soft);')}>
        <p
          style={cssToStyle(
            'font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);font-weight:600;margin:0 0 18px;',
          )}
        >
          Popular destinations
        </p>
        <div style={cssToStyle('display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:12px;')}>
          {FEATURE_LIST.map((f) => (
            <Link
              key={f.slug}
              to={`/features/${f.slug}`}
              className="acx-hover-lift"
              style={cssToStyle(
                'border:1px solid var(--line);background:var(--surface);border-radius:11px;padding:16px 18px;display:flex;align-items:center;gap:12px;font-size:14.5px;font-weight:550;color:var(--ink);transition:border-color .16s,transform .16s;',
              )}
            >
              <span style={cssToStyle('color:var(--accent);display:inline-flex;flex:none;')}>{f.icon}</span>
              {f.name}
            </Link>
          ))}
          <Link
            to="/pricing"
            className="acx-hover-lift"
            style={cssToStyle(
              'border:1px solid var(--line);background:var(--surface);border-radius:11px;padding:16px 18px;display:flex;align-items:center;gap:12px;font-size:14.5px;font-weight:550;color:var(--ink);transition:border-color .16s,transform .16s;',
            )}
          >
            <span style={cssToStyle('color:var(--accent);display:inline-flex;flex:none;')}>
              <Ic>
                <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0l-7.2-7.2a2 2 0 0 1-.6-1.4V5a2 2 0 0 1 2-2h7a2 2 0 0 1 1.4.6l7.4 7.4a2 2 0 0 1 0 2.8Z" />
                <circle cx={7.5} cy={7.5} r={1.2} />
              </Ic>
            </span>
            Pricing
          </Link>
        </div>
        <p style={cssToStyle('font-size:13.5px;color:var(--faint);margin:22px 0 0;')}>
          Still stuck? Email <a href={`mailto:${SUPPORT_EMAIL}`} style={cssToStyle('color:var(--accent);')}>{SUPPORT_EMAIL}</a>{' '}
          and tell us which link sent you here.
        </p>
      </section>
    </MarketingShell>
  );
}
