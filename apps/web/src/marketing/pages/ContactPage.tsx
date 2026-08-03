import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { MarketingShell, ContentHeader } from '../MarketingShell';
import { cssToStyle, Ic, DOCS_URL, SUPPORT_EMAIL } from '../marketing-chrome';

/** A single contact channel card. */
interface Channel {
  label: string;
  detail: string;
  blurb: string;
  href: string;
  external?: boolean;
  icon: ReactNode;
}

/**
 * The two ways to reach us. One inbox handles everything — questions, sales,
 * self-hosting, and security reports — so there is never a "wrong address" to
 * guess at (see cross-cutting-faq: single support inbox).
 */
const CHANNELS: Channel[] = [
  {
    label: 'Email support',
    detail: SUPPORT_EMAIL,
    blurb: 'Questions about the platform, self-hosting, pricing, or a security report — one inbox, we route it internally.',
    href: `mailto:${SUPPORT_EMAIL}`,
    icon: (
      <Ic>
        <rect x={3} y={5} width={18} height={14} rx={2} />
        <path d="m3 7 9 6 9-6" />
      </Ic>
    ),
  },
  {
    label: 'Documentation',
    detail: 'docs.acruxcore.com',
    blurb: 'Quickstart, guides, and the full curl-verified API reference. Most answers land here first.',
    href: DOCS_URL,
    external: true,
    icon: (
      <Ic>
        <path d="M4 5a2 2 0 0 1 2-2h9l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
        <path d="M14 3v5h5" />
      </Ic>
    ),
  },
];

/**
 * Public "Contact" page listing the ways to reach the team. Linked from the
 * footer Company column and the legal bottom bar.
 *
 * @returns The rendered Contact page.
 */
export function ContactPage(): ReactNode {
  return (
    <MarketingShell>
      <ContentHeader
        eyebrow="Contact"
        docTitle="Contact — Acrux Core"
        title="Get in touch."
        lead="Questions about the platform, a self-hosting deployment, pricing, or a security report — send them to one inbox and we'll get back to you."
      />
      <div style={cssToStyle('display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:16px;margin-bottom:clamp(40px,6vw,64px);')}>
        {CHANNELS.map((c) => (
          <a
            key={c.label}
            href={c.href}
            {...(c.external ? { target: '_blank', rel: 'noreferrer' } : {})}
            className="acx-hover-lift"
            style={cssToStyle(
              'border:1px solid var(--line);background:var(--surface);border-radius:12px;padding:22px 20px;display:flex;flex-direction:column;gap:12px;transition:border-color .16s,transform .16s;color:var(--ink);',
            )}
          >
            <span
              style={cssToStyle(
                'height:40px;width:40px;flex:none;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--line);border-radius:9px;background:var(--elevated);color:var(--accent);',
              )}
            >
              {c.icon}
            </span>
            <span style={cssToStyle('font-size:15.5px;font-weight:650;letter-spacing:-.01em;')}>{c.label}</span>
            <span style={cssToStyle('font-family:var(--mono);font-size:13px;color:var(--accent);word-break:break-all;')}>
              {c.detail}
            </span>
            <span style={cssToStyle('font-size:13.5px;line-height:1.6;color:var(--muted);margin:0;')}>{c.blurb}</span>
          </a>
        ))}
      </div>
      <div style={cssToStyle('margin-bottom:clamp(40px,6vw,64px);')}>
        <h2 style={cssToStyle('font-size:18px;font-weight:650;margin:0 0 16px;')}>Follow us</h2>
        <div style={cssToStyle('display:flex;gap:12px;flex-wrap:wrap;')}>
          {[
            {
              label: 'LinkedIn',
              href: 'https://www.linkedin.com/company/acruxcore/',
              icon: (
                <Ic size={18} sw={2}>
                  <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-7a6 6 0 0 1 6-6z" />
                  <rect x={2} y={9} width={4} height={12} />
                  <circle cx={4} cy={4} r={2} />
                </Ic>
              ),
            },
            {
              label: 'X (Twitter)',
              href: 'https://x.com/AcruxCore',
              icon: (
                <Ic size={18} sw={2}>
                  <path d="M4 4l6.5 8L4 20h2l5.5-6.5L16 20h4l-6.5-8L20 4h-2l-5.5 6.5L8 4H4z" />
                </Ic>
              ),
            },
            {
              label: 'YouTube',
              href: 'https://www.youtube.com/@AcruxCoreAI',
              icon: (
                <Ic size={18} sw={2}>
                  <path d="M22.54 6.42a2.78 2.78 0 0 0-1.94-2C18.88 4 12 4 12 4s-6.88 0-8.6.46a2.78 2.78 0 0 0-1.94 2A29 29 0 0 0 1 11.75a29 29 0 0 0 .46 5.33A2.78 2.78 0 0 0 3.4 19.1c1.72.46 8.6.46 8.6.46s6.88 0 8.6-.46a2.78 2.78 0 0 0 1.94-2 29 29 0 0 0 .46-5.25 29 29 0 0 0-.46-5.43z" />
                  <polygon points="9.75,15.02 15.5,11.75 9.75,8.48" />
                </Ic>
              ),
            },
          ].map((s) => (
            <a
              key={s.label}
              href={s.href}
              target="_blank"
              rel="noreferrer"
              className="acx-hover-lift"
              style={cssToStyle(
                'border:1px solid var(--line);background:var(--surface);border-radius:10px;padding:14px 20px;font-size:14px;font-weight:600;color:var(--ink);text-decoration:none;transition:border-color .16s,transform .16s;display:inline-flex;align-items:center;gap:8px;',
              )}
            >
              {s.icon}
              {s.label}
            </a>
          ))}
        </div>
      </div>
      <div className="acx-prose">
        <h2>Reporting a security issue</h2>
        <p>
          Use the same address — <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> — and include steps to
          reproduce. Security reports are triaged ahead of everything else. Our{' '}
          <Link to="/security">security page</Link> explains how we handle disclosure.
        </p>

        <h2>Before you write</h2>
        <p>
          If you are evaluating the platform, the fastest path is usually to{' '}
          <Link to="/signup">start a free account</Link> and follow the{' '}
          <a href={`${DOCS_URL}/docs/getting-started/quickstart`} target="_blank" rel="noreferrer">
            quickstart
          </a>{' '}
          — it takes a few minutes and you can route a real call through the gateway before you talk to anyone.
        </p>
      </div>
    </MarketingShell>
  );
}
