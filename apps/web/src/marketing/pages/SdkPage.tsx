import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { MarketingShell } from '../MarketingShell';
import {
  cssToStyle,
  Ic,
  Eyebrow,
  CodeCard,
  CtaSection,
  btnPrimary,
  btnSecondary,
  ExternalArrow,
  useDocumentTitle,
  DOCS,
  API_BASE_URL,
} from '../marketing-chrome';

// ── syntax-highlight helpers (see features.tsx for the rationale) ───────────
const kw = (s: string): string => `<span style="color:var(--varhi);">${s}</span>`;
const st = (s: string): string => `<span style="color:var(--str);">${s}</span>`;
const fn = (s: string): string => `<span style="color:var(--accent);">${s}</span>`;
const cm = (s: string): string => `<span style="color:var(--faint);">${s}</span>`;

// Every line stays under ~46 characters so the panels do not open with content
// already clipped behind a horizontal scrollbar.
const INSTALL_CODE = `${cm('# TypeScript / Node 18+')}
npm i @acruxcoreai/sdk

${cm('# Python 3.9+, async')}
pip install acruxcore

${cm('# hosted API base URL:')}
${cm('#   ' + API_BASE_URL)}
export ACRUXCORE_API_KEY=ak_…`;

const TS_CODE = `${kw('import')} acruxcore, { acrux } ${kw('from')} ${st("'@acruxcoreai/sdk'")};
${kw('import')} { z } ${kw('from')} ${st("'zod/v4'")};

${kw('const')} hub = ${kw('new')} ${fn('acruxcore')}({ apiKey });

${cm('// a tool, registered with a decorator-style call')}
${kw('const')} lookupOrder = acrux.${fn('tool')}(
  { name: ${st("'lookup_order'")}, parameters: z.object({
    orderId: z.string(),
  }) },
  ${kw('async')} ({ orderId }) => ({ orderId, status: ${st("'shipped'")} }),
);

${cm('// prompt + its tools, served from cache')}
${kw('const')} render = ${kw('await')} hub.prompts.${fn('render')}(
  ${st("'support-agent'")}, ${st("'production'")}, { ticket },
);

${cm('// the whole tool loop, one trace + session')}
${kw('const')} result = ${kw('await')} hub.gateway.${fn('runToolLoop')}({
  model: ${st("'gpt-4o'")},
  messages: render.messages,
  tools: [lookupOrder],
  trace: { sessionId: ${st("'ticket-4471'")} },
});

${kw('await')} hub.traces.${fn('submitFeedback')}({
  traceId: result.traceId, rating: 1,
});`;

const PY_CODE = `${kw('from')} acruxcore ${kw('import')} ${fn('AcruxCore')}, acrux

hub = ${fn('AcruxCore')}(api_key=api_key)

${cm('# a tool, registered with a decorator')}
@acrux.${fn('tool')}
${kw('async def')} lookup_order(order_id: str) -> dict:
    ${cm('"""Look up an order’s shipping status."""')}
    ${kw('return')} {${st('"order_id"')}: order_id, ${st('"status"')}: ${st('"shipped"')}}

${cm('# prompt + its tools, served from cache')}
render = ${kw('await')} hub.prompts.${fn('render')}(
    ${st('"support-agent"')}, ${st('"production"')},
    {${st('"ticket"')}: ticket},
)

${cm('# the whole tool loop, one trace + session')}
result = ${kw('await')} hub.gateway.${fn('run_tool_loop')}(
    model=${st('"gpt-4o"')},
    messages=render.messages,
    tools=[lookup_order],
    trace={${st('"session_id"')}: ${st('"ticket-4471"')}},
)

${kw('await')} hub.traces.${fn('submit_feedback')}(
    trace_id=result.trace_id, rating=1,
)`;

/**
 * The five things every caller needs from the client, in order: fetch a stored
 * prompt, call a model, give it a tool, group + trace the calls, then leave
 * feedback. Every guide below carries both a Node and a Python tab, so the same
 * five links serve both language sections rather than forking into two lists
 * that would drift out of sync.
 */
