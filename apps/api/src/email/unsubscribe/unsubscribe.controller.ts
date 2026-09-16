import type { NextFunction, Request, Response } from 'express';
import { NotificationsService } from '../../notifications/notifications.service';
import { NotificationCategorySchema } from '../../notifications/notifications.types';
import { verifyUnsubscribeToken } from './unsubscribe.token';
import { escapeHtml } from '../templates/layout';

/** Human-readable label per category, for the confirmation page. */
const LABELS: Record<string, string> = {
  budget_alerts: 'budget alerts',
  eval_runs: 'evaluation run results',
  eval_rules: 'online evaluation alerts',
  membership: 'membership changes',
  weekly_digest: 'the weekly usage digest',
};

/**
 * Handlers for `/api/v1/email/unsubscribe`.
 *
 * Both are **unauthenticated by design** — an unsubscribe that required a login
 * would not be one-click, and RFC 8058 clients POST with no session at all. The
 * signed token is the entire authorization.
 *
 * Both are also deliberately **uniform in their response**: a valid token, a
 * tampered token, and a token for a `(user, team)` pair that no longer exists all
 * produce the same status and body. Distinguishing them would turn the endpoint
 * into an oracle for which users belong to which teams.
 *
 * **Only POST writes.** A GET is a link, and a link in an email is fetched by
 * things that are not the recipient: Outlook Safe Links, corporate mail
 * gateways, antivirus scanners, and clients that prefetch. None of them clicked.
 * When the GET performed the opt-out, one of those fetches silently turned off a
 * recipient's budget alerts — the email that warns them their gateway spend is
 * about to run out — with a 200, a correct-looking row, and nothing logged as
 * wrong. This is the reason RFC 8058 specifies POST for one-click in the first
 * place. So GET renders the confirmation and writes nothing, and its form POSTs
 * the same token back.
 */
export class UnsubscribeController {
  constructor(private readonly service: NotificationsService) {}

  /**
   * POST — the RFC 8058 one-click target, and the only handler that writes.
   *
   * Mail clients treat any non-2xx as a failed unsubscribe and may show the user
   * an error, so a bad token still succeeds: there is nothing the recipient
   * could do about a token we mis-signed, and nothing an attacker learns.
   *
   * Answers 204 for the one-click POST a mail client makes, and the confirmation
   * page for the form POST a browser makes — told apart by `Accept`, since a mail
   * client sends none or `*​/*` while a browser submitting a form asks for HTML.
   * A 204 to a browser would leave the page sitting there unchanged, looking like
   * the button did nothing.
   */
  post = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const category = await this.apply(req);
      if (!wantsHtml(req)) {
        res.status(204).end();
        return;
      }
      const what = category ? LABELS[category] ?? 'these emails' : 'these emails';
      res
        .status(200)
        .type('html')
        .send(donePage(`You will no longer receive ${escapeHtml(what)} for this team.`));
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET — for the many clients that render `List-Unsubscribe` as a plain link.
   *
   * Verifies the token so the page can name the category, and **writes nothing**:
   * it renders a one-button form that POSTs the same token back. See the class
   * docstring for why a GET must not be the thing that applies the opt-out.
   */
  get = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const raw = req.query['token'];
      const token = typeof raw === 'string' ? raw : '';
      const claims = verifyUnsubscribeToken(token || undefined);
      const parsed = claims ? NotificationCategorySchema.safeParse(claims.category) : null;
      const what = parsed?.success ? LABELS[parsed.data] ?? 'these emails' : 'these emails';
      res
        .status(200)
        .type('html')
        .send(confirmPage(escapeHtml(what), escapeHtml(encodeURIComponent(token))));
    } catch (err) {
      next(err);
    }
  };

  /**
   * Verifies the token and writes the opt-out.
   *
   * @param req - The request carrying `?token=`.
   * @returns The category that was turned off, or null when the token was not
   *   ours (or its membership is gone). Callers must not vary their response on
   *   this distinction beyond the wording of the confirmation page.
   */
  private async apply(req: Request): Promise<string | null> {
    const raw = req.query['token'];
    const claims = verifyUnsubscribeToken(typeof raw === 'string' ? raw : undefined);
    if (!claims) return null;

    // The category string was signed by us, but a token minted by an older
    // build could name a category this build no longer knows.
    const category = NotificationCategorySchema.safeParse(claims.category);
    if (!category.success) return null;

    const written = await this.service.unsubscribe(
      claims.teamId,
      claims.userId,
      category.data,
    );
    return written ? category.data : null;
  }
}

/**
 * Whether the caller is a browser following the rendered form rather than a mail
 * client making the RFC 8058 one-click POST.
 *
 * A browser submitting a form sends `Accept: text/html,...`; a mail client sends
 * no `Accept` at all, or `*​/*`. `req.accepts('html')` would answer true for
 * `*​/*` too, so the header is matched explicitly instead.
 */
function wantsHtml(req: Request): boolean {
  return (req.headers.accept ?? '').includes('text/html');
}

/**
 * The page a GET renders: names what is about to be turned off and offers one
 * button, which POSTs the same token.
 *
 * @param what - Already-escaped human label for the category.
 * @param token - Already-escaped, URL-encoded token, for the form's action.
 */
function confirmPage(what: string, token: string): string {
  return shell(
    'Unsubscribe',
    [
      '<h1 style="margin:0 0 12px;font-size:18px;color:#111827;">Unsubscribe</h1>',
      `<p style="margin:0 0 20px;color:#374151;font-size:14px;line-height:1.6;">Confirm that you no longer want to receive ${what} for this team.</p>`,
      `<form method="post" action="/api/v1/email/unsubscribe?token=${token}">`,
      '<button type="submit" style="appearance:none;border:0;border-radius:8px;background:#111827;color:#fff;font-size:14px;font-weight:600;padding:10px 18px;cursor:pointer;">Unsubscribe</button>',
      '</form>',
      '<p style="margin:16px 0 0;color:#6b7280;font-size:12px;line-height:1.6;">Nothing has changed yet. Other notification types are unaffected.</p>',
    ].join(''),
  );
}

/** The page shown once the opt-out has actually been written. */
function donePage(message: string): string {
  return shell(
    'Unsubscribed',
    [
      '<h1 style="margin:0 0 12px;font-size:18px;color:#111827;">Unsubscribed</h1>',
      `<p style="margin:0;color:#374151;font-size:14px;line-height:1.6;">${message}</p>`,
      '<p style="margin:16px 0 0;color:#6b7280;font-size:12px;line-height:1.6;">You can change this any time from Account &amp; keys in the app. Other notification types are unaffected.</p>',
    ].join(''),
  );
}

/** Minimal self-contained page shell — no assets, no tracking. */
function shell(title: string, inner: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width,initial-scale=1" />',
    '<meta name="robots" content="noindex" />',
    `<title>${title} \u00b7 acruxcore</title></head>`,
    '<body style="margin:0;padding:48px 24px;background:#f9fafb;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">',
    '<div style="max-width:420px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:28px;text-align:center;">',
    inner,
    '</div></body></html>',
  ].join('');
}
