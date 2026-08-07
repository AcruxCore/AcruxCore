import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { MarketingShell } from '../MarketingShell';
import {
  cssToStyle,
  Eyebrow,
  CtaSection,
  btnPrimary,
  btnSecondary,
  useDocumentTitle,
  SUPPORT_EMAIL,
  DOCS,
  GITHUB_URL,
  ExternalArrow,
} from '../marketing-chrome';

/** One pricing column. */
interface Plan {
  name: string;
  /** The headline figure or its honest stand-in. */
  price: string;
  /** Qualifier under the price, e.g. "while AcruxCore is in beta". */
  priceNote: string;
  blurb: string;
  features: string[];
  cta: { label: string; to?: string; href?: string };
  /** Draws the accent border and "Most teams start here" ribbon. */
  featured?: boolean;
}

/**
 * The public plans.
 *
 * Deliberately carries no invented dollar figures: the platform is in beta and
 * post-beta pricing has not been set, so quoting a number here would be a promise
 * we cannot keep. Each column states what is true today and what to do next.
 */
const PLANS: Plan[] = [
  {
    name: 'Beta',
    price: 'Free',
    priceNote: 'while AcruxCore is in beta',
    blurb: 'The whole platform, unlocked. You connect your own provider keys, so the only model spend is the one you already have.',
    features: [
      'Prompts, gateway, tracing, tools, and evaluation',
      'Bring your own provider keys — no token markup',
      'Unlimited prompt and tool versions',
      'Team members with roles and invites',
      'Email support',
    ],
    cta: { label: 'Start free', to: '/signup' },
    featured: true,
  },
  {
    name: 'Self-hosted',
    price: 'Your infra',
    priceNote: 'clone the public repo, run it yourself',
    blurb: 'AcruxCore is open source under the Apache License 2.0 — clone the repo and run the API, gateway, and dashboard against your own database. No sales call required.',
    features: [
      'Everything in Beta, on your infrastructure',
      'Your database, your keys, your network',
      'No trace or prompt data leaves your estate',
      'Apache License 2.0, nothing gated — self-hosting guide in the README',
    ],
    cta: { label: 'View on GitHub', href: GITHUB_URL },
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    priceNote: "tell us what you're missing",
    blurb: 'Longer retention, a support agreement, procurement paperwork, or a capability that is not built yet — start a conversation.',
    features: [
      'Custom retention and data-handling terms',
      'Support agreement and named contact',
      'Security review and questionnaires',
      'Roadmap input on what you need next',
    ],
    cta: { label: 'Contact sales', href: `mailto:${SUPPORT_EMAIL}` },
  },
];

/** Straight answers to the questions the plan grid does not settle. */
const FAQ: { q: string; a: ReactNode }[] = [
  {
    q: 'What does it cost right now?',
    a: (
      <>
        Nothing. AcruxCore is in beta and the hosted platform is free to use, with no credit card at sign-up. You still
        pay your model providers directly for the tokens you spend.
      </>
    ),
  },
  {
    q: 'What happens when beta ends?',
    a: (
      <>
        Post-beta pricing has not been set. When it is, it will be published on this page, and existing accounts will get
        notice before anything about their plan changes.
      </>
    ),
  },
  {
    q: 'Do you mark up model tokens?',
    a: (
      <>
        No. You connect your own OpenAI, Anthropic, Gemini, or OpenAI-compatible credentials and the provider bills you
        directly at their rates. The gateway prices each call so you can <em>see</em> the cost — it does not add to it.
      </>
    ),
  },
  {
    q: 'Is my data locked in?',
    a: (
      <>
        No. Any prompt version can be exported as portable JSON and imported elsewhere, and traces are readable over the{' '}
        <a href={DOCS.apiReference} target="_blank" rel="noreferrer">
          API
        </a>
        . Deleting your account removes the associated data.
      </>
    ),
  },
  {
    q: 'Which parts do I have to adopt?',
    a: (
      <>
        Any one of them, on its own. The gateway is OpenAI-compatible, so you can route calls through it without ever
        storing a prompt with us — or store prompts and keep calling providers yourself.
      </>
    ),
  },
  {
    q: 'Can I self-host without talking to sales first?',
    a: (
      <>
        Yes. AcruxCore is open source under the{' '}
        <a href={GITHUB_URL} target="_blank" rel="noreferrer">
          Apache License 2.0
        </a>{' '}
        — clone the repo and follow the README to run the whole stack against your own database. Contact us only if you
        want help with the deployment or a support agreement on top of it.
      </>
    ),
  },
];