const SDK_TUTORIALS: { label: string; href: string }[] = [
  { label: 'Register and fetch a prompt', href: `${DOCS.versionPrompt}#5-render-it-from-your-app` },
  { label: 'Call the gateway with chat()', href: `${DOCS.tsSdk}#1-a-plain-completion-with-chat` },
  { label: 'Register a tool with a decorator', href: DOCS.attachTool },
  { label: 'Group calls into sessions and traces', href: DOCS.sessionsTraces },
  {
    label: 'Leave feedback on a trace',
    href: `${DOCS.tsSdk}#4-read-the-trace-back-and-leave-feedback`,
  },
];

/** One method-level capability of the client, named after the real method. */
interface SdkCapability {
  ts: string;
  py: string;
  title: string;
  body: string;
}

/**
 * The client surface, method by method.
 *
 * Both SDKs ship the same set — the Python client is a full async port of the
 * TypeScript one — so the page documents the capability once and shows the two
 * names side by side rather than pretending they are different products.
 */
const CAPABILITIES: SdkCapability[] = [
  {
    ts: 'prompts.render()',
    py: 'prompts.render()',
    title: 'Resolve a prompt by name and alias',
    body: 'Returns the templated messages plus the version\'s attached tools. Cached locally per prompt and alias: a fresh entry answers with no network call, a stale one answers immediately and refreshes in the background, so promoting a new version never adds latency to the call that noticed.',
  },
  {
    ts: 'gateway.chat()',
    py: 'gateway.chat()',
    title: 'Call any model through the gateway',
    body: 'One OpenAI-compatible completion. Pass stream for token-by-token output, and read the gateway metadata — provider, priced cost, cache status — off the same result.',
  },
  {
    ts: 'gateway.runToolLoop()',
    py: 'gateway.run_tool_loop()',
    title: 'Run the whole function-calling loop',
    body: 'Hand it messages, tools, and a dispatch map. It runs the turns, dispatches tool calls concurrently, and threads a single trace id through all of them — so a five-turn agent is one trace, not five orphans.',
  },
  {
    ts: 'traces.ingest()',
    py: 'traces.ingest()',
    title: 'Record a step the gateway never saw',
    body: 'Report a span yourself for work that happens outside a model call — a retrieval step, a database read, a validation pass — and it joins the same trace tree.',
  },
  {
    ts: 'traces.submitFeedback()',
    py: 'traces.submit_feedback()',
    title: 'Attach feedback in code',
    body: 'Send a rating, label, or comment against a trace or one span, then update it later. This is the raw material an evaluation dataset is built from.',
  },
  {
    ts: 'traces.get() · traces.list()',
    py: 'traces.get() · traces.list()',
    title: 'Read traces back',
    body: 'Fetch one trace with its spans, tokens, latency, and cost, or list traces with filters — useful for assertions in your own test suite.',
  },
];

/** A per-language block: install line, requirements, sample, and real tutorials. */
interface LanguageSection {
  id: string;
  name: string;
  install: string;
  requires: string;
  packageLabel: string;
  code: { filename: string; lang: string; html: string };
  tutorials: { label: string; href: string }[];
  /** This language's full API reference, linked once the task links run out. */
  reference: string;
}

const LANGUAGES: LanguageSection[] = [
  {
    id: 'typescript',
    name: 'TypeScript',
    install: 'npm i @acruxcoreai/sdk',
    requires: 'Node 18 or newer · ships its own types',
    packageLabel: '@acruxcoreai/sdk',
    code: { filename: 'agent.ts', lang: 'TypeScript', html: TS_CODE },
    tutorials: SDK_TUTORIALS,
    reference: DOCS.nodeSdkReference,
  },
  {
    id: 'python',
    name: 'Python',
    install: 'pip install acruxcore',
    requires: 'Python 3.9 or newer · async, built on httpx',
    packageLabel: 'acruxcore',
    code: { filename: 'agent.py', lang: 'Python', html: PY_CODE },
    tutorials: SDK_TUTORIALS,
    reference: DOCS.pythonSdkReference,
  },
];

/**
 * Public "SDKs" page at `/sdk`, with `#typescript` and `#python` sections.
 *
 * The footer's per-language entries used to jump straight into a tutorial, which
 * answered "how do I do this one thing?" but never "what does the client actually
 * give me?". This page answers the second question first, then hands off to the
 * tutorials that match each language.
 *
 * @returns The rendered SDK page.
 */
