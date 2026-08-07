import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { MarketingShell, ContentHeader } from '../MarketingShell';
import { SUPPORT_EMAIL } from '../marketing-chrome';

/**
 * Public "Terms of Service" page. Linked from the footer Company column and the
 * legal bottom bar.
 *
 * This is a general terms document for the AcruxCore platform; it should be
 * reviewed by counsel before being relied on for a specific jurisdiction.
 *
 * @returns The rendered Terms of Service page.
 */
export function TermsPage(): ReactNode {
  return (
    <MarketingShell>
      <ContentHeader
        eyebrow="Legal"
        title="Terms of Service"
        lead="These terms govern your access to and use of the AcruxCore platform. By creating an account or using the service, you agree to them."
        updated="July 26, 2026"
      />
      <div className="acx-prose">
        <h2>1. Agreement</h2>
        <p>
          These Terms of Service (“Terms”) are a legal agreement between you (and the team or
          organization you represent) and AcruxCore (“AcruxCore”, “we”, “us”). By accessing or using the
          hosted platform, SDKs, APIs, or website (together, the “Service”), you agree to these Terms.
          If you do not agree, do not use the Service.
        </p>

        <h2>2. Accounts</h2>
        <ul>
          <li>You must provide accurate information and keep your account credentials secure.</li>
          <li>You are responsible for all activity under your account and API keys.</li>
          <li>You must be able to form a binding contract to use the Service.</li>
          <li>Creating an account requires your name and agreement to these Terms and our Privacy Policy; you may optionally opt into product-update emails.</li>
        </ul>

        <h2>3. Your content and keys</h2>
        <p>
          You retain all rights to the prompts, tools, data, and provider credentials you bring to
          the Service (“Your Content”). You grant us the limited rights needed to host, process, and
          route Your Content in order to operate the Service on your behalf. You are responsible for
          ensuring you have the rights to use Your Content and any third-party model providers you
          connect, and for complying with those providers' terms.
        </p>

        <h2>4. Acceptable use</h2>
        <p>You agree not to:</p>
        <ul>
          <li>Break the law or infringe others' rights using the Service.</li>
          <li>Attempt to access another team's data or circumvent access controls.</li>
          <li>Disrupt, overload, or reverse-engineer the Service except as permitted by law.</li>
          <li>Resell or provide the Service to third parties except as expressly allowed.</li>
        </ul>

        <h2>5. Model providers and third parties</h2>
        <p>
          The Service routes calls to model providers using the keys you connect. We are not
          responsible for the availability, output, pricing, or terms of those third-party providers.
          Charges you incur directly with a provider are between you and that provider.
        </p>

        <h2>6. Plans, fees, and changes</h2>
        <p>
          Paid plans, if any, are billed as described at sign-up or in an order. We may change
          features or pricing with reasonable notice. Fees are non-refundable except where required
          by law.
        </p>

        <h2>7. Availability</h2>
        <p>
          We work to keep the Service available and reliable but do not guarantee uninterrupted
          operation. We may modify, suspend, or discontinue parts of the Service, and will give
          reasonable notice of material changes where practical.
        </p>

        <h2>8. Termination</h2>
        <p>
          You may stop using the Service and delete your account at any time. We may suspend or
          terminate access if you materially breach these Terms or use the Service in a way that
          risks harm to others or to the Service. On termination, your right to use the Service ends
          and we will handle your data as described in the <Link to="/privacy">Privacy Policy</Link>.
        </p>

        <h2>9. Disclaimer of warranties</h2>
        <p>
          The Service is provided “as is” and “as available.” To the fullest extent permitted by
          law, we disclaim all warranties, express or implied, including merchantability, fitness
          for a particular purpose, and non-infringement. We do not warrant that the Service will
          be uninterrupted, error-free, or completely secure.
        </p>

        <h2>10. Your data and backups</h2>
        <p>
          You are responsible for maintaining your own copies of Your Content. You can retrieve
          Your Content at any time using the API, SDK, or applicable export features. While we take
          reasonable steps to protect and back up data, we do not guarantee against loss, and you
          should not rely on the Service as your only copy of anything important.
        </p>

        <h2>11. Limitation of liability</h2>
        <p>
          To the fullest extent permitted by law: (a) neither party will be liable to the other for
          indirect, incidental, special, consequential, or punitive damages, or for lost profits or
          lost data; and (b) our total liability arising out of or relating to the Service will not
          exceed the greater of (i) the amount you paid us in the twelve months before the claim, or
          (ii) one hundred US dollars ($100). These limits apply even if a remedy fails its
          essential purpose.
        </p>

        <h2>12. Indemnification</h2>
        <p>
          You agree to defend and indemnify us against claims, damages, and expenses (including
          reasonable legal fees) arising from your use of the Service, Your Content, or your
          violation of these Terms or of any law or third-party right.
        </p>

        <h2>13. Governing law</h2>
        <p>
          These Terms are governed by the laws of the jurisdiction in which AcruxCore is based,
          without regard to conflict-of-laws rules. Disputes will be resolved in the courts of
          that jurisdiction, unless applicable law requires otherwise. To ask which jurisdiction
          that is, contact us at{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
        </p>

        <h2>14. Changes to these Terms</h2>
        <p>
          We may update these Terms from time to time. Material changes will be posted here with an
          updated date; continued use of the Service after changes take effect means you accept the
          revised Terms.
        </p>

        <h2>15. Contact</h2>
        <p>
          Questions about these Terms? Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> or visit our{' '}
          <Link to="/contact">contact page</Link>.
        </p>
      </div>
    </MarketingShell>
  );
}