/**
 * Public pricing page. Linked from the nav and the footer Product column, both of
 * which previously pointed at the landing page's closing CTA rather than a real
 * page.
 *
 * @returns The rendered Pricing page.
 */
export function PricingPage(): ReactNode {
  useDocumentTitle('Pricing — AcruxCore');

  return (
    <MarketingShell wide>
      {/* ===== HERO ===== */}
      <header style={cssToStyle('padding:clamp(44px,7vw,80px) 0 clamp(32px,4vw,48px);text-align:center;')}>
        <Eyebrow>Pricing</Eyebrow>
        <h1
          style={cssToStyle(
            'font-size:clamp(30px,4.4vw,48px);line-height:1.05;letter-spacing:-.026em;font-weight:700;margin:0;text-wrap:balance;',
          )}
        >
          Free while we are in beta.
        </h1>
        <p
          style={cssToStyle(
            'font-size:clamp(16px,1.6vw,18px);line-height:1.62;color:var(--muted);margin:20px auto 0;max-width:56ch;text-wrap:pretty;',
          )}
        >
          Every part of the platform is open to every account today. You bring your own provider keys, so the model spend
          stays yours and we never take a cut of your tokens.
        </p>
      </header>

      {/* ===== PLANS ===== */}
      <section style={cssToStyle('padding:0 0 clamp(40px,6vw,72px);')}>
        <div style={cssToStyle('display:grid;grid-template-columns:repeat(auto-fit,minmax(min(290px,100%),1fr));gap:18px;align-items:start;')}>
          {PLANS.map((plan) => (
            <div
              key={plan.name}
              style={cssToStyle(
                `position:relative;border:1px solid ${
                  plan.featured ? 'var(--accent)' : 'var(--line)'
                };background:var(--surface);border-radius:14px;padding:${
                  plan.featured ? '30px 24px 26px' : '26px 24px'
                };display:flex;flex-direction:column;gap:16px;height:100%;`,
              )}
            >
              {plan.featured ? (
                <span
                  style={cssToStyle(
                    'position:absolute;top:-11px;left:24px;background:var(--accent);color:var(--accent-ink);font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:4px 10px;border-radius:999px;',
                  )}
                >
                  Most teams start here
                </span>
              ) : null}

              <div>
                <h2 style={cssToStyle('font-size:17px;font-weight:650;letter-spacing:-.01em;margin:0 0 12px;')}>
                  {plan.name}
                </h2>
                <p
                  style={cssToStyle(
                    'font-size:clamp(28px,3.4vw,36px);line-height:1.05;letter-spacing:-.025em;font-weight:700;margin:0;color:var(--ink);',
                  )}
                >
                  {plan.price}
                </p>
                <p style={cssToStyle('font-size:13px;color:var(--faint);margin:8px 0 0;')}>{plan.priceNote}</p>
              </div>

              <p style={cssToStyle('font-size:14.5px;line-height:1.6;color:var(--muted);margin:0;text-wrap:pretty;')}>
                {plan.blurb}
              </p>

              <ul
                style={cssToStyle(
                  'list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px;border-top:1px solid var(--line-soft);padding-top:16px;',
                )}
              >
                {plan.features.map((f) => (
                  <li key={f} style={cssToStyle('display:flex;gap:10px;align-items:flex-start;')}>
                    <svg
                      style={cssToStyle('flex:none;margin-top:3px;color:var(--accent);')}
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="m20 6-11 11-5-5" />
                    </svg>
                    <span style={cssToStyle('font-size:14px;line-height:1.5;color:var(--muted);')}>{f}</span>
                  </li>
                ))}
              </ul>

              <div style={cssToStyle('margin-top:auto;padding-top:8px;')}>
                {plan.cta.to ? (
                  <Link
                    to={plan.cta.to}
                    className={plan.featured ? 'acx-hover-bright' : 'acx-hover-border'}
                    style={cssToStyle((plan.featured ? btnPrimary() : btnSecondary()) + 'width:100%;')}
                  >
                    {plan.cta.label}
                  </Link>
                ) : (
                  <a
                    href={plan.cta.href}
                    className="acx-hover-border"
                    style={cssToStyle(btnSecondary() + 'width:100%;')}
                  >
                    {plan.cta.label}
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ===== WHAT YOU PAY FOR ===== */}
      <section style={cssToStyle('padding:clamp(40px,6vw,68px) 0;border-top:1px solid var(--line-soft);')}>
        <div
          style={cssToStyle(
            'border:1px solid var(--line);background:var(--surface);border-radius:14px;padding:clamp(26px,4vw,40px);display:grid;grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr));gap:clamp(24px,4vw,44px);align-items:center;',
          )}
        >
          <div>
            <Eyebrow>Bring your own keys</Eyebrow>
            <h2
              style={cssToStyle(
                'font-size:clamp(22px,2.8vw,30px);line-height:1.14;letter-spacing:-.02em;font-weight:700;margin:0 0 14px;text-wrap:balance;',
              )}
            >
              We never resell your tokens.
            </h2>
            <p style={cssToStyle('font-size:15.5px;line-height:1.62;color:var(--muted);margin:0;text-wrap:pretty;')}>
              Your provider credentials stay yours, encrypted at rest, and the provider bills you at their own rates. The
              gateway's job is to tell you what each call cost — in an{' '}
              <code style={cssToStyle('font-family:var(--mono);font-size:.9em;color:var(--ink);')}>x-gateway-*</code>{' '}
              header on the response and in every trace — not to sit in the middle of the invoice.
            </p>
          </div>
          <div style={cssToStyle('display:flex;flex-direction:column;gap:12px;')}>
            <a
              href={DOCS.quickstart}
              target="_blank"
              rel="noreferrer"
              className="acx-hover-border"
              style={cssToStyle(btnSecondary() + 'justify-content:space-between;')}
            >
              Read the quickstart
              <ExternalArrow />
            </a>
            <Link to="/features/gateway" className="acx-hover-border" style={cssToStyle(btnSecondary())}>
              How the gateway works
            </Link>
          </div>
        </div>
      </section>

      {/* ===== FAQ ===== */}
      <section style={cssToStyle('padding:clamp(40px,6vw,68px) 0 clamp(20px,3vw,32px);border-top:1px solid var(--line-soft);')}>
        <div style={cssToStyle('max-width:640px;margin-bottom:clamp(26px,4vw,38px);')}>
          <Eyebrow>Questions</Eyebrow>
          <h2
            style={cssToStyle(
              'font-size:clamp(24px,3.2vw,34px);line-height:1.12;letter-spacing:-.02em;font-weight:700;margin:0;text-wrap:balance;',
            )}
          >
            The things a price grid does not answer.
          </h2>
        </div>
        <div className="acx-prose" style={cssToStyle('max-width:760px;')}>
          {FAQ.map((item) => (
            <div key={item.q} style={cssToStyle('padding:18px 0;border-bottom:1px solid var(--line-soft);')}>
              <h3 style={cssToStyle('font-size:16px;font-weight:650;letter-spacing:-.01em;margin:0 0 8px;')}>
                {item.q}
              </h3>
              <p style={cssToStyle('margin:0;')}>{item.a}</p>
            </div>
          ))}
        </div>
      </section>

      <CtaSection
        title="Start free. Decide about pricing later."
        body="No credit card, no sales call, no commitment. Sign up, connect a provider key, and route your first call today."
      />
    </MarketingShell>
  );
}
