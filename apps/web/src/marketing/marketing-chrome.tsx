import { useEffect, useState, type ReactNode, type CSSProperties } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { getTheme, toggleTheme, type Theme } from '@/lib/theme';
import { useOptionalAuth } from '@/auth/auth-context-core';
import { REOPEN_COOKIE_BANNER_EVENT } from '@/ui';
import { BrandLockup } from './brand';

/** Public docs site (see cross-cutting-faq: docs.acruxcore.com). */
export const DOCS_URL = 'https://docs.acruxcore.com';

/**
 * The single public inbox. Every contact path on the site — general questions,
 * sales, self-hosting, and security disclosure — resolves here rather than to a
 * per-topic alias, so a visitor never has to guess the right address.
 */
export const SUPPORT_EMAIL = 'support@acruxcore.com';

/**
 * Application form for the AI Agent Engineer role, used on the
 * {@link ../pages/CareersPage} page.
 */
export const AI_AGENT_ENGINEER_FORM_URL = 'https://forms.gle/PpCFM5fRpdpnKeDB7';

/** Hosted API origin + base path, as used in the public code samples. */
export const API_BASE_URL = 'https://api.acruxcore.com/api/v1';

/**
 * Deep links into the docs site. Kept in one place so a page that moves is fixed
 * once — every one of these resolves to a real published page, and the docs build
 * runs with `onBrokenLinks: 'throw'` to keep them that way.
 */
export const DOCS = {
  quickstart: `${DOCS_URL}/docs/getting-started/quickstart`,
  coreConcepts: `${DOCS_URL}/docs/getting-started/core-concepts`,
  introduction: `${DOCS_URL}/docs/getting-started/introduction`,
  apiReference: `${DOCS_URL}/api-reference`,
  blog: `${DOCS_URL}/blog`,
  /**
   * Per-language tutorials, attributed by which SDK the guide actually imports.
   * The site's "TypeScript SDK" / "Python SDK" nav entries point at the `/sdk`
   * page, which describes the client surface and then links these.
   */
  tsSdk: `${DOCS_URL}/docs/guides/use-the-sdk-for-chat-and-feedback`,
  pySdk: `${DOCS_URL}/docs/guides/build-a-tool-calling-agent-in-python-sdk`,
  storeViaApi: `${DOCS_URL}/docs/guides/store-prompts-and-tools-via-api`,
  pyNoSdk: `${DOCS_URL}/docs/guides/build-a-tool-calling-agent-in-python-no-sdk`,
  // No trailing slashes: the docs site is built with `trailingSlash: false`, so a
  // trailing slash costs an extra redirect hop on every click.
  /** Per-pillar reference + guide targets used by the feature pages. */
  promptsApi: `${DOCS_URL}/api-reference/prompts`,
  gatewayApi: `${DOCS_URL}/api-reference/gateway`,
  tracesApi: `${DOCS_URL}/api-reference/traces`,
  toolsApi: `${DOCS_URL}/api-reference/tools`,
  datasetsApi: `${DOCS_URL}/api-reference/datasets`,
  versionPrompt: `${DOCS_URL}/docs/guides/version-a-prompt`,
  useGateway: `${DOCS_URL}/docs/guides/route-calls-through-the-gateway`,
  traceCall: `${DOCS_URL}/docs/guides/trace-an-llm-call`,
  sessionsTraces: `${DOCS_URL}/docs/guides/using-sessions-and-traces`,
  attachTool: `${DOCS_URL}/docs/guides/build-and-attach-a-tool`,
  evaluatePrompt: `${DOCS_URL}/docs/guides/evaluate-a-prompt`,
  inviteTeammate: `${DOCS_URL}/docs/guides/invite-a-teammate`,
} as const;

/**
 * Set `document.title` for a client-rendered marketing page and restore the
 * previous title on unmount.
 *
 * The build prerenders the correct `<title>` into each page's static HTML, but a
 * client-side SPA navigation between marketing pages does not touch the title on
 * its own — this keeps the browser tab accurate after those transitions.
 *
 * @param title - The full document title to apply while mounted.
 */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}

/**
 * Convert a raw CSS declaration string into a React style object, so the design's
 * exact inline styles are preserved verbatim.
 *
 * @param css - Semicolon-separated CSS declarations (e.g. `"margin:0;color:red"`).
 * @returns The equivalent {@link CSSProperties} object.
 */