export function SdkPage(): ReactNode {
  useDocumentTitle('TypeScript & Python SDKs — AcruxCore');

  return (
    <MarketingShell wide>
      {/* ===== HERO ===== */}
      <section
        style={cssToStyle(
          'padding:clamp(44px,7vw,84px) 0 clamp(40px,6vw,68px);display:grid;grid-template-columns:repeat(auto-fit,minmax(min(330px,100%),1fr));gap:clamp(32px,5vw,56px);align-items:center;',
        )}
      >
        <div>
          <Eyebrow>TypeScript &amp; Python SDKs</Eyebrow>
          <h1
            style={cssToStyle(
              'font-size:clamp(30px,4.4vw,48px);line-height:1.05;letter-spacing:-.026em;font-weight:700;margin:0 0 20px;text-wrap:balance;',
            )}
          >
            One client for prompts, the gateway, and tracing.
          </h1>
          <p
            style={cssToStyle(
              'font-size:clamp(16px,1.6vw,18px);line-height:1.62;color:var(--muted);margin:0 0 30px;max-width:48ch;text-wrap:pretty;',
            )}
          >
            Install one package and you get cached prompt rendering, an OpenAI-compatible chat call, tool loops that stay
            in a single trace, and feedback — with the same surface in both languages.
          </p>
          <div style={cssToStyle('display:flex;flex-wrap:wrap;gap:12px;')}>
            <Link to="/signup" className="acx-hover-bright" style={cssToStyle(btnPrimary())}>
              Get an API key
            </Link>
            <a
              href={DOCS.quickstart}
              target="_blank"
              rel="noreferrer"
              className="acx-hover-border"
              style={cssToStyle(btnSecondary())}
            >
              Quickstart
              <ExternalArrow />
            </a>
          </div>
        </div>
        <CodeCard filename="install.sh" lang="shell" html={INSTALL_CODE} />
      </section>

      {/* ===== WHAT THE CLIENT DOES ===== */}
      <section style={cssToStyle('padding:clamp(40px,6vw,72px) 0;border-top:1px solid var(--line-soft);')}>
        <div style={cssToStyle('max-width:660px;margin-bottom:clamp(28px,4vw,42px);')}>
          <Eyebrow>The surface</Eyebrow>
          <h2
            style={cssToStyle(
              'font-size:clamp(24px,3.2vw,34px);line-height:1.12;letter-spacing:-.02em;font-weight:700;margin:0;text-wrap:balance;',
            )}
          >
            Six methods cover the whole platform.
          </h2>
          <p style={cssToStyle('font-size:16px;line-height:1.6;color:var(--muted);margin:14px 0 0;text-wrap:pretty;')}>
            The Python client is a full async port of the TypeScript one, so every capability below exists in both —
            only the naming convention changes.
          </p>
        </div>
        <div style={cssToStyle('display:grid;grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr));gap:16px;')}>
          {CAPABILITIES.map((c) => (
            <div
              key={c.title}
              className="acx-hover-border"
              style={cssToStyle(
                'border:1px solid var(--line);background:var(--surface);border-radius:12px;padding:22px 20px;display:flex;flex-direction:column;gap:12px;transition:border-color .16s;',
              )}
            >
              <div style={cssToStyle('display:flex;flex-wrap:wrap;gap:8px;')}>
                <code
                  style={cssToStyle(
                    'font-family:var(--mono);font-size:12px;color:var(--accent);background:var(--elevated);border:1px solid var(--line-soft);border-radius:6px;padding:3px 8px;',
                  )}
                >
                  {c.ts}
                </code>
                {c.py !== c.ts ? (
                  <code
                    style={cssToStyle(
                      'font-family:var(--mono);font-size:12px;color:var(--muted);background:var(--elevated);border:1px solid var(--line-soft);border-radius:6px;padding:3px 8px;',
                    )}
                  >
                    {c.py}
                  </code>
                ) : null}
              </div>
              <h3 style={cssToStyle('font-size:16px;font-weight:650;letter-spacing:-.01em;margin:0;')}>{c.title}</h3>
              <p style={cssToStyle('font-size:14.5px;line-height:1.62;color:var(--muted);margin:0;text-wrap:pretty;')}>
                {c.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ===== PER-LANGUAGE ===== */}
      {LANGUAGES.map((lang) => (
        <section
          key={lang.id}
          id={lang.id}
          style={cssToStyle('padding:clamp(40px,6vw,72px) 0;border-top:1px solid var(--line-soft);scroll-margin-top:80px;')}
        >
          <div
            style={cssToStyle(
              'display:grid;grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr));gap:clamp(28px,4vw,48px);align-items:start;',
            )}
          >
            <div>
              <Eyebrow>{lang.name}</Eyebrow>
              <h2
                style={cssToStyle(
                  'font-size:clamp(22px,2.8vw,30px);line-height:1.14;letter-spacing:-.02em;font-weight:700;margin:0 0 16px;',
                )}
              >
                {lang.name} SDK
              </h2>
              <div
                style={cssToStyle(
                  'font-family:var(--mono);font-size:13px;color:var(--accent);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:11px 14px;margin-bottom:12px;overflow-x:auto;white-space:pre;',
                )}
              >
                {lang.install}
              </div>
              <p style={cssToStyle('font-size:13.5px;color:var(--faint);margin:0 0 24px;')}>{lang.requires}</p>

              <p
                style={cssToStyle(
                  'font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);font-weight:600;margin:0 0 14px;',
                )}
              >
                Tutorials
              </p>
              <ul style={cssToStyle('list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:9px;')}>
                {lang.tutorials.map((t) => (
                  <li key={t.href}>
                    <a
                      href={t.href}
                      target="_blank"
                      rel="noreferrer"
                      className="acx-hover-border"
                      style={cssToStyle(
                        'border:1px solid var(--line);background:var(--surface);border-radius:9px;padding:12px 15px;display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:14px;font-weight:550;color:var(--ink);transition:border-color .16s;',
                      )}
                    >
                      {t.label}
                      <span style={cssToStyle('color:var(--accent);flex:none;display:inline-flex;')}>
                        <ExternalArrow />
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
              <a
                href={lang.reference}
                target="_blank"
                rel="noreferrer"
                style={cssToStyle(
                  'display:inline-flex;align-items:center;gap:6px;margin-top:14px;font-size:13.5px;font-weight:550;color:var(--accent);text-decoration:none;',
                )}
              >
                Full {lang.name} API reference
                <ExternalArrow />
              </a>
            </div>
            <CodeCard filename={lang.code.filename} lang={lang.code.lang} html={lang.code.html} />
          </div>
        </section>
      ))}

      {/* ===== REST FALLBACK ===== */}
      <section style={cssToStyle('padding:clamp(40px,6vw,64px) 0 clamp(20px,3vw,32px);border-top:1px solid var(--line-soft);')}>
        <div
          style={cssToStyle(
            'border:1px solid var(--line);background:var(--surface);border-radius:14px;padding:clamp(26px,4vw,38px);display:grid;grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr));gap:clamp(24px,4vw,40px);align-items:center;',
          )}
        >
          <div>
            <Eyebrow>No SDK? No problem</Eyebrow>
            <h2
              style={cssToStyle(
                'font-size:clamp(20px,2.6vw,27px);line-height:1.14;letter-spacing:-.02em;font-weight:700;margin:0 0 12px;text-wrap:balance;',
              )}
            >
              Everything is plain REST underneath.
            </h2>
            <p style={cssToStyle('font-size:15px;line-height:1.62;color:var(--muted);margin:0;text-wrap:pretty;')}>
              The SDKs are conveniences, not gatekeepers. Every capability on this page is an HTTP endpoint you can call
              from any language — and the gateway speaks the OpenAI wire format, so most existing clients already work.
            </p>
          </div>
          <div style={cssToStyle('display:flex;flex-direction:column;gap:12px;')}>
            <a
              href={DOCS.apiReference}
              target="_blank"
              rel="noreferrer"
              className="acx-hover-border"
              style={cssToStyle(btnSecondary() + 'justify-content:space-between;')}
            >
              Full API reference
              <ExternalArrow />
            </a>
            <Link to="/features/gateway" className="acx-hover-border" style={cssToStyle(btnSecondary())}>
              <span style={cssToStyle('display:inline-flex;align-items:center;gap:8px;')}>
                How the gateway works
                <Ic size={14} sw={2.2}>
                  <path d="m9 6 6 6-6 6" />
                </Ic>
              </span>
            </Link>
          </div>
        </div>
      </section>

      <CtaSection
        title="Get a key and install it."
        body="Free while AcruxCore is in beta. Bring your own provider keys and the first render is a few lines away."
      />
    </MarketingShell>
  );
}
