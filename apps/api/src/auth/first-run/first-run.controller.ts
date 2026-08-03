import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ValidationError } from '../../shared/errors';
import { FirstRunService } from './first-run.service';

/** Body of the first-run claim. */
export const ClaimSchema = z.object({
  token: z.string().min(1),
  // Lowercased here as well as in the service: Better Auth normalises the
  // address before storing it, and anything that later looks the row up by the
  // string the owner typed would miss it.
  email: z.string().email().toLowerCase(),
  // Matches Better Auth's own default minimum, so a password accepted here can
  // never be rejected at the next sign-in.
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(200).optional(),
});

/** HTTP handler for the first-run claim. */
export class FirstRunController {
  constructor(private readonly service: FirstRunService) {}

  /**
   * POST /api/v1/auth/first-run/claim
   *
   * Creates the first account on an unclaimed instance and signs it in by
   * forwarding Better Auth's own session cookie, so the owner lands in the app
   * rather than on a login form.
   */
  claim = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = ClaimSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0].message);
      }
      const { setCookie, userId } = await this.service.claim({
        token: parsed.data.token,
        email: parsed.data.email,
        password: parsed.data.password,
        displayName: parsed.data.name,
        // The forwarding headers verbatim, not `req.ip`. Express is not
        // configured to trust proxies, so `req.ip` is the nginx container in
        // front of the API — a different address from the one Better Auth
        // resolves on the owner's next real sign-in, which would make that
        // sign-in look like a new device and fire an alert. Both headers are
        // passed through, in Better Auth's own precedence, so the claim and the
        // sign-in resolve the client identically.
        device: {
          cfConnectingIp: req.get('cf-connecting-ip'),
          forwardedFor: req.get('x-forwarded-for'),
          userAgent: req.get('user-agent'),
        },
      });
      for (const cookie of setCookie) {
        res.append('Set-Cookie', cookie);
      }
      res.status(201).json({ user_id: userId });
    } catch (err) {
      next(err);
    }
  };
}
