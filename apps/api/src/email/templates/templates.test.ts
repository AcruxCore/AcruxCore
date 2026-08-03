import type { TeamInviteEmailProps } from '../email.types';
import { escapeHtml, formatExpiry, htmlLayout, oneLine } from './layout';
import { teamInviteEmail } from './team-invite';
import { renderEmail } from './index';

const BASE: TeamInviteEmailProps = {
  teamName: 'Acme Research',
  inviterName: 'Dana Ops',
  role: 'editor',
  inviteUrl: 'https://acruxcore.com/invite/abc123',
  expiresAt: '2026-08-01T09:30:00.000Z',
};

describe('layout helpers', () => {
  it('escapes every HTML-significant character', () => {
    expect(escapeHtml(`<script>"x"&'y'</script>`)).toBe(
      '&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;',
    );
  });

  it('collapses newlines and tabs for header use', () => {
    expect(oneLine('a\r\nb\tc  d ')).toBe('a b c d');
  });

  it('formats an expiry as fixed UTC', () => {
    expect(formatExpiry('2026-08-01T09:30:00.000Z')).toBe('2026-08-01 09:30 UTC');
  });

  it('rejects an unparseable expiry', () => {
    expect(() => formatExpiry('not-a-date')).toThrow(RangeError);
  });

  it('declares a UTF-8 charset in the HTML head', () => {
    const html = htmlLayout({ heading: 'Heading', bodyHtml: '<p>Body</p>' });
    expect(html).toContain('<meta charset="utf-8" />');
  });

  it('escapes a hostile ctaLabel at the sink, like ctaUrl, so callers may pass it raw', () => {
    const html = htmlLayout({
      heading: 'Heading',
      bodyHtml: '<p>Body</p>',
      ctaLabel: '<script>alert(1)</script>',
      ctaUrl: 'https://example.com',
    });

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('teamInviteEmail', () => {
  it('renders both parts with the URL, team, inviter, and role', () => {
    const { subject, html, text } = teamInviteEmail(BASE);

    expect(subject).toBe('Dana Ops invited you to Acme Research on acruxcore');
    for (const body of [html, text]) {
      expect(body).toContain('https://acruxcore.com/invite/abc123');
      expect(body).toContain('Acme Research');
      expect(body).toContain('Dana Ops');
      expect(body).toContain('editor');
    }
    expect(html).toContain('<!doctype html>');
    expect(text).not.toContain('<');
  });

  it('escapes a hostile team name in HTML but not the subject header', () => {
    const hostile = '<script>alert(1)</script>';
    const { subject, html } = teamInviteEmail({ ...BASE, teamName: hostile });

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    // The subject is a header value, not markup: it is collapsed to one line,
    // not entity-escaped.
    expect(subject).toContain('alert(1)');
    expect(subject).not.toMatch(/[\r\n]/);
  });

  it('escapes a hostile inviter name', () => {
    const { html } = teamInviteEmail({ ...BASE, inviterName: '"><img src=x>' });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('shows the formatted expiry in both parts', () => {
    const { html, text } = teamInviteEmail(BASE);
    expect(html).toContain('2026-08-01 09:30 UTC');
    expect(text).toContain('2026-08-01 09:30 UTC');
  });

  it('escapes a hostile inviteUrl so it cannot break out of the href attribute', () => {
    const hostileUrl = 'https://acruxcore.com/invite/x" onmouseover="alert(1)';
    const { html } = teamInviteEmail({ ...BASE, inviteUrl: hostileUrl });

    // The raw quote is what would close the href attribute early and let
    // onmouseover be parsed as a second, live attribute — that sequence must
    // never appear unescaped in the output.
    expect(html).not.toContain('x" onmouseover="alert(1)');
    // The same value, correctly escaped, is harmless inert text inside the
    // href value.
    expect(html).toContain('x&quot; onmouseover=&quot;alert(1)');
  });
});

describe('renderEmail', () => {
  it('dispatches team_invite to its template', () => {
    expect(renderEmail({ type: 'team_invite', props: BASE })).toEqual(teamInviteEmail(BASE));
  });
});
