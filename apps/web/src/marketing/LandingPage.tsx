import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  cssToStyle,
  Ic,
  Eyebrow,
  DOCS,
  API_BASE_URL,
  GITHUB_URL,
  GitHubIcon,
  MARKETING_CSS,
  MarketingHeader,
  MarketingFooter,
  useDocumentTitle,
  RotatingCodeCard,
  type CodeVariant,
  CtaSection,
  btnPrimary,
  btnSecondary,
  ExternalArrow,
} from './marketing-chrome';
import { FEATURE_LIST } from './features';

/** The code tab shown in the "Why teams switch" panel. */
type CodeTab = 'ts' | 'py' | 'curl';

/**
 * Public marketing landing page shown at `/` to signed-out visitors.
 *
 * Ported from the DesignCombo export; a self-contained React version. The shared
 * nav and footer come from {@link MarketingHeader} / {@link MarketingFooter}, and
 * all scoped design tokens live in {@link MARKETING_CSS} (class `.acx-landing`) so
 * the design's resets and colors cannot leak into the app. Colors follow the
 * app-wide `data-theme` on the document root, and inline styles are preserved via
 * {@link cssToStyle} for pixel fidelity.
 *
 * @returns The rendered landing page.
 */
export function LandingPage(): ReactNode {
  useDocumentTitle('AcruxCore — LLM-ops platform for engineering teams');
  const [tab, setTab] = useState<CodeTab>('ts');

  const tabBase =
    'flex:none;height:34px;padding:0 14px;border-radius:7px;font-family:var(--mono);font-size:12.5px;font-weight:600;cursor:pointer;transition:all .15s;';
  const tabOn = tabBase + 'background:var(--surface);color:var(--ink);border:1px solid var(--line);';
  const tabOff = tabBase + 'background:transparent;color:var(--muted);border:1px solid transparent;';
  const codeHtml = tab === 'ts' ? TS_CODE : tab === 'py' ? PY_CODE : CURL_CODE;

  // Real tab semantics: screen readers announce the selected language rather than
  // three unlabelled buttons, and the panel below is tied back to the active tab.
  const tabButton = (id: CodeTab, label: string): ReactNode => (
    <button
      key={id}
      role="tab"
      id={`acx-codetab-${id}`}
      aria-selected={tab === id}
      aria-controls="acx-codepanel"
      onClick={() => setTab(id)}
      style={cssToStyle(tab === id ? tabOn : tabOff)}
    >
      {label}
    </button>
  );

  return (
    <div
      className="acx-landing"
      style={cssToStyle(
        // `position:relative` is what makes `overflow-x:hidden` actually bite. The
        // hero glow below is `position:absolute` and 120vw wide; without a
        // positioned ancestor its containing block is the document, so the wrapper's
        // overflow rule did not clip it and phones got ~38px of horizontal scroll.
        'position:relative;min-height:100vh;background:var(--bg);color:var(--ink);font-family:var(--sans);overflow-x:hidden;',
      )}
    >
      <style>{MARKETING_CSS}</style>

      {/* faint hero glow */}
      <div
        style={cssToStyle(
          'position:absolute;top:-180px;left:50%;transform:translateX(-50%);width:min(1100px,120vw);height:620px;background:radial-gradient(ellipse at center, color-mix(in oklch, var(--accent) 22%, transparent) 0%, transparent 62%);opacity:.4;filter:blur(20px);pointer-events:none;z-index:0;',
        )}
      />

      <MarketingHeader onLanding />

      <main id="top" style={cssToStyle('position:relative;z-index:1;max-width:1160px;margin:0 auto;padding:0 24px;')}>
        {/* ===== HERO ===== */}
        <section
          style={cssToStyle(
            'padding:clamp(56px,9vw,110px) 0 clamp(48px,7vw,80px);display:grid;grid-template-columns:repeat(auto-fit,minmax(min(340px,100%),1fr));gap:clamp(36px,5vw,64px);align-items:center;',
          )}
        >
          <div>
            <div
              style={cssToStyle(
                'display:inline-flex;align-items:center;flex-wrap:wrap;row-gap:4px;gap:8px;padding:5px 11px 5px 9px;border:1px solid var(--line);background:var(--surface);border-radius:999px;font-size:12px;color:var(--muted);margin-bottom:26px;',
              )}
            >
              <span
                style={cssToStyle(
                  'height:7px;width:7px;border-radius:2px;background:var(--accent);box-shadow:0 0 8px var(--accent-dim);animation:acx-pulse 2.6s ease-in-out infinite;',
                )}
              />
              <span
                style={cssToStyle(
                  'font-weight:700;letter-spacing:.04em;color:var(--accent);text-transform:uppercase;font-size:11px;',
                )}
              >
                Beta
              </span>
              <span style={cssToStyle('color:var(--line);')}>·</span>
              <span>Open source</span>
              <span style={cssToStyle('color:var(--line);')}>·</span>
              <span>LLM-ops for engineering teams</span>
            </div>
            <h1
              style={cssToStyle(
                'font-size:clamp(34px,5.2vw,58px);line-height:1.03;letter-spacing:-.028em;font-weight:700;margin:0 0 22px;text-wrap:balance;',
              )}
            >
              Version prompts, route LLM calls, trace and{' '}
              evaluate <span style={cssToStyle('color:var(--accent);')}>— one platform.</span>
            </h1>
            <p
              style={cssToStyle(
                'font-size:clamp(16px,1.6vw,18.5px);line-height:1.6;color:var(--muted);margin:0 0 34px;max-width:44ch;text-wrap:pretty;',
              )}
            >
              AcruxCore sits between your app and every model provider — so you ship, change, and measure LLM features
              without redeploying to move a prompt.
            </p>
            <div style={cssToStyle('display:flex;flex-wrap:wrap;gap:12px;')}>
              <Link to="/signup" className="acx-hover-bright" style={cssToStyle(btnPrimary())}>
                Start free
              </Link>
              <a
                href={DOCS.quickstart}
                target="_blank"
                rel="noreferrer"
                className="acx-hover-border"
                style={cssToStyle(btnSecondary())}
              >
                Read the docs
                <ExternalArrow />
              </a>
            </div>
          </div>

          {/* hero code card — cycles TypeScript ↔ Python, see RotatingCodeCard */}
          <RotatingCodeCard variants={HERO_VARIANTS} />
        </section>

        {/* ===== DEMO VIDEO ===== */}
        <section
          id="demo"
          style={cssToStyle(
            'padding:clamp(40px,6vw,72px) 0;border-top:1px solid var(--line-soft);',
          )}
        >
          <div style={cssToStyle('max-width:700px;margin-bottom:clamp(24px,3.5vw,38px);')}>
            <Eyebrow>Watch</Eyebrow>
            <h2
              style={cssToStyle(
                'font-size:clamp(26px,3.4vw,40px);line-height:1.1;letter-spacing:-.02em;font-weight:700;margin:0 0 14px;text-wrap:balance;',
              )}
            >
              The whole platform in two and a half minutes.
            </h2>
            <p style={cssToStyle('font-size:16.5px;line-height:1.6;color:var(--muted);margin:0;text-wrap:pretty;')}>
              A versioned prompt, one gateway call that renders it, the trace that call produced, and the tool catalog
              behind it — recorded against a live instance, not a mockup.
            </p>
          </div>
          <DemoVideo />
        </section>

        {/* ===== NAVIGATION LOOP ===== */}
        <section
          id="loop"
          style={cssToStyle(
            'padding:clamp(44px,6vw,80px) 0 clamp(40px,6vw,72px);border-top:1px solid var(--line-soft);',
          )}
        >
          <div style={cssToStyle('max-width:700px;margin-bottom:clamp(30px,4vw,46px);')}>
            <Eyebrow>The round-trip</Eyebrow>
            <h2
              style={cssToStyle(
                'font-size:clamp(26px,3.4vw,40px);line-height:1.1;letter-spacing:-.02em;font-weight:700;margin:0 0 14px;text-wrap:balance;',
              )}
            >
              From a bad answer to a fixed prompt — without leaving the app.
            </h2>
            <p style={cssToStyle('font-size:16.5px;line-height:1.6;color:var(--muted);margin:0;text-wrap:pretty;')}>
              Follow one thread across the whole platform. Land on a session, open its trace, rate the span that missed,
              and jump straight to the exact prompt version that produced it — edit, save, and move the production alias.
              The next run picks up the change. No redeploy, no context-switch, no leaving AcruxCore.
            </p>
          </div>
          <div style={cssToStyle('display:grid;grid-template-columns:repeat(auto-fit,minmax(min(166px,100%),1fr));gap:12px;')}>
            {LOOP_NODES.map((node) => (
              <div
                key={node.n}
                className="acx-hover-border"
                style={cssToStyle(
                  'position:relative;border:1px solid var(--line);background:var(--surface);border-radius:11px;padding:18px 16px 17px;display:flex;flex-direction:column;gap:11px;transition:border-color .16s;',
                )}
              >
                <div style={cssToStyle('display:flex;align-items:center;justify-content:space-between;')}>
                  <span
                    style={cssToStyle(
                      'height:28px;width:28px;flex:none;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--line);border-radius:8px;background:var(--elevated);color:var(--accent);',
                    )}
                  >
                    {node.icon}
                  </span>
                  <span style={{ color: node.arrowColor }}>{node.arrow}</span>
                </div>
                <div>
                  <div style={cssToStyle('display:flex;align-items:center;gap:7px;margin-bottom:5px;')}>
                    <span style={cssToStyle('font-family:var(--mono);font-size:11px;color:var(--faint);')}>{node.n}</span>
                    <h3 style={cssToStyle('font-size:14.5px;font-weight:650;letter-spacing:-.01em;margin:0;')}>
                      {node.label}
                    </h3>
                  </div>
                  <p style={cssToStyle('font-size:13px;line-height:1.5;color:var(--muted);margin:0;text-wrap:pretty;')}>
                    {node.caption}
                  </p>
                </div>
              </div>
            ))}
          </div>
          <p
            style={cssToStyle(
              'font-size:13px;color:var(--faint);margin:18px 0 0;display:flex;align-items:center;gap:8px;',
            )}
          >
            <span style={cssToStyle('display:inline-flex;color:var(--accent);')}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </span>
            Step&nbsp;6 loops back to step&nbsp;1 — the fix is already live the next time that session runs.
          </p>
        </section>

        {/* ===== PILLARS ===== */}
        <section id="pillars" style={cssToStyle('padding:clamp(48px,7vw,88px) 0 clamp(40px,6vw,72px);')}>
          <div style={cssToStyle('max-width:640px;margin-bottom:clamp(32px,4vw,48px);')}>
            <Eyebrow>The platform</Eyebrow>
            <h2
              style={cssToStyle(
                'font-size:clamp(26px,3.4vw,40px);line-height:1.1;letter-spacing:-.02em;font-weight:700;margin:0 0 14px;',
              )}
            >
              Five parts of the LLM stack, one control plane.
            </h2>
            <p style={cssToStyle('font-size:16.5px;line-height:1.6;color:var(--muted);margin:0;text-wrap:pretty;')}>
              Each piece works on its own and composes with the rest. Adopt what you need, no rip-and-replace.
            </p>
          </div>
          <div style={cssToStyle('display:grid;grid-template-columns:repeat(auto-fit,minmax(min(268px,100%),1fr));gap:16px;')}>
            {FEATURE_LIST.map((f) => (
              <Link
                key={f.slug}
                to={`/features/${f.slug}`}
                className="acx-hover-lift"
                style={cssToStyle(
                  'border:1px solid var(--line);background:var(--surface);border-radius:12px;padding:24px 22px 26px;display:flex;flex-direction:column;gap:14px;transition:border-color .16s,transform .16s;color:var(--ink);',
                )}
              >
                <span
                  style={cssToStyle(
                    'height:40px;width:40px;flex:none;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--line);border-radius:9px;background:var(--elevated);color:var(--accent);',
                  )}
                >
                  {f.icon}
                </span>
                <h3 style={cssToStyle('font-size:17px;font-weight:650;letter-spacing:-.01em;margin:2px 0 0;')}>
                  {f.name}
                </h3>
                <p style={cssToStyle('font-size:14.5px;line-height:1.6;color:var(--muted);margin:0;text-wrap:pretty;')}>
                  {f.summary}
                </p>
                <span
                  style={cssToStyle(
                    'margin-top:auto;display:inline-flex;align-items:center;gap:6px;font-size:13.5px;font-weight:600;color:var(--accent);',
                  )}
                >
                  Explore {f.name.toLowerCase()}
                  <Ic size={14} sw={2.2}>
                    <path d="m9 6 6 6-6 6" />
                  </Ic>
                </span>
              </Link>
            ))}
          </div>
        </section>

        {/* ===== HOW IT WORKS ===== */}
        <section id="how" style={cssToStyle('padding:clamp(44px,6vw,80px) 0;border-top:1px solid var(--line-soft);')}>
          <div style={cssToStyle('max-width:640px;margin-bottom:clamp(32px,4vw,48px);')}>
            <Eyebrow>How it works</Eyebrow>
            <h2
              style={cssToStyle(
                'font-size:clamp(26px,3.4vw,40px);line-height:1.1;letter-spacing:-.02em;font-weight:700;margin:0;',
              )}
            >
              Wired in three steps.
            </h2>
          </div>
          <div
            role="tablist"
            aria-label="Code sample language"
            style={cssToStyle(
              'display:flex;align-items:center;gap:4px;padding:0 0 14px;flex-wrap:wrap;',
            )}
          >
            {tabButton('ts', 'TypeScript')}
            {tabButton('py', 'Python')}
            {tabButton('curl', 'curl')}
          </div>
          <div style={cssToStyle('display:grid;grid-template-columns:repeat(auto-fit,minmax(min(250px,100%),1fr));gap:18px;')}>
            {STEPS.map((s) => {
              const codeText = typeof s.code === 'string' ? s.code : (s.code[tab] ?? s.code.ts);
              return (
                <div
                  key={s.n}
                  style={cssToStyle(
                    'border:1px solid var(--line);background:var(--surface);border-radius:12px;padding:24px 22px;display:flex;flex-direction:column;gap:14px;',
                  )}
                >
                  <div style={cssToStyle('display:flex;align-items:center;gap:12px;')}>
                    <span
                      style={cssToStyle(
                        'height:30px;width:30px;flex:none;display:inline-flex;align-items:center;justify-content:center;border-radius:8px;background:var(--accent);color:var(--accent-ink);font-family:var(--mono);font-size:14px;font-weight:700;',
                      )}
                    >
                      {s.n}
                    </span>
                    <div style={cssToStyle('flex:1;height:1px;background:var(--line);')} />
                  </div>
                  <h3 style={cssToStyle('font-size:16.5px;font-weight:650;letter-spacing:-.01em;margin:2px 0 0;')}>
                    {s.title}
                  </h3>
                  <p style={cssToStyle('font-size:14.5px;line-height:1.6;color:var(--muted);margin:0;text-wrap:pretty;')}>
                    {s.body}
                  </p>
                  <code
                    style={cssToStyle(
                      'font-family:var(--mono);font-size:12.5px;color:var(--accent);background:var(--bg);border:1px solid var(--line-soft);border-radius:6px;padding:8px 10px;overflow-x:auto;white-space:pre;',
                    )}
                    dangerouslySetInnerHTML={
                      typeof codeText === 'string' && codeText.includes('<span')
                        ? { __html: codeText }
                        : undefined
                    }
                  >
                    {!(typeof codeText === 'string' && codeText.includes('<span')) ? codeText : undefined}
                  </code>
                </div>
              );
            })}
          </div>
        </section>

        {/* ===== CODE PROOF ===== */}
        <section
          id="code"
          style={cssToStyle(
            'padding:clamp(44px,6vw,80px) 0;border-top:1px solid var(--line-soft);display:grid;grid-template-columns:repeat(auto-fit,minmax(min(330px,100%),1fr));gap:clamp(32px,5vw,56px);align-items:center;',
          )}
        >
          <div>
            <Eyebrow>TypeScript &amp; Python SDKs</Eyebrow>
            <h2
              style={cssToStyle(
                'font-size:clamp(24px,3.2vw,36px);line-height:1.12;letter-spacing:-.02em;font-weight:700;margin:0 0 18px;',
              )}
            >
              Why teams switch.
            </h2>
            <ul style={cssToStyle('list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:16px;')}>
              {REASONS.map((r) => (
                <li key={r.lead} style={cssToStyle('display:flex;gap:12px;align-items:flex-start;')}>
                  <svg style={cssToStyle('flex:none;margin-top:2px;color:var(--accent);')} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m20 6-11 11-5-5" />
                  </svg>
                  <span style={cssToStyle('font-size:15px;line-height:1.55;color:var(--ink);')}>
                    <strong style={cssToStyle('font-weight:650;')}>{r.lead}</strong>{' '}
                    <span style={cssToStyle('color:var(--muted);')}>{r.rest}</span>
                  </span>
                </li>
              ))}
            </ul>
            <Link
              to="/sdk"
              className="acx-hover-border"
              style={cssToStyle(btnSecondary() + 'margin-top:26px;')}
            >
              <span style={cssToStyle('display:inline-flex;align-items:center;gap:8px;')}>
                Explore the SDKs
                <Ic size={15} sw={2.2}>
                  <path d="m9 6 6 6-6 6" />
                </Ic>
              </span>
            </Link>
          </div>

          {/* tabbed code */}
          <div
            style={cssToStyle(
              'border:1px solid var(--line);background:var(--surface);border-radius:12px;overflow:hidden;box-shadow:0 24px 60px -30px rgba(0,0,0,.5);',
            )}
          >
            <div
              role="tablist"
              aria-label="Code sample language"
              style={cssToStyle(
                'display:flex;align-items:center;gap:4px;padding:8px 8px;border-bottom:1px solid var(--line);background:var(--elevated);flex-wrap:wrap;',
              )}
            >
              {tabButton('ts', 'TypeScript')}
              {tabButton('py', 'Python')}
              {tabButton('curl', 'curl')}
            </div>
            <pre
              id="acx-codepanel"
              role="tabpanel"
              aria-labelledby={`acx-codetab-${tab}`}
              style={cssToStyle(
                'margin:0;padding:18px;font-family:var(--mono);font-size:12.5px;line-height:1.75;overflow-x:auto;color:var(--ink);',
              )}
              dangerouslySetInnerHTML={{ __html: codeHtml }}
            />
          </div>
        </section>

        {/* ===== OPEN SOURCE ===== */}
        <section id="open-source" style={cssToStyle('padding:clamp(44px,6vw,80px) 0;border-top:1px solid var(--line-soft);')}>
          <div
            style={cssToStyle(
              'display:grid;grid-template-columns:repeat(auto-fit,minmax(min(330px,100%),1fr));gap:clamp(32px,5vw,56px);align-items:center;',
            )}
          >
            <div>
              <Eyebrow>Open source</Eyebrow>
              <h2
                style={cssToStyle(
                  'font-size:clamp(26px,3.4vw,40px);line-height:1.1;letter-spacing:-.02em;font-weight:700;margin:0 0 14px;text-wrap:balance;',
                )}
              >
                Nothing about the platform is a black box.
              </h2>
              <p style={cssToStyle('font-size:16.5px;line-height:1.6;color:var(--muted);margin:0 0 26px;text-wrap:pretty;')}>
                The API, gateway, dashboard, and both SDKs are public on GitHub under the Apache License 2.0. Read exactly
                how a call gets routed and priced, run the whole stack on your own infrastructure, or send a pull request.
              </p>
              <div style={cssToStyle('display:flex;flex-wrap:wrap;gap:12px;')}>
                <a
                  href={GITHUB_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="acx-hover-bright"
                  style={cssToStyle(btnPrimary())}
                >
                  <span style={cssToStyle('display:inline-flex;align-items:center;gap:8px;')}>
                    <GitHubIcon size={16} />
                    View on GitHub
                  </span>
                </a>
                <a
                  href={`${GITHUB_URL}#readme`}
                  target="_blank"
                  rel="noreferrer"
                  className="acx-hover-border"
                  style={cssToStyle(btnSecondary())}
                >
                  Self-hosting guide
                  <ExternalArrow />
                </a>
              </div>
            </div>
            <div style={cssToStyle('display:flex;flex-direction:column;gap:14px;')}>
              {OPEN_SOURCE_POINTS.map((p) => (
                <div
                  key={p.label}
                  className="acx-hover-border"
                  style={cssToStyle(
                    'display:flex;gap:14px;align-items:flex-start;border:1px solid var(--line);background:var(--surface);border-radius:12px;padding:18px 20px;transition:border-color .16s;',
                  )}
                >
                  <span
                    style={cssToStyle(
                      'height:36px;width:36px;flex:none;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--line);border-radius:9px;background:var(--elevated);color:var(--accent);',
                    )}
                  >
                    {p.icon}
                  </span>
                  <div>
                    <h3 style={cssToStyle('font-size:15px;font-weight:650;letter-spacing:-.01em;margin:0 0 4px;')}>
                      {p.label}
                    </h3>
                    <p style={cssToStyle('font-size:13.5px;line-height:1.55;color:var(--muted);margin:0;text-wrap:pretty;')}>
                      {p.body}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ===== FINAL CTA ===== */}
        <CtaSection
          title="Start free. Ship the first prompt today."
          body="No credit card required. Start on the hosted platform, or self-host the whole stack — your keys, your data."
        />
      </main>

      <MarketingFooter />
    </div>
  );
}

/**
 * Absolute URL of the demo MP4, served from object storage (Cloudflare R2).
 *
 * Deliberately **not** bundled: the file is a regenerated artifact, so committing
 * it would add a multi-megabyte blob to git history on every re-record. It is also
 * not a YouTube embed — that costs ~1.5 MB of third-party JavaScript plus cookies,
 * more page weight than the video itself, and its end screen links visitors away
 * from the page.
 *
 * Empty string = the section is not rendered at all, so the page can never ship a
 * player pointing at a URL that 404s. Set this once the object is live.
 *
 * Served from the `acruxcore-media` bucket via the `media.acruxcore.com` custom
 * domain — a **subdomain** on purpose. Connecting the bare apex to a bucket
 * replaces the root hostname route and takes the whole site offline; that is not
 * hypothetical, it happened on 2026-07-28.
 *
 * Cloudflare returns this with `max-age=14400`, so re-uploading under the same key
 * leaves stale copies at the edge for up to four hours. Either purge the cache or
 * upload under a new dated key and update this line.
 */
const DEMO_VIDEO_URL = 'https://media.acruxcore.com/platform-overview-720p.mp4';

/** Poster and captions are same-origin: both are small and needed before playback. */
const DEMO_POSTER = '/media/demo-poster.jpg';
const DEMO_CAPTIONS = '/media/platform-overview.vtt';

/**
 * Click-to-play product demo.
 *
 * Native `<video>` with no JavaScript at all: it prerenders correctly in the
 * build-time SSR pass, and `preload="none"` means a visitor who never presses
 * play downloads nothing but the poster.
 *
 * Captions are `default`, so they show without the viewer hunting for the control:
 * most people meet a landing-page video muted. They can still be switched off from
 * the player, and they remain a sidecar rather than burned into the picture, so they
 * stay searchable and can be turned off at all.
 *
 * @returns The player, or `null` while {@link DEMO_VIDEO_URL} is unset.
 */
const DemoVideo = (): ReactNode => {
  if (!DEMO_VIDEO_URL) return null;
  return (
    <figure style={cssToStyle('margin:0;')}>
      <div
        style={cssToStyle(
          'border:1px solid var(--line);border-radius:14px;overflow:hidden;background:#000;box-shadow:0 24px 60px rgba(0,0,0,.28);',
        )}
      >
        <video
          controls
          preload="none"
          playsInline
          poster={DEMO_POSTER}
          style={cssToStyle('display:block;width:100%;aspect-ratio:16/9;background:#000;')}
        >
          <source src={DEMO_VIDEO_URL} type="video/mp4" />
          <track kind="captions" src={DEMO_CAPTIONS} srcLang="en" label="English" default />
          Your browser cannot play this video.{' '}
          <a href={DEMO_VIDEO_URL}>Download it instead</a>.
        </video>
      </div>
      <figcaption style={cssToStyle('margin-top:12px;font-size:13.5px;color:var(--muted);')}>
        2 min 36 s · captions on · recorded against a live instance
      </figcaption>
    </figure>
  );
};

const Chevron = (): ReactNode => (
  <Ic size={15} sw={2.2}>
    <path d="m9 6 6 6-6 6" />
  </Ic>
);
const LoopArrow = (): ReactNode => (
  <Ic size={15} sw={2.1}>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
  </Ic>
);

const STEPS: { n: string; title: string; body: string; code: Record<string, string> | string }[] = [
  {
    n: '1',
    title: 'Install the SDK',
    body: 'One client for prompts, gateway, and tracing — TypeScript (Node 18+) or Python (3.9+). Zero config beyond your key.',
    code: 'npm i @acruxcoreai/sdk\npip install acruxcore',
  },
  {
    n: '2',
    title: 'Point your LLM calls at AcruxCore',
    body: 'One method routes, traces, and prices every call — or swap the base URL and your existing OpenAI client keeps working.',
    code: {
      ts: String.raw`const result = await hub.gateway.<span style="color:var(--accent);">chat</span>({
  model: <span style="color:var(--str);">'gpt-4o'</span>,
  messages: [{ role: <span style="color:var(--str);">'user'</span>, content: <span style="color:var(--str);">'Hi'</span> }],
});`,
      py: String.raw`result = <span style="color:var(--varhi);">await</span> hub.gateway.<span style="color:var(--accent);">chat</span>(
    <span style="color:var(--str);">"gpt-4o"</span>,
    [{<span style="color:var(--str);">"role"</span>: <span style="color:var(--str);">"user"</span>, <span style="color:var(--str);">"content"</span>: <span style="color:var(--str);">"Hi"</span>}],
)`,
      curl: String.raw`<span style="color:var(--accent);">curl</span> ${API_BASE_URL}/gateway/chat/completions \
  -H <span style="color:var(--str);">"Authorization: Bearer $KEY"</span> \
  -d <span style="color:var(--str);">'{"model":"gpt-4o",
   "messages":[{"role":"user","content":"Hi"}]}'</span>`,
    },
  },
  {
    n: '3',
    title: 'Watch it all in one dashboard',
    body: 'Prompts, cost, latency, and quality land in a single control plane — live.',
    code: {
      ts: String.raw`<span style="color:var(--varhi);">const</span> { data } = <span style="color:var(--varhi);">await</span> hub.traces.<span style="color:var(--accent);">list</span>({
  sessionId: <span style="color:var(--str);">'support-1234'</span>,
});`,
      py: String.raw`result = <span style="color:var(--varhi);">await</span> hub.traces.<span style="color:var(--accent);">list</span>(
    session_id=<span style="color:var(--str);">"support-1234"</span>,
)`,
      curl: String.raw`<span style="color:var(--accent);">curl</span> <span style="color:var(--str);">"${API_BASE_URL}/traces?sessionId=support-1234"</span> \
  -H <span style="color:var(--str);">"Authorization: Bearer $KEY"</span>`,
    },
  },
];

const REASONS: { lead: string; rest: string }[] = [
  {
    lead: 'Change prompts without a deploy.',
    rest: 'Move the production alias; every SDK cache refreshes in the background.',
  },
  { lead: 'Drop-in gateway.', rest: 'OpenAI-compatible, so your current client and code paths stay put.' },
  {
    lead: 'TypeScript and Python SDKs.',
    rest: 'First-class async clients for both — same prompts, gateway, tool loops, and tracing — plus a plain REST API.',
  },
  {
    lead: 'Every call is a trace.',
    rest: 'Spans for model, tokens, latency, and cost — no extra instrumentation.',
  },
  { lead: 'Own your keys and data.', rest: 'Bring your own provider keys, or self-host the whole platform.' },
  { lead: 'Open source.', rest: 'Apache License 2.0 — read the code, self-host it, or send a pull request.' },
];

/** The three cards in the {@link LandingPage} "Open source" section. */
const OPEN_SOURCE_POINTS: { label: string; body: string; icon: ReactNode }[] = [
  {
    label: 'Audit every call',
    body: 'Read exactly how a prompt renders and a call gets priced — no black box between your app and the model.',
    icon: (
      <Ic size={17}>
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
        <circle cx={12} cy={12} r={3} />
      </Ic>
    ),
  },
  {
    label: 'Self-host on your infra',
    body: 'Run the API, gateway, and dashboard against your own database — your keys, your data, your network.',
    icon: (
      <Ic size={17}>
        <rect x={3} y={4} width={18} height={6} rx={1.5} />
        <rect x={3} y={14} width={18} height={6} rx={1.5} />
        <path d="M7 8h.01M7 18h.01" />
      </Ic>
    ),
  },
  {
    label: 'Apache License 2.0',
    body: 'Permissive and OSI-approved, with nothing gated — fork it, contribute back, or just read the source.',
    icon: (
      <Ic size={17}>
        <path d="M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6Z" />
        <path d="m9 12 2 2 4-4" />
      </Ic>
    ),
  },
];

const LOOP_NODES: { n: string; label: string; caption: string; arrow: ReactNode; arrowColor: string; icon: ReactNode }[] =
  [
    {
      n: '01',
      label: 'Session',
      caption: 'Replay a full agent run, span by span.',
      arrow: <Chevron />,
      arrowColor: 'var(--faint)',
      icon: (
        <Ic>
          <rect x={3} y={4} width={18} height={16} rx={2} />
          <path d="M7 9h7M7 13h4" />
        </Ic>
      ),
    },
    {
      n: '02',
      label: 'Trace',
      caption: 'Model, tokens, latency, cost on every call.',
      arrow: <Chevron />,
      arrowColor: 'var(--faint)',
      icon: (
        <Ic>
          <path d="M4 6h16M4 12h10M4 18h7" />
        </Ic>
      ),
    },
    {
      n: '03',
      label: 'Feedback',
      caption: 'Rate the span that missed; flag the failure.',
      arrow: <Chevron />,
      arrowColor: 'var(--faint)',
      icon: (
        <Ic>
          <path d="M20 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" />
        </Ic>
      ),
    },
    {
      n: '04',
      label: 'Prompt version',
      caption: 'Jump to the exact version that produced it.',
      arrow: <Chevron />,
      arrowColor: 'var(--faint)',
      icon: (
        <Ic>
          <path d="M4 6h16M4 12h16M4 18h10" />
        </Ic>
      ),
    },
    {
      n: '05',
      label: 'Edit & save',
      caption: 'Fix the template, commit a new version.',
      arrow: <Chevron />,
      arrowColor: 'var(--faint)',
      icon: (
        <Ic>
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </Ic>
      ),
    },
    {
      n: '06',
      label: 'Promote alias',
      caption: "Move 'production' to it. No redeploy.",
      arrow: <LoopArrow />,
      arrowColor: 'var(--accent)',
      icon: (
        <Ic>
          <circle cx={12} cy={12} r={9} />
          <path d="M8 12l4-4 4 4M12 8v8" />
        </Ic>
      ),
    },
  ];

/**
 * The two hero variants the {@link RotatingCodeCard} cycles.
 *
 * Keep both at **13 rendered lines**: the panel is sized by its content, so a
 * variant one line longer would nudge everything below the hero on every swap.
 */
const HERO_TS_CODE = String.raw`<span style="color:var(--varhi);">import</span> acruxcore <span style="color:var(--varhi);">from</span> <span style="color:var(--str);">'@acruxcoreai/sdk'</span>;

<span style="color:var(--varhi);">const</span> hub = <span style="color:var(--varhi);">new</span> <span style="color:var(--accent);">acruxcore</span>({ apiKey });

<span style="color:var(--faint);">// move 'production' between versions
</span>
<span style="color:var(--faint);">// — no redeploy of your app
</span>
<span style="color:var(--varhi);">const</span> { messages, tools } = <span style="color:var(--varhi);">await</span> hub.prompts.<span style="color:var(--accent);">render</span>(
  <span style="color:var(--str);">'support-agent'</span>,
  <span style="color:var(--str);">'production'</span>,
  { ticket },
);`;

const HERO_PY_CODE = String.raw`<span style="color:var(--varhi);">from</span> acruxcore <span style="color:var(--varhi);">import</span> <span style="color:var(--accent);">AcruxCore</span>

hub = <span style="color:var(--accent);">AcruxCore</span>(api_key=api_key)

<span style="color:var(--faint);"># move 'production' between versions
</span>
<span style="color:var(--faint);"># — no redeploy of your app
</span>
render = <span style="color:var(--varhi);">await</span> hub.prompts.<span style="color:var(--accent);">render</span>(
    <span style="color:var(--str);">"support-agent"</span>,
    <span style="color:var(--str);">"production"</span>,
    {<span style="color:var(--str);">"ticket"</span>: ticket},
)`;

/** Hero code panel variants, in rotation order. */
const HERO_VARIANTS: CodeVariant[] = [
  { id: 'ts', filename: 'agent.ts', label: 'TS', lang: 'TypeScript', html: HERO_TS_CODE },
  { id: 'py', filename: 'agent.py', label: 'PY', lang: 'Python', html: HERO_PY_CODE },
];

const TS_CODE = String.raw`<span style="color:var(--varhi);">import</span> acruxcore <span style="color:var(--varhi);">from</span> <span style="color:var(--str);">'@acruxcoreai/sdk'</span>;

<span style="color:var(--varhi);">const</span> hub = <span style="color:var(--varhi);">new</span> <span style="color:var(--accent);">acruxcore</span>({ apiKey });

<span style="color:var(--faint);">// rendered prompt + its attached tools
</span>
<span style="color:var(--varhi);">const</span> { messages, tools } =
  <span style="color:var(--varhi);">await</span> hub.prompts.<span style="color:var(--accent);">render</span>(<span style="color:var(--str);">'support-agent'</span>, <span style="color:var(--str);">'production'</span>, { ticket });

<span style="color:var(--faint);">// gateway routes, prices &amp; traces the loop
</span>
<span style="color:var(--varhi);">const</span> result = <span style="color:var(--varhi);">await</span> hub.gateway.<span style="color:var(--accent);">runToolLoop</span>({
  model: <span style="color:var(--str);">'gpt-4o'</span>, messages, toolDefs: tools, dispatch,
});

console.<span style="color:var(--accent);">log</span>(result.content);   <span style="color:var(--faint);">// final answer</span>
console.<span style="color:var(--accent);">log</span>(result.traceId);   <span style="color:var(--faint);">// spans + cost</span>`;

const PY_CODE = String.raw`<span style="color:var(--varhi);">from</span> acruxcore <span style="color:var(--varhi);">import</span> <span style="color:var(--accent);">AcruxCore</span>

hub = <span style="color:var(--accent);">AcruxCore</span>(api_key=api_key)

<span style="color:var(--faint);"># rendered prompt + its attached tools
</span>
render = <span style="color:var(--varhi);">await</span> hub.prompts.<span style="color:var(--accent);">render</span>(<span style="color:var(--str);">"support-agent"</span>, <span style="color:var(--str);">"production"</span>, {<span style="color:var(--str);">"ticket"</span>: ticket})

<span style="color:var(--faint);"># gateway routes, prices &amp; traces the loop
</span>
result = <span style="color:var(--varhi);">await</span> hub.gateway.<span style="color:var(--accent);">run_tool_loop</span>(
    model=<span style="color:var(--str);">"gpt-4o"</span>, messages=render.messages,
    tool_defs=render.tools, dispatch=dispatch,
)

<span style="color:var(--accent);">print</span>(result.content)     <span style="color:var(--faint);"># final answer</span>
<span style="color:var(--accent);">print</span>(result.trace_id)    <span style="color:var(--faint);"># spans + cost</span>`;

const CURL_CODE = String.raw`<span style="color:var(--faint);"># OpenAI-compatible — point any client here
</span>
<span style="color:var(--accent);">curl</span> ${API_BASE_URL}/gateway/chat/completions \
  -H <span style="color:var(--str);">"Authorization: Bearer $ACRUX_GATEWAY_KEY"</span> \
  -H <span style="color:var(--str);">"Content-Type: application/json"</span> \
  -d <span style="color:var(--str);">'{
    "model": "gpt-4o",
    "messages": [
      { "role": "user", "content": "Ship it." }
    ]
  }'
</span>
<span style="color:var(--faint);"># response carries x-gateway-* headers:
</span>
<span style="color:var(--faint);"># request id · provider · cost · cache hit</span>`;
