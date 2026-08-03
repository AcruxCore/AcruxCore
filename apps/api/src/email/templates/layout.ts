/** Characters that must never reach an HTML body unescaped. */
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escapes a value for interpolation into an HTML email body.
 *
 * Team names and display names are user-supplied — a team called
 * `<script>alert(1)</script>` must render as text, not run in whatever client
 * previews the mail.
 *
 * @param value - Untrusted string.
 * @returns The value with HTML-significant characters replaced by entities.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/**
 * Collapses a value to a single line for use in a header (subject).
 *
 * A CR or LF in a header is the classic header-injection vector; SES's
 * structured API makes it unlikely to matter, but stripping is free.
 *
 * @param value - Untrusted string.
 * @returns The value with all whitespace runs collapsed to single spaces.
 */
export function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Formats an expiry timestamp for display.
 *
 * Deliberately a fixed `YYYY-MM-DD HH:MM UTC` rendering rather than
 * locale-aware formatting: there is no timezone or locale on a user, and a
 * fixed format is assertable in a unit test on any machine.
 *
 * @param iso - ISO 8601 timestamp.
 * @returns e.g. `2026-08-01 09:30 UTC`.
 * @throws {RangeError} When `iso` is not a parseable date.
 */
export function formatExpiry(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new RangeError(`Unparseable expiry: ${iso}`);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

/**
 * Formats a USD amount for an email body.
 *
 * Always two decimal places, so `$5` and `$5.00` never appear in the same
 * message, and always `en-US` grouping rather than the server's locale — a
 * container that happens to run under a comma-decimal locale must not turn
 * `$1,234.50` into `$1.234,50` for every recipient.
 *
 * @param usd - Amount in dollars. Non-finite values (a null cost that leaked
 *   through arithmetic as `NaN`) render as `$0.00` rather than `$NaN`.
 * @returns e.g. `$1,234.50`.
 */
export function formatUsd(usd: number): string {
  const safe = Number.isFinite(usd) ? usd : 0;
  return `$${safe.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Formats an integer count with thousands separators.
 *
 * @param n - The count. Non-finite values render as `0`, same reasoning as
 *   {@link formatUsd}.
 * @returns e.g. `12,004`.
 */
export function formatCount(n: number): string {
  const safe = Number.isFinite(n) ? Math.round(n) : 0;
  return safe.toLocaleString('en-US');
}

/**
 * Renders a `(label, value)` table for an HTML email body.
 *
 * Labels and values are escaped here rather than at the call site, so a
 * user-supplied model name in a digest row cannot inject markup.
 *
 * @param rows - Row label/value pairs, plus an optional muted third column.
 * @returns A table element, or an empty string when `rows` is empty.
 */
export function htmlStatTable(
  rows: { label: string; value: string; note?: string }[],
): string {
  if (rows.length === 0) return '';
  const body = rows
    .map(
      (r) =>
        `<tr><td style="padding:6px 0;color:#6b7280;">${escapeHtml(r.label)}</td>` +
        `<td style="padding:6px 0;text-align:right;color:#111827;font-weight:600;">${escapeHtml(r.value)}</td>` +
        `<td style="padding:6px 0 6px 12px;text-align:right;color:#6b7280;font-size:12px;">${r.note ? escapeHtml(r.note) : ''}</td></tr>`,
    )
    .join('');
  return `<table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;margin:0 0 12px;"><tbody>${body}</tbody></table>`;
}

/** Input for {@link htmlLayout}. All HTML fields must be pre-escaped. */
export interface HtmlLayoutOptions {
  /** Escaped heading text. */
  heading: string;
  /** Escaped body HTML — paragraphs, lists. */
  bodyHtml: string;
  /**
   * Optional call-to-action button label. Passed raw — like {@link ctaUrl},
   * `htmlLayout` escapes it itself before interpolating it as the button's
   * text, so the interface is uniformly raw-in/escaped-at-sink. Do not
   * pre-escape at the call site: `escapeHtml` is not idempotent, so escaping
   * twice would double-encode `&` in a label that legitimately contains one.
   */
  ctaLabel?: string;
  /**
   * Optional call-to-action URL. Passed raw — `htmlLayout` escapes it itself
   * before interpolating into the `href` attribute, since that is the one
   * context here where a stray `"` actually breaks out (of the attribute,
   * not the body text). Do not pre-escape at the call site: `escapeHtml` is
   * not idempotent, so escaping twice would double-encode `&` in the URL's
   * query string.
   */
  ctaUrl?: string;
  /** Optional escaped footer HTML, below the divider. */
  footerHtml?: string;
}

/**
 * Wraps body HTML in the shared email shell.
 *
 * All CSS is inline: email clients routinely discard `<style>` blocks, and
 * none of them supports enough CSS to be worth targeting with a stylesheet.
 *
 * @param opts - Pre-escaped heading, body, and footer; `ctaLabel` and
 *   `ctaUrl` are the exception — pass both raw, this function escapes each
 *   itself at its own interpolation sink (button text and `href` attribute
 *   respectively).
 * @returns A complete HTML document.
 */
export function htmlLayout(opts: HtmlLayoutOptions): string {
  const cta =
    opts.ctaUrl && opts.ctaLabel
      ? `<p style="margin:24px 0;"><a href="${escapeHtml(opts.ctaUrl)}" style="background:#111827;color:#ffffff;padding:11px 18px;border-radius:6px;text-decoration:none;font-size:14px;display:inline-block;">${escapeHtml(opts.ctaLabel)}</a></p>`
      : '';
  const footer = opts.footerHtml
    ? `<hr style="border:none;border-top:1px solid #e5e7eb;margin:28px 0 16px;" /><p style="color:#6b7280;font-size:12px;line-height:1.6;margin:0;">${opts.footerHtml}</p>`
    : '';

  return [
    '<!doctype html>',
    // SES is told `Charset: 'UTF-8'` via the MIME envelope (see
    // `ses.transport.ts`), so this `<meta>` is redundant on that path — but a
    // non-ASCII team/inviter name would mojibake if this HTML were ever
    // previewed outside a mail client (a browser tab, a "view source" tool),
    // where there is no MIME header to fall back on.
    '<html><head><meta charset="utf-8" /></head><body style="margin:0;padding:24px;background:#f9fafb;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">',
    '<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;padding:28px;">',
    `<h1 style="margin:0 0 16px;font-size:19px;line-height:1.35;color:#111827;">${opts.heading}</h1>`,
    `<div style="color:#374151;font-size:14px;line-height:1.65;">${opts.bodyHtml}</div>`,
    cta,
    footer,
    '</div>',
    '<p style="color:#9ca3af;font-size:11px;text-align:center;margin:16px 0 0;">acruxcore</p>',
    '</body></html>',
  ].join('');
}

/** Input for {@link textLayout}. Plain text — never escaped. */
export interface TextLayoutOptions {
  /** Heading line — plain text. */
  heading: string;
  /** One entry per paragraph. */
  bodyLines: string[];
  /** Optional URL printed on its own line. */
  ctaUrl?: string;
  /** Optional trailing lines. */
  footerLines?: string[];
}

/**
 * Builds the plain-text alternative for a message.
 *
 * Every template ships both parts: HTML-only mail is a well-known spam signal,
 * and some clients render text only.
 *
 * @param opts - Heading, paragraphs, optional URL and footer lines.
 * @returns The text body.
 */
export function textLayout(opts: TextLayoutOptions): string {
  const parts = [opts.heading, '', ...opts.bodyLines];
  if (opts.ctaUrl) parts.push('', opts.ctaUrl);
  if (opts.footerLines?.length) parts.push('', ...opts.footerLines);
  parts.push('', '— acruxcore');
  return parts.join('\n');
}
