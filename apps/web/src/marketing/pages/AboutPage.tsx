import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { MarketingShell, ContentHeader } from '../MarketingShell';
import { cssToStyle, DOCS_URL, GITHUB_URL } from '../marketing-chrome';

/**
 * Public "About" marketing page describing what Acrux Core is and the principles
 * behind it. Linked from the footer Company column.
 *
 * @returns The rendered About page.
 */
export function AboutPage(): ReactNode {
  return (
    <MarketingShell>
      <ContentHeader
        eyebrow="About"
        docTitle="About — Acrux Core"
        title="One control plane for the whole LLM stack."
        lead="Acrux Core is an LLM-ops platform for engineering teams — prompt versioning, an OpenAI-compatible gateway, tracing, a tool catalog, and evaluation, wired together so a fix flows from a bad answer back to a live prompt without a redeploy."
      />
      <div className="acx-prose">
        <h2>Why we built it</h2>
        <p>
          Shipping an LLM feature is easy. Keeping it good is not. Prompts live in code and need a
          deploy to change. Calls fan out to different providers with no shared record of cost or
          latency. When an answer is wrong, there is no straight line from the bad output back to the
          prompt that produced it. Teams end up stitching four or five tools together and still fly
          half-blind.
        </p>
        <p>
          Acrux Core closes that loop. Land on a session, open its trace, rate the span that missed,
          and jump to the exact prompt version behind it — edit, save, move the production alias, and
          the next run picks up the change. No redeploy, no context-switch.
        </p>

        <h2>What we believe</h2>
        <ul>
          <li>
            <strong>Change without a deploy.</strong> Prompts and tools are versioned data, not code.
            Moving a production alias should take seconds, not a release.
          </li>
          <li>
            <strong>Your keys, your data.</strong> Bring your own provider keys, or self-host the
            whole platform. We sit in front of the models; we never take them over.
          </li>
          <li>
            <strong>Drop-in, not rip-and-replace.</strong> The gateway is OpenAI-compatible and each
            part works on its own, so you adopt what you need and keep the rest.
          </li>
          <li>
            <strong>Everything is measurable.</strong> Every call is a trace with spans for model,
            tokens, latency, and cost — no extra instrumentation to bolt on.
          </li>
          <li>
            <strong>Open, by default.</strong> The platform is open source under the{' '}
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">
              Elastic License 2.0
            </a>{' '}
            — read the code, self-host it, or send a pull request.
          </li>
        </ul>

        <h2>Built for developers</h2>
        <p>
          Acrux Core ships first-class SDKs for both{' '}
          <Link to="/sdk#typescript">TypeScript</Link> and <Link to="/sdk#python">Python</Link>, plus a plain REST API
          for everything else. Read the{' '}
          <a href={DOCS_URL} target="_blank" rel="noreferrer">
            documentation
          </a>{' '}
          or browse the{' '}
          <a href={GITHUB_URL} target="_blank" rel="noreferrer">
            source on GitHub
          </a>{' '}
          to see how it fits your stack.
        </p>

        <div style={cssToStyle('display:flex;flex-wrap:wrap;gap:12px;margin:36px 0 8px;')}>
          <Link
            to="/signup"
            className="acx-hover-bright"
            style={cssToStyle(
              'display:inline-flex;align-items:center;justify-content:center;height:44px;padding:0 22px;border-radius:8px;background:var(--accent);color:var(--accent-ink);font-size:15px;font-weight:650;border:1px solid var(--accent);transition:filter .15s;',
            )}
          >
            Start free
          </Link>
          <Link
            to="/contact"
            className="acx-hover-border"
            style={cssToStyle(
              'display:inline-flex;align-items:center;justify-content:center;height:44px;padding:0 20px;border-radius:8px;background:var(--surface);color:var(--ink);font-size:15px;font-weight:550;border:1px solid var(--line);transition:border-color .15s;',
            )}
          >
            Talk to us
          </Link>
        </div>
      </div>
    </MarketingShell>
  );
}
