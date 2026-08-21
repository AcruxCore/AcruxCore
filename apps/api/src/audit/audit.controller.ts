import type { Request, Response, NextFunction } from 'express';
import { AuditQuerySchema } from './audit.types';
import { AuditService } from './audit.service';

const auditService = new AuditService();

/**
 * GET /api/v1/prompts/:id/audit
 * Returns a paginated, reverse-chronological audit log for a prompt.
 * Validates page/limit query params; delegates to AuditService.
 */
export async function listAuditEvents(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = AuditQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: parsed.error.errors[0]?.message ?? 'Invalid query parameters.' },
      });
      return;
    }

    const { page, limit } = parsed.data;
    const result = await auditService.listForPrompt(req.params.id!, req.teamId!, page, limit);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/tools/:id/audit
 * Returns a paginated, reverse-chronological audit log for a tool — its own
 * version commits, alias promotions, and code-sync supersedes.
 */
export async function listToolAuditEvents(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = AuditQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: parsed.error.errors[0]?.message ?? 'Invalid query parameters.' },
      });
      return;
    }

    const { page, limit } = parsed.data;
    const result = await auditService.listForTool(req.params.id!, req.teamId!, page, limit);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/teams/:id/audit
 * Returns a paginated, reverse-chronological audit log for an entire team
 * (Finding #13) — not scoped to a single prompt. `:id` is the target team,
 * already verified by `requireTeamRole` (owner/admin only).
 */
export async function listTeamAuditEvents(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = AuditQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: parsed.error.errors[0]?.message ?? 'Invalid query parameters.' },
      });
      return;
    }

    const { page, limit } = parsed.data;
    const result = await auditService.listForTeam(req.params.id!, page, limit);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
