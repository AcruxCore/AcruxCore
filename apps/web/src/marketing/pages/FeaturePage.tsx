import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { MarketingShell } from '../MarketingShell';
import {
  cssToStyle,
  Ic,
  Eyebrow,
  CodeCard,
  RotatingCodeCard,
  CtaSection,
  btnPrimary,
  btnSecondary,
  ExternalArrow,
  useDocumentTitle,
} from '../marketing-chrome';
import { FEATURE_LIST, type Feature } from '../features';

/** A left-aligned section heading with an eyebrow and optional lead. */
function SectionHead({ eyebrow, title, lead }: { eyebrow: string; title: string; lead?: string }): ReactNode {
  return (
    <div style={cssToStyle('max-width:640px;margin-bottom:clamp(28px,4vw,42px);')}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2
        style={cssToStyle(
          'font-size:clamp(24px,3.2vw,34px);line-height:1.12;letter-spacing:-.02em;font-weight:700;margin:0;text-wrap:balance;',
        )}
      >
        {title}
      </h2>
      {lead ? (
        <p style={cssToStyle('font-size:16px;line-height:1.6;color:var(--muted);margin:14px 0 0;text-wrap:pretty;')}>
          {lead}
        </p>
      ) : null}
    </div>
  );
}

/** The accent check mark used in the dashboard capability list. */
function Check(): ReactNode {
  return (
    <svg
      style={cssToStyle('flex:none;margin-top:3px;color:var(--accent);')}
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m20 6-11 11-5-5" />
    </svg>
  );
}

/**
 * One public page per platform pillar, at `/features/<slug>`.
 *
 * A single layout driven entirely by a {@link Feature} record, so all five pages
 * stay structurally identical and adding a pillar means adding data, not markup.
 * Replaces the old footer links that all pointed at the same `/#pillars` anchor.
 *
 * @param feature - The pillar to render, from `FEATURES`.
 * @returns The rendered feature page.
 */
