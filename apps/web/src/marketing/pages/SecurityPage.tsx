import { type ReactNode } from 'react';
import { MarketingShell, ContentHeader } from '../MarketingShell';
import { SUPPORT_EMAIL, DOCS } from '../marketing-chrome';

/**
 * Public "Security" page describing how AcruxCore protects team data and how to
 * report a vulnerability. Linked from the footer Company column.
 *
 * @returns The rendered Security page.
 */
export function SecurityPage(): ReactNode {
  return (
    <MarketingShell>
      <ContentHeader
        eyebrow="Security"
        docTitle="Security — AcruxCore"
        title="Security at AcruxCore."
        lead="AcruxCore sits between your application and every model provider, so protecting your keys, prompts, and trace data is the core of the product — not an add-on."
        updated="September 10, 2026"
      />
      <div className="acx-prose">
        <h2>Data isolation</h2>
        <p>
          Every record in AcruxCore is scoped to a <strong>team</strong>. The platform enforces this
          on a shared database with row-level access controls, so one team can never read or write
          another team's prompts, keys, traces, or evaluations. API requests are authenticated per
          team and authorized on every call.
        </p>

        <h2>Roles and access</h2>
        <p>
          Every member of a team holds exactly one role — <strong>owner</strong>,{' '}
          <strong>admin</strong>, <strong>editor</strong> or <strong>viewer</strong> — and the API
          authorizes each route against that role, rather than relying on the dashboard to hide a
          button. Reads that cover the whole team, the audit trail included, are limited to owners
          and admins.
        </p>

        <h2>The audit trail</h2>
        <p>
          Every write the platform performs is recorded with the person behind it: prompts, versions
          and aliases, tools and their bindings, members and invites, API keys, gateway credentials,
          virtual keys, budgets, secrets, and the team's own trace settings. An owner or admin can
          read the whole team's trail and filter it by area, by a single event, or by the person who
          did it — including someone who has since left the team, since their events stay in the
          record. Secrets appear by name only; a secret's value is never written to the trail.
        </p>
        <p>
          Reading the team-wide trail needs a signed-in session, not an API key: a record of what
          people did should not be readable by a program holding a key. Two things it does not do
          yet — there is no CSV or JSON export, and no retention window to configure, so every event
          is kept. See{' '}
          <a href={DOCS.auditTrail} target="_blank" rel="noreferrer">
            Read the team audit trail
          </a>{' '}
          for what each area records.
        </p>

        <h2>Your provider keys</h2>
        <p>
          You bring your own model-provider keys. Provider credentials and other secrets are
          encrypted at rest and are never returned in full through the API or the dashboard once
          saved. The gateway uses them server-side to route your calls and never exposes them to the
          browser.
        </p>

        <h2>Encryption</h2>
        <ul>
          <li>
            <strong>In transit:</strong> all traffic to the API, gateway, and dashboard is served
            over TLS.
          </li>
          <li>
            <strong>At rest:</strong> secrets and provider credentials are encrypted before they are
            stored.
          </li>
        </ul>

        <h2>Payload capture is under your control</h2>
        <p>
          Traces record model, tokens, latency, and cost by default. Capturing full request and
          response <em>payloads</em> is a per-team setting you own — turn it off entirely, or scope it
          per call — so sensitive prompt and completion content is only stored when you choose.
        </p>

        <h2>Self-hosting</h2>
        <p>
          When data residency or isolation requirements go beyond the hosted platform, you can run
          the entire stack yourself — the API, gateway, and dashboard — against your own database and
          your own provider keys. Nothing leaves your infrastructure.
        </p>

        <h2>Reporting a vulnerability</h2>
        <p>
          We welcome responsible disclosure. If you believe you have found a security issue, email{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> with steps to reproduce
          and any relevant details. Please give us a reasonable window to investigate and remediate
          before any public disclosure, and avoid accessing or modifying data that is not your own
          while testing. That is our single public inbox — security reports are triaged ahead of
          everything else that arrives there.
        </p>
        <p>
          We will acknowledge your report, keep you updated on our progress, and credit you once the
          issue is resolved if you would like.
        </p>
      </div>
    </MarketingShell>
  );
}
