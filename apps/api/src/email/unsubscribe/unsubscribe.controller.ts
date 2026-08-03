import type { NextFunction, Request, Response } from 'express';
import { NotificationsService } from '../../notifications/notifications.service';
import { NotificationCategorySchema } from '../../notifications/notifications.types';
import { verifyUnsubscribeToken } from './unsubscribe.token';
import { escapeHtml } from '../templates/layout';

/** Human-readable label per category, for the confirmation page. */
const LABELS: Record<string, string> = {
  budget_alerts: 'budget alerts',
  eval_runs: 'evaluation run results',
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
 */
export class UnsubscribeController {
  constructor(private readonly service: NotificationsService) {}

  /**
   * POST — the RFC 8058 one-click target. Always 204.
   *
   * Mail clients treat any non-2xx as a failed unsubscribe and may show the user
   * an error, so a bad token still returns 204: there is nothing the recipient
   * could do about a token we mis-signed, and nothing an attacker learns.
   */
  post = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await this.apply(req);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET — the same action, for the many clients that render `List-Unsubscribe`
   * as a plain link. Returns a minimal HTML confirmation page.
   */
  get = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const category = await this.apply(req);
      const what = category ? LABELS[category] ?? 'these emails' : 'these emails';
      res
        .status(200)
        .type('html')
        .send(page(`You will no longer receive ${escapeHtml(what)} for this team.`));
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

/** Minimal self-contained confirmation page — no assets, no tracking. */
function page(message: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width,initial-scale=1" />',
    '<meta name="robots" content="noindex" />',
    '<title>Unsubscribed · acruxcore</title></head>',
    '<body style="margin:0;padding:48px 24px;background:#f9fafb;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">',
    '<div style="max-width:420px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:28px;text-align:center;">',
    '<h1 style="margin:0 0 12px;font-size:18px;color:#111827;">Unsubscribed</h1>',
    `<p style="margin:0;color:#374151;font-size:14px;line-height:1.6;">${message}</p>`,
    '<p style="margin:16px 0 0;color:#6b7280;font-size:12px;line-height:1.6;">You can change this any time from Account &amp; keys in the app. Other notification types are unaffected.</p>',
    '</div></body></html>',
  ].join('');
}