export function cssToStyle(css: string): CSSProperties {
  const out: Record<string, string> = {};
  for (const decl of css.split(';')) {
    const i = decl.indexOf(':');
    if (i === -1) continue;
    const prop = decl.slice(0, i).trim();
    const value = decl.slice(i + 1).trim();
    if (!prop) continue;
    const key = prop
      .replace(/^-ms-/, 'ms-')
      .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    out[key] = value;
  }
  return out as CSSProperties;
}

/** Small svg wrapper matching the design's icon defaults. */
export function Ic({ size = 20, sw = 1.9, children }: { size?: number; sw?: number; children: ReactNode }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

/** Uppercase accent section label. */
export function Eyebrow({ children }: { children: ReactNode }): ReactNode {
  return (
    <p
      style={cssToStyle(
        'font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:var(--accent);font-weight:600;margin:0 0 14px;',
      )}
    >
      {children}
    </p>
  );
}

/**
 * Style string for the accent-filled primary action, shared by every marketing
 * CTA so hero, feature, and pricing buttons stay identical.
 *
 * @param height - Button height in px; 44 for in-page CTAs, 46 for the big
 *   closing block, 34 for the nav.
 * @returns A declaration string for {@link cssToStyle}.
 */
export function btnPrimary(height = 44): string {
  return `display:inline-flex;align-items:center;justify-content:center;height:${height}px;padding:0 ${
    height >= 44 ? 22 : 15
  }px;border-radius:8px;background:var(--accent);color:var(--accent-ink);font-size:${
    height >= 44 ? 15 : 13.5
  }px;font-weight:650;border:1px solid var(--accent);transition:filter .15s;white-space:nowrap;`;
}

/**
 * Style string for the bordered secondary action that sits next to
 * {@link btnPrimary}.
 *
 * @param height - Button height in px, matched to the primary beside it.
 * @returns A declaration string for {@link cssToStyle}.
 */
export function btnSecondary(height = 44): string {
  return `display:inline-flex;align-items:center;justify-content:center;gap:8px;height:${height}px;padding:0 20px;border-radius:8px;background:var(--surface);color:var(--ink);font-size:15px;font-weight:550;border:1px solid var(--line);transition:border-color .15s;white-space:nowrap;`;
}

/** The small "opens elsewhere" arrow used on outbound links. */
export function ExternalArrow(): ReactNode {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7 17 17 7" />
      <path d="M8 7h9v9" />
    </svg>
  );
}

const CARD_SHELL =
  'border:1px solid var(--line);background:var(--surface);border-radius:12px;overflow:hidden;box-shadow:0 24px 60px -30px rgba(0,0,0,.55);';
const CARD_BAR =
  'display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid var(--line);background:var(--elevated);';
const CARD_DOT = 'height:10px;width:10px;border-radius:50%;background:var(--line);';
const CARD_FILENAME = 'margin-left:8px;font-family:var(--mono);font-size:12px;color:var(--faint);';
const CARD_PRE =
  'margin:0;padding:18px 18px 20px;font-family:var(--mono);font-size:13px;line-height:1.7;overflow-x:auto;color:var(--ink);';

/** The three macOS-style window dots shared by every code panel. */
function CardDots(): ReactNode {
  return (
    <>
      <span style={cssToStyle(CARD_DOT)} />
      <span style={cssToStyle(CARD_DOT)} />
      <span style={cssToStyle(CARD_DOT)} />
    </>
  );
}

/**
 * A code panel with a macOS-style title bar and syntax-colored body.
 *
 * The body is pre-highlighted HTML (spans carrying the design's token colors)
 * rather than a runtime highlighter, so the panel costs nothing at render time
 * and prerenders to static markup.
 *
 * @param filename - Shown in the title bar, e.g. `agent.ts`.
 * @param lang - Uppercase language badge on the right of the title bar.
 * @param html - Pre-highlighted inner HTML for the `<pre>`.
 * @returns The rendered code panel.
 */