export function FeaturePage({ feature }: { feature: Feature }): ReactNode {
  useDocumentTitle(feature.metaTitle);
  const others = FEATURE_LIST.filter((f) => f.slug !== feature.slug);

  return (
    <MarketingShell wide>
      {/* ===== HERO ===== */}
      <section
        style={cssToStyle(
          'padding:clamp(44px,7vw,84px) 0 clamp(40px,6vw,68px);display:grid;grid-template-columns:repeat(auto-fit,minmax(min(330px,100%),1fr));gap:clamp(32px,5vw,56px);align-items:center;',
        )}
      >
        <div>
          <span
            style={cssToStyle(
              'height:44px;width:44px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--accent);margin-bottom:22px;',
            )}
          >
            {feature.icon}
          </span>
          <Eyebrow>{feature.eyebrow}</Eyebrow>
          <h1
            style={cssToStyle(
              'font-size:clamp(30px,4.4vw,48px);line-height:1.05;letter-spacing:-.026em;font-weight:700;margin:0 0 20px;text-wrap:balance;',
            )}
          >
            {feature.title}
          </h1>
          <p
            style={cssToStyle(
              'font-size:clamp(16px,1.6vw,18px);line-height:1.62;color:var(--muted);margin:0 0 30px;max-width:48ch;text-wrap:pretty;',
            )}
          >
            {feature.lead}
          </p>
          <div style={cssToStyle('display:flex;flex-wrap:wrap;gap:12px;')}>
            <Link to="/signup" className="acx-hover-bright" style={cssToStyle(btnPrimary())}>
              Start free
            </Link>
            <a
              href={feature.docs[0].href}
              target="_blank"
              rel="noreferrer"
              className="acx-hover-border"
              style={cssToStyle(btnSecondary())}
            >
              Read the guide
              <ExternalArrow />
            </a>
          </div>
        </div>
        {feature.code.length > 1
          ? <RotatingCodeCard variants={feature.code} />
          : <CodeCard filename={feature.code[0].filename} lang={feature.code[0].lang} html={feature.code[0].html} />}
      </section>

      {/* ===== CAPABILITIES ===== */}
      <section style={cssToStyle('padding:clamp(40px,6vw,72px) 0;border-top:1px solid var(--line-soft);')}>
        <SectionHead eyebrow="What you get" title={`${feature.name}, in four parts.`} />
        <div style={cssToStyle('display:grid;grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr));gap:16px;')}>
          {feature.capabilities.map((c) => (
            <div
              key={c.title}
              className="acx-hover-border"
              style={cssToStyle(
                'border:1px solid var(--line);background:var(--surface);border-radius:12px;padding:24px 22px;display:flex;flex-direction:column;gap:10px;transition:border-color .16s;',
              )}
            >
              <h3 style={cssToStyle('font-size:16.5px;font-weight:650;letter-spacing:-.01em;margin:0;')}>{c.title}</h3>
              <p style={cssToStyle('font-size:14.5px;line-height:1.62;color:var(--muted);margin:0;text-wrap:pretty;')}>
                {c.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ===== IN THE DASHBOARD ===== */}
      <section style={cssToStyle('padding:clamp(40px,6vw,72px) 0;border-top:1px solid var(--line-soft);')}>
        <SectionHead
          eyebrow="In the dashboard"
          title="Everything without writing a line of code."
          lead="The API and SDKs cover the automated path. For the day-to-day, the dashboard does the same work in the browser."
        />
        <ul
          style={cssToStyle(
            'list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr));gap:14px 32px;',
          )}
        >
          {feature.dashboard.map((item) => (
            <li key={item} style={cssToStyle('display:flex;gap:11px;align-items:flex-start;')}>
              <Check />
              <span style={cssToStyle('font-size:15px;line-height:1.55;color:var(--muted);text-wrap:pretty;')}>
                {item}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* ===== DOCS ===== */}
      <section style={cssToStyle('padding:clamp(40px,6vw,72px) 0;border-top:1px solid var(--line-soft);')}>
        <SectionHead eyebrow="Go deeper" title="Documentation for this piece." />
        <div style={cssToStyle('display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:14px;')}>
          {feature.docs.map((d) => (
            <a
              key={d.href + d.label}
              href={d.href}
              target="_blank"
              rel="noreferrer"
              className="acx-hover-lift"
              style={cssToStyle(
                'border:1px solid var(--line);background:var(--surface);border-radius:11px;padding:18px 20px;display:flex;align-items:center;justify-content:space-between;gap:14px;font-size:14.5px;font-weight:550;color:var(--ink);transition:border-color .16s,transform .16s;',
              )}
            >
              {d.label}
              <span style={cssToStyle('color:var(--accent);flex:none;display:inline-flex;')}>
                <ExternalArrow />
              </span>
            </a>
          ))}
        </div>
      </section>

      {/* ===== OTHER PILLARS ===== */}
      <section style={cssToStyle('padding:clamp(40px,6vw,72px) 0 clamp(20px,3vw,32px);border-top:1px solid var(--line-soft);')}>
        <SectionHead
          eyebrow="The rest of the platform"
          title="It composes with the other four."
          lead="Each piece works on its own, and they get better together — a trace links back to a prompt version, a dataset is built from feedback."
        />
        <div style={cssToStyle('display:grid;grid-template-columns:repeat(auto-fit,minmax(min(230px,100%),1fr));gap:14px;')}>
          {others.map((f) => (
            <Link
              key={f.slug}
              to={`/features/${f.slug}`}
              className="acx-hover-lift"
              style={cssToStyle(
                'border:1px solid var(--line);background:var(--surface);border-radius:11px;padding:20px 18px;display:flex;flex-direction:column;gap:10px;color:var(--ink);transition:border-color .16s,transform .16s;',
              )}
            >
              <span
                style={cssToStyle(
                  'height:34px;width:34px;flex:none;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--line);border-radius:8px;background:var(--elevated);color:var(--accent);',
                )}
              >
                {f.icon}
              </span>
              <span
                style={cssToStyle(
                  'font-size:15.5px;font-weight:650;letter-spacing:-.01em;display:inline-flex;align-items:center;gap:6px;',
                )}
              >
                {f.name}
                <Ic size={14} sw={2.2}>
                  <path d="m9 6 6 6-6 6" />
                </Ic>
              </span>
              <span style={cssToStyle('font-size:13.5px;line-height:1.55;color:var(--muted);text-wrap:pretty;')}>
                {f.summary}
              </span>
            </Link>
          ))}
        </div>
      </section>

      <CtaSection
        title={`Start with ${feature.name.toLowerCase()}. Add the rest when you need it.`}
        body="No credit card required. Bring your own provider keys and route the first call in a few minutes."
      />
    </MarketingShell>
  );
}
