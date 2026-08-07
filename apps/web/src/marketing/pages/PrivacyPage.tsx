import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { MarketingShell, ContentHeader } from '../MarketingShell';
import { SUPPORT_EMAIL } from '../marketing-chrome';

/**
 * Public "Privacy Policy" page. Linked from the footer Company column and the
 * legal bottom bar.
 *
 * This is a general privacy policy for the AcruxCore platform; it should be
 * reviewed by counsel before being relied on for a specific jurisdiction.
 *
 * @returns The rendered Privacy Policy page.
 */
export function PrivacyPage(): ReactNode {
  return (
    <MarketingShell>
      <ContentHeader
        eyebrow="Legal"
        title="Privacy Policy"
        lead="This policy explains what information AcruxCore collects, how we use it, and the choices you have. It applies to the AcruxCore hosted platform and website."
        updated="August 1, 2026"
      />
      <div className="acx-prose">
        <h2>1. Who we are</h2>
        <p>
          AcruxCore (“AcruxCore”, “we”, “us”) provides an LLM-ops platform that lets teams
          version prompts, route model calls through a gateway, trace requests, and evaluate quality.
          This policy covers information handled when you use the hosted service at acruxcore.com and
          related sites. If you self-host AcruxCore, you are the controller of the data in your own
          deployment and this policy does not apply to it.
        </p>
        <p>
          For the hosted service, AcruxCore is the controller of the personal data described below.
          You can reach us about anything in this policy — including a data-protection request — at{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
        </p>

        <h2>2. Information we collect</h2>
        <ul>
          <li>
            <strong>Account information</strong> — your name, email address, team details, and
            authentication data when you sign up.
          </li>
          <li>
            <strong>Content you send to the platform</strong> — prompts, tool definitions, API keys
            you create, and provider credentials you connect. Provider credentials and secrets are
            encrypted at rest.
          </li>
          <li>
            <strong>Operational data</strong> — trace metadata such as model, token counts, latency,
            and cost for calls routed through the gateway. Full request and response payloads are
            stored only when your team enables payload capture.
          </li>
          <li>
            <strong>Usage and device data</strong> — log data, IP address, and basic analytics needed
            to operate and secure the service.
          </li>
        </ul>

        <h2>3. Cookies and analytics</h2>
        <p>
          We use Google Analytics 4 to understand traffic to our website and dashboard — pages visited,
          referral source, and basic device/location data. This sets an analytics cookie in your
          browser, but only after you accept it in the cookie banner shown on first visit; declining, or
          taking no action, keeps that cookie switched off. You can change your choice at any time from
          the "Cookie preferences" link in the site footer. This consent is shared across acruxcore.com
          and docs.acruxcore.com, so you are not asked twice. We do not use cookies for advertising.
        </p>

        <h2>4. How we use information</h2>
        <ul>
          <li>To provide, maintain, and improve the platform.</li>
          <li>To authenticate users and enforce team-level access.</li>
          <li>To route, price, and record the model calls you send through the gateway.</li>
          <li>To monitor for abuse, secure the service, and meet legal obligations.</li>
          <li>To communicate with you about your account and service changes.</li>
        </ul>

        <h2>5. Model providers</h2>
        <p>
          When you route a call through the gateway, the content of that call is sent to the model
          provider you selected, using the keys you connected, so the provider can generate a
          response. That processing is governed by the provider's own terms and privacy policy. We do
          not use your prompts or completions to train models.
        </p>

        <h2>6. Sharing</h2>
        <p>
          We do not sell your personal information. We share it only with service providers who help
          us run the platform (for example, hosting and infrastructure), under confidentiality
          obligations; when required by law; or as part of a business transfer, in which case we will
          notify you. Model providers receive only the calls you choose to route to them.
        </p>

        <h2>7. Retention</h2>
        <p>
          We keep account and content data for as long as your account is active and as needed to
          provide the service. Trace and operational data are retained according to your team's
          settings and our standard retention windows. You can delete resources you created at any
          time; deleting your account removes associated data, subject to backups and legal
          requirements.
        </p>

        <h2>8. Security</h2>
        <p>
          We protect data in transit with TLS and encrypt secrets and provider credentials at rest,
          with team-level isolation across the platform. See our <Link to="/security">security page</Link>{' '}
          for more detail and how to report a vulnerability.
        </p>

        <h2>9. Your rights</h2>
        <p>
          Depending on where you live, you may have the right to access, correct, export, or delete
          your personal information, and to object to or restrict certain processing. To exercise
          these rights, contact us at <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
        </p>

        <h2>10. Changes</h2>
        <p>
          We may update this policy from time to time. Material changes will be posted here with an
          updated date, and where required we will notify you directly.
        </p>

        <h2>11. Contact</h2>
        <p>
          Questions about privacy? Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> or visit our{' '}
          <Link to="/contact">contact page</Link>.
        </p>
      </div>
    </MarketingShell>
  );
}