export function CodeCard({ filename, lang, html }: { filename: string; lang: string; html: string }): ReactNode {
  return (
    <div style={cssToStyle(CARD_SHELL)}>
      <div style={cssToStyle(CARD_BAR)}>
        <CardDots />
        <span style={cssToStyle(CARD_FILENAME)}>{filename}</span>
        <span
          style={cssToStyle(
            'margin-left:auto;font-family:var(--mono);font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--accent);',
          )}
        >
          {lang}
        </span>
      </div>
      <pre style={cssToStyle(CARD_PRE)} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

/** One language a {@link RotatingCodeCard} can show. */
export interface CodeVariant {
  /** Stable id used for the tab's `id`/`aria-controls` wiring, e.g. `ts`. */
  id: string;
  /** Title-bar filename, e.g. `agent.ts`. */
  filename: string;
  /** Short tab label, e.g. `TS`. */
  label: string;
  /** Accessible name for the tab, e.g. `TypeScript`. */
  lang: string;
  /** Pre-highlighted inner HTML for the `<pre>`. */
  html: string;
}

/**
 * A {@link CodeCard} that cycles through the same example in several languages,
 * cross-fading between them, with a tab per language so a visitor can pin one.
 *
 * Exists so the hero can say "Node *and* Python" without a second card or a
 * sentence claiming it. The rotation is decoration, so it is disabled entirely
 * under `prefers-reduced-motion`, paused while the pointer or keyboard focus is
 * inside the card (nobody should have code move while reading it), and stopped
 * for good once a visitor picks a language — an explicit choice outranks the
 * carousel.
 *
 * Server-safe: the first variant renders with no timer and no `window` access, so
 * the prerendered HTML matches what the client hydrates. Give every variant the
 * same number of lines — the panel is sized by its content, so uneven variants
 * would shift the page on each swap.
 *
 * @param variants - The languages to cycle, in order; the first one renders first.
 * @param intervalMs - Milliseconds each variant is shown. Defaults to 5500.
 * @returns The rendered rotating code panel.
 */
export function RotatingCodeCard({
  variants,
  intervalMs = 5500,
}: {
  variants: CodeVariant[];
  intervalMs?: number;
}): ReactNode {
  const [index, setIndex] = useState(0);
  /** True once a visitor picked a language — ends the rotation permanently. */
  const [pinned, setPinned] = useState(false);
  /** True while the pointer or focus is inside the card. */
  const [held, setHeld] = useState(false);
  /** Suppresses the fade on the very first paint, including hydration. */
  const [swapped, setSwapped] = useState(false);

  useEffect(() => {
    if (pinned || held || variants.length < 2) return undefined;
    // Reduced motion means no ambient movement at all, not a faster fade: the
    // tabs still let someone switch deliberately.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined;

    const timer = window.setInterval(() => {
      setSwapped(true);
      setIndex((i) => (i + 1) % variants.length);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [pinned, held, intervalMs, variants.length]);

  const active = variants[index] ?? variants[0];

  // min-height/inline-flex rather than vertical padding: the pill is small by
  // design, but its hit area still has to clear the 24px touch-target floor the
  // rest of the site keeps to.
  const tabBase =
    'flex:none;display:inline-flex;align-items:center;min-height:24px;padding:0 9px;border-radius:5px;border:1px solid transparent;background:transparent;font-family:var(--mono);font-size:10.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;transition:color .15s,border-color .15s,background .15s;';

  return (
    <div
      style={cssToStyle(CARD_SHELL)}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <div style={cssToStyle(CARD_BAR)}>
        <CardDots />
        {/* The filename is part of the swap — agent.ts becoming agent.py is the
            whole message, so it fades with the body rather than staying put. */}
        <span key={active.filename} className={swapped ? 'acx-code-swap' : undefined} style={cssToStyle(CARD_FILENAME)}>
          {active.filename}
        </span>
        <div
          role="tablist"
          aria-label="Code language"
          style={cssToStyle('margin-left:auto;display:flex;align-items:center;gap:4px;')}
        >
          {variants.map((v, i) => (
            <button
              key={v.id}
              role="tab"
              id={`acx-hero-tab-${v.id}`}
              type="button"
              className="acx-code-tab"
              aria-selected={i === index}
              aria-controls="acx-hero-code"
              aria-label={v.lang}
              onClick={() => {
                setSwapped(true);
                setPinned(true);
                setIndex(i);
              }}
              style={cssToStyle(
                tabBase +
                  (i === index
                    ? 'color:var(--accent);border-color:var(--line);background:var(--surface);'
                    : 'color:var(--faint);'),
              )}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>
      <pre
        key={active.id}
        id="acx-hero-code"
        role="tabpanel"
        aria-labelledby={`acx-hero-tab-${active.id}`}
        className={swapped ? 'acx-code-swap' : undefined}
        style={cssToStyle(CARD_PRE)}
        dangerouslySetInnerHTML={{ __html: active.html }}
      />
    </div>
  );
}

/**
 * The closing "start free" block that ends the landing page and every feature and
 * pricing page.
 *
 * @param title - The block's `<h2>`.
 * @param body - Supporting line under the title.
 * @returns The rendered CTA section.
 */
export function CtaSection({ title, body }: { title: string; body: string }): ReactNode {
  return (
    <section id="cta" style={cssToStyle('padding:clamp(30px,5vw,56px) 0 clamp(48px,7vw,88px);')}>
      <div
        style={cssToStyle(
          'position:relative;overflow:hidden;border:1px solid var(--line);border-radius:16px;background:var(--surface);padding:clamp(38px,6vw,68px) clamp(24px,5vw,56px);text-align:center;',
        )}
      >
        <div
          style={cssToStyle(
            'position:absolute;inset:0;background:radial-gradient(ellipse at 50% -10%, color-mix(in oklch, var(--accent) 16%, transparent), transparent 60%);pointer-events:none;',
          )}
        />
        <div style={cssToStyle('position:relative;')}>
          <h2
            style={cssToStyle(
              'font-size:clamp(26px,3.6vw,42px);line-height:1.08;letter-spacing:-.025em;font-weight:700;margin:0 0 16px;text-wrap:balance;',
            )}
          >
            {title}
          </h2>
          <p
            style={cssToStyle(
              'font-size:16.5px;color:var(--muted);margin:0 auto 30px;max-width:52ch;line-height:1.6;text-wrap:pretty;',
            )}
          >
            {body}
          </p>
          <div style={cssToStyle('display:flex;flex-wrap:wrap;gap:12px;justify-content:center;')}>
            <Link to="/signup" className="acx-hover-bright" style={cssToStyle(btnPrimary(46))}>
              Start free
            </Link>
            <a
              href={DOCS.quickstart}
              target="_blank"
              rel="noreferrer"
              className="acx-hover-border"
              style={cssToStyle(btnSecondary(46) + 'background:transparent;')}
            >
              Read the quickstart
              <ExternalArrow />
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

const SunIcon = (): ReactNode => (
  <Ic size={17}>
    <circle cx={12} cy={12} r={4} />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Ic>
);
const MoonIcon = (): ReactNode => (
  <Ic size={17}>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
  </Ic>
);

/** A single footer link — internal (`to`, rendered as a router `<Link>`) or external/anchor (`href`). */
interface FooterLink {
  label: string;
  to?: string;
  href?: string;
  external?: boolean;
  icon?: ReactNode;
}

const FOOTER_COLS: { title: string; links: FooterLink[] }[] = [
  {
    title: 'Product',
    links: [
      { label: 'Prompts', to: '/features/prompts' },
      { label: 'Gateway', to: '/features/gateway' },
      { label: 'Tracing', to: '/features/tracing' },
      { label: 'Tools', to: '/features/tools' },
      { label: 'Evaluation', to: '/features/evaluation' },
      { label: 'Pricing', to: '/pricing' },
    ],
  },
  {
    title: 'Developers',
    links: [
      { label: 'Quickstart', href: DOCS.quickstart, external: true },
      { label: 'Core concepts', href: DOCS.coreConcepts, external: true },
      // These land on the /sdk page's language sections, which describe the client
      // surface first and then link that language's tutorials — rather than
      // dropping a visitor straight into one tutorial.
      { label: 'TypeScript SDK', to: '/sdk#typescript' },
      { label: 'Python SDK', to: '/sdk#python' },
      { label: 'API reference', href: DOCS.apiReference, external: true },
      { label: 'Blog', href: DOCS.blog, external: true },
    ],
  },
  {
    title: 'Company',
    links: [
      { label: 'About', to: '/about' },
      { label: 'Contact', to: '/contact' },
      { label: 'Security', to: '/security' },
      { label: 'Privacy', to: '/privacy' },
      { label: 'Terms', to: '/terms' },
    ],
  },
  {
    title: 'Follow Us',
    links: [
      {
        label: 'LinkedIn',
        href: 'https://www.linkedin.com/company/acruxcore/',
        external: true,
        icon: (
          <Ic size={14} sw={2}>
            <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-7a6 6 0 0 1 6-6z" />
            <rect x={2} y={9} width={4} height={12} />
            <circle cx={4} cy={4} r={2} />
          </Ic>
        ),
      },
      {
        label: 'X (Twitter)',
        href: 'https://x.com/AcruxCore',
        external: true,
        icon: (
          <Ic size={14} sw={2}>
            <path d="M4 4l6.5 8L4 20h2l5.5-6.5L16 20h4l-6.5-8L20 4h-2l-5.5 6.5L8 4H4z" />
          </Ic>
        ),
      },
      {
        label: 'YouTube',
        href: 'https://www.youtube.com/@AcruxCoreAI',
        external: true,
        icon: (
          <Ic size={14} sw={2}>
            <path d="M22.54 6.42a2.78 2.78 0 0 0-1.94-2C18.88 4 12 4 12 4s-6.88 0-8.6.46a2.78 2.78 0 0 0-1.94 2A29 29 0 0 0 1 11.75a29 29 0 0 0 .46 5.33A2.78 2.78 0 0 0 3.4 19.1c1.72.46 8.6.46 8.6.46s6.88 0 8.6-.46a2.78 2.78 0 0 0 1.94-2 29 29 0 0 0 .46-5.25 29 29 0 0 0-.46-5.43z" />
            <polygon points="9.75,15.02 15.5,11.75 9.75,8.48" />
          </Ic>
        ),
      },
    ],
  },
];

/**
 * Render one footer link, choosing a router `<Link>` for internal routes and an
 * `<a>` for external/anchor targets.
 *
 * @param link - The link descriptor.
 * @returns The rendered anchor element.
 */
function FooterAnchor({ link }: { link: FooterLink }): ReactNode {
  const style = cssToStyle('font-size:13.5px;color:var(--muted);display:inline-flex;align-items:center;gap:6px;');
  const content = (
    <>
      {link.icon}
      {link.label}
    </>
  );
  if (link.to) {
    return (
      <Link to={link.to} className="acx-foot-link" style={style}>
        {content}
      </Link>
    );
  }
  return (
    <a
      href={link.href}
      {...(link.external ? { target: '_blank', rel: 'noreferrer' } : {})}
      className="acx-foot-link"
      style={style}
    >
      {content}
    </a>
  );
}

/**
 * Sticky top navigation shared by every public marketing page.
 *
 * The primary section anchors (`Features`, `How it works`, `SDK`) point at
 * in-page ids on the landing route. On the landing page itself they are bare
 * hashes (`#pillars`) for smooth same-page scroll; on any other marketing page
 * they are prefixed with `/` (`/#pillars`) so the browser navigates home first.
 *
 * @param onLanding - True when rendered on the landing route, so section anchors
 *   stay same-page.
 * @returns The rendered `<header>`.
 */
export function MarketingHeader({ onLanding = false }: { onLanding?: boolean }): ReactNode {
  const [theme, setThemeState] = useState<Theme>(() => getTheme());
  const [menuOpen, setMenuOpen] = useState(false);
  const flipTheme = (): void => setThemeState(toggleTheme());
  const { pathname } = useLocation();
  // null outside an AuthProvider (the static prerender build) — treated as signed out.
  const isAuthenticated = Boolean(useOptionalAuth()?.isAuthenticated);

  // A route change means the visitor followed a link out of the mobile panel —
  // leaving it open would cover the page they just asked for.
  useEffect(() => setMenuOpen(false), [pathname]);

  // Section anchors are same-page on the landing route and root-relative elsewhere.
  const home = onLanding ? '' : '/';
  // `RootRoute` re-evaluates on *any* navigation targeting "/" — even a hash-only
  // one on a route that's already there, since `useLocation()` still reports a new
  // location object with its own (unset) state. Without `fromLogo` on every one of
  // these, a signed-in visitor clicking "Features" while already on the landing
  // page gets bounced to `/prompts` exactly like the off-landing case does.
  const toRoot = { state: { fromLogo: true } };
  const navItems: (FooterLink & { state?: { fromLogo: boolean } })[] = [
    { label: 'Features', to: `${home}#pillars`, ...toRoot },
    { label: 'How it works', to: `${home}#how`, ...toRoot },
    { label: 'Pricing', to: '/pricing' },
    { label: 'Docs', href: DOCS_URL, external: true },
  ];
  const navLinkStyle = cssToStyle('font-size:13.5px;color:var(--muted);font-weight:500;');

  const navLink = (item: FooterLink & { state?: { fromLogo: boolean } }, onClick?: () => void): ReactNode =>
    item.to ? (
      <Link
        key={item.label}
        to={item.to}
        state={item.state}
        onClick={onClick}
        className="acx-hover-muted"
        style={navLinkStyle}
      >
        {item.label}
      </Link>
    ) : (
      <a
        key={item.label}
        href={item.href}
        onClick={onClick}
        {...(item.external ? { target: '_blank', rel: 'noreferrer' } : {})}
        className="acx-hover-muted"
        style={navLinkStyle}
      >
        {item.label}
      </a>
    );

  return (
    <header
      style={cssToStyle(
        'position:sticky;top:0;z-index:50;backdrop-filter:blur(12px);background:color-mix(in oklch, var(--bg) 78%, transparent);border-bottom:1px solid var(--line);',
      )}
    >
      <nav
        aria-label="Main"
        className="acx-nav"
        style={cssToStyle('max-width:1160px;margin:0 auto;padding:14px 24px;display:flex;align-items:center;gap:24px;')}
      >
        <Link
          to="/"
          state={{ fromLogo: true }}
          className="acx-brand-link"
          style={cssToStyle('display:flex;align-items:center;flex:none;')}
        >
          <BrandLockup height={23} className="acx-nav-wordmark" />
        </Link>

        <div
          className="acx-nav-links"
          style={cssToStyle('display:flex;align-items:center;gap:26px;flex:1;justify-content:center;')}
        >
          {navItems.map((item) => navLink(item))}
        </div>

        <div style={cssToStyle('display:flex;align-items:center;gap:10px;flex:none;margin-left:auto;')}>
          <button
            onClick={flipTheme}
            aria-label="Toggle color theme"
            title="Toggle theme"
            className="acx-hover-faint"
            style={cssToStyle(
              'height:34px;width:34px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--line);background:var(--surface);color:var(--muted);border-radius:8px;cursor:pointer;transition:border-color .15s,color .15s;',
            )}
          >
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </button>
          {isAuthenticated ? (
            <Link
              to="/prompts"
              className="acx-nav-cta acx-hover-bright"
              style={cssToStyle(
                'display:inline-flex;align-items:center;height:34px;padding:0 15px;border-radius:8px;background:var(--accent);color:var(--accent-ink);font-size:13.5px;font-weight:650;border:1px solid var(--accent);transition:filter .15s;white-space:nowrap;',
              )}
            >
              Go to app
            </Link>
          ) : (
            <>
              <Link
                to="/login"
                className="acx-nav-signin acx-hover-muted"
                style={cssToStyle('font-size:13.5px;color:var(--muted);font-weight:500;padding:0 6px;')}
              >
                Sign in
              </Link>
              <Link
                to="/signup"
                className="acx-nav-cta acx-hover-bright"
                style={cssToStyle(
                  'display:inline-flex;align-items:center;height:34px;padding:0 15px;border-radius:8px;background:var(--accent);color:var(--accent-ink);font-size:13.5px;font-weight:650;border:1px solid var(--accent);transition:filter .15s;white-space:nowrap;',
                )}
              >
                Start free
              </Link>
            </>
          )}
          <button
            className="acx-nav-burger acx-hover-faint"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
            aria-controls="acx-mobile-nav"
            style={cssToStyle(
              'height:34px;width:34px;align-items:center;justify-content:center;border:1px solid var(--line);background:var(--surface);color:var(--muted);border-radius:8px;cursor:pointer;transition:border-color .15s,color .15s;',
            )}
          >
            {menuOpen ? (
              <Ic size={17}>
                <path d="M18 6 6 18M6 6l12 12" />
              </Ic>
            ) : (
              <Ic size={17}>
                <path d="M3 6h18M3 12h18M3 18h18" />
              </Ic>
            )}
          </button>
        </div>
      </nav>

      {menuOpen ? (
        <div
          id="acx-mobile-nav"
          className="acx-nav-panel"
          style={cssToStyle(
            'border-top:1px solid var(--line-soft);background:var(--surface);padding:14px 24px 20px;flex-direction:column;gap:16px;',
          )}
        >
          {navItems.map((item) => navLink(item, () => setMenuOpen(false)))}
          {isAuthenticated ? null : (
            <Link
              to="/login"
              onClick={() => setMenuOpen(false)}
              className="acx-hover-muted"
              style={cssToStyle('font-size:13.5px;color:var(--muted);font-weight:500;')}
            >
              Sign in
            </Link>
          )}
        </div>
      ) : null}
    </header>
  );
}

/**
 * Shared footer for every public marketing page: brand blurb, three link
 * columns (Product / Developers / Company), and the legal bottom bar.
 *
 * @returns The rendered `<footer>`.
 */
export function MarketingFooter(): ReactNode {
  return (
    <footer style={cssToStyle('border-top:1px solid var(--line);background:var(--surface);')}>
      <div
        style={cssToStyle(
          'max-width:1160px;margin:0 auto;padding:clamp(40px,5vw,60px) 24px 30px;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(150px,100%),1fr));gap:36px;',
        )}
      >
        <div style={cssToStyle('min-width:200px;')}>
          <Link
            to="/"
            state={{ fromLogo: true }}
            className="acx-brand-link"
            style={cssToStyle('display:flex;align-items:center;margin-bottom:14px;')}
          >
            <BrandLockup height={22} />
          </Link>
          <p style={cssToStyle('font-size:13.5px;color:var(--faint);margin:0;max-width:30ch;line-height:1.6;')}>
            Version prompts, route LLM calls, trace and evaluate — one platform.
          </p>
        </div>
        {FOOTER_COLS.map((col) => (
          <div key={col.title}>
            <p
              style={cssToStyle(
                'font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);font-weight:600;margin:0 0 16px;',
              )}
            >
              {col.title}
            </p>
            <ul style={cssToStyle('list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:11px;')}>
              {col.links.map((link) => (
                <li key={link.label}>
                  <FooterAnchor link={link} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div
        style={cssToStyle(
          'max-width:1160px;margin:0 auto;padding:22px 24px 30px;border-top:1px solid var(--line-soft);display:flex;flex-wrap:wrap;gap:14px;justify-content:space-between;align-items:center;',
        )}
      >
        <p style={cssToStyle('font-size:12.5px;color:var(--faint);margin:0;')}>
          © {new Date().getFullYear()} Acrux Core, Inc. All rights reserved.
        </p>
        <div style={cssToStyle('display:flex;gap:20px;flex-wrap:wrap;')}>
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="acx-hover-muted"
            style={cssToStyle('font-size:12.5px;color:var(--faint);')}
          >
            {SUPPORT_EMAIL}
          </a>
          <Link to="/privacy" className="acx-foot-legal acx-hover-muted" style={cssToStyle('font-size:12.5px;color:var(--faint);')}>
            Privacy
          </Link>
          <Link to="/terms" className="acx-foot-legal acx-hover-muted" style={cssToStyle('font-size:12.5px;color:var(--faint);')}>
            Terms
          </Link>
          <Link to="/contact" className="acx-foot-legal acx-hover-muted" style={cssToStyle('font-size:12.5px;color:var(--faint);')}>
            Contact
          </Link>
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event(REOPEN_COOKIE_BANNER_EVENT))}
            className="acx-foot-legal acx-hover-muted"
            style={cssToStyle('font-size:12.5px;color:var(--faint);background:none;border:0;padding:0;cursor:pointer;')}
          >
            Cookie preferences
          </button>
        </div>
      </div>
    </footer>
  );
}

/**
 * Scoped styles for every marketing page: the `.acx-landing` design tokens
 * (color, type) that follow the app-wide `data-theme` on the root, plus the
 * `.acx-prose` rules used by content pages (About, legal, etc.).
 *
 * Kept as a single string so both the landing page and content pages inject the
 * identical scoped CSS — the resets and tokens cannot leak into the app shell.
 */
export const MARKETING_CSS = `
.acx-landing{
  --bg:#0b0e14; --surface:#12161b; --elevated:#171c23;
  --line:#232a34; --line-soft:#1b212a;
  /* --faint was #5c6472, which measured 3.0:1 on --surface — under the 4.5:1 AA
     floor for small text, and it carries the footer's legal links. Lightened until
     the worst of bg/surface/elevated clears 4.5:1 (now 5.12 / 4.81 / 4.53). */
  --ink:#e6eaf0; --muted:#8b94a3; --faint:#7d848e;
  --accent:#b6f400; --accent-dim:#7f9c1e; --accent-ink:#0b0e14;
  --ok:#3fb950; --warn:#e3b341; --varhi:#d2a8ff;
  --str:#9ecb3a;
  --sans:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,Roboto,Helvetica,Arial,sans-serif;
  --mono:ui-monospace,'SF Mono',SFMono-Regular,'JetBrains Mono',Menlo,Consolas,monospace;
  font-family:var(--sans); -webkit-font-smoothing:antialiased; line-height:1.5;
}
:root[data-theme='light'] .acx-landing{
  --bg:#f6f7f9; --surface:#ffffff; --elevated:#f0f2f5;
  --line:#dfe3e9; --line-soft:#e9ecf1;
  /* Same AA fix as the dark theme, darkened instead (now 4.72 / 5.06 / 4.51).
     The light --accent is the readable stand-in for the neon brand green, so it is
     nudged too — it was 4.46 on --elevated, where the code-panel language badge
     and the SDK method chips sit. */
  --ink:#10141a; --muted:#5a6472; --faint:#686f7b;
  --accent:#4c7b00; --accent-dim:#6f9c1e; --accent-ink:#ffffff;
  --ok:#1a7f37; --warn:#9a6700; --varhi:#6f42c1; --str:#3e7a12;
}
.acx-landing *{box-sizing:border-box;}
.acx-landing a{color:var(--ink);text-decoration:none;}
.acx-landing a:hover{color:var(--accent);}
.acx-landing ::selection{background:var(--accent);color:var(--accent-ink);}
.acx-landing :focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px;}
.acx-landing .acx-hover-bright:hover{filter:brightness(1.1);}
.acx-landing .acx-hover-border:hover{border-color:var(--faint) !important;}
.acx-landing .acx-hover-lift:hover{border-color:var(--faint) !important;transform:translateY(-2px);}
.acx-landing .acx-hover-faint:hover{border-color:var(--faint) !important;color:var(--ink) !important;}
.acx-landing .acx-foot-link:hover{color:var(--accent) !important;}
/* Footer link rows sat at ~18px tall — under the 24px minimum touch target. The
   padding brings each row to 24px without changing the visual rhythm. */
.acx-landing .acx-foot-link,
.acx-landing .acx-foot-legal{display:inline-block;padding:3px 0;}
/* Same for the two wordmark links, which matched neither the 34px nav controls
   nor the 24px floor. */
.acx-landing .acx-brand-link{padding:6px 0;}
.acx-landing .acx-hover-muted:hover{color:var(--muted) !important;}
@keyframes acx-pulse{0%,100%{opacity:.55;}50%{opacity:1;}}
/* The hero code panel swapping languages. React remounts the <pre> on a new key,
   which is what replays this. */
@keyframes acx-code-in{from{opacity:0;transform:translateY(5px);}to{opacity:1;transform:none;}}
.acx-landing .acx-code-swap{animation:acx-code-in .34s ease-out;}
/* The inactive language pill is deliberately quiet, so it needs a hover state to
   read as clickable rather than as a disabled label. */
.acx-landing .acx-code-tab:hover{color:var(--ink) !important;}
@media (prefers-reduced-motion: reduce){.acx-landing *{animation-duration:.001ms !important;transition-duration:.001ms !important;}}

/* Keep the sticky header from covering whatever a #hash link just scrolled to. */
.acx-landing [id]{scroll-margin-top:82px;}

/* ── responsive nav: inline links on desktop, a burger panel below 900px ── */
.acx-landing .acx-nav-burger{display:none;}
.acx-landing .acx-nav-panel{display:flex;}
@media (max-width:900px){
  .acx-landing .acx-nav-links{display:none !important;}
  .acx-landing .acx-nav-signin{display:none !important;}
  .acx-landing .acx-nav-burger{display:inline-flex !important;}
}
/* Small phones: brand + theme toggle + CTA + burger together exceeded a 320-360px
   viewport, so the row was clipped and the burger became unreachable. Tighten the
   gutters and the CTA instead of dropping any of the four. */
/* Every override is !important because the design applies its styles inline for
   pixel fidelity, and an inline declaration beats a stylesheet rule on its own. */
@media (max-width:480px){
  .acx-landing .acx-nav{padding-left:16px !important;padding-right:16px !important;gap:12px !important;}
  /* The brand is an SVG lockup, so it shrinks by height rather than font-size. */
  .acx-landing .acx-nav-wordmark{height:20px !important;}
  .acx-landing .acx-nav-cta{height:32px !important;padding:0 11px !important;font-size:12.5px !important;}
}

/* ── content-page prose (About, Security, legal) ── */
.acx-prose{color:var(--ink);font-size:15.5px;line-height:1.72;}
.acx-prose > *:first-child{margin-top:0;}
.acx-prose h2{font-size:clamp(20px,2.6vw,26px);line-height:1.2;letter-spacing:-.018em;font-weight:700;margin:44px 0 14px;}
.acx-prose h3{font-size:16.5px;font-weight:650;letter-spacing:-.01em;margin:28px 0 10px;}
.acx-prose p{color:var(--muted);margin:0 0 16px;text-wrap:pretty;}
.acx-prose ul{list-style:disc;margin:0 0 18px;padding-left:20px;display:flex;flex-direction:column;gap:9px;color:var(--muted);}
.acx-prose li{line-height:1.6;}
.acx-prose li::marker{color:var(--accent);}
.acx-prose a{color:var(--accent);text-decoration:none;font-weight:550;}
.acx-prose a:hover{text-decoration:underline;}
.acx-prose strong{color:var(--ink);font-weight:650;}
.acx-prose code{font-family:var(--mono);font-size:.9em;background:var(--elevated);border:1px solid var(--line-soft);border-radius:5px;padding:1px 6px;color:var(--ink);}
.acx-prose hr{border:none;border-top:1px solid var(--line-soft);margin:36px 0;}
`;
