import { Router } from 'express';
import { requireAuth } from '../shared/middleware';
import { requireTeamRole } from '../shared/middleware/require-role.middleware';
import { membersRouter } from './members/members.router';
import { invitesRouter } from './invites/invites.router';
import { ApiKeysRepository } from '../api-keys/api-keys.repository';
import { ApiKeysService } from '../api-keys/api-keys.service';
import { ApiKeysController } from '../api-keys/api-keys.controller';
import { listTeamAuditActors, listTeamAuditEvents } from '../audit/audit.controller';

const apiKeysRepo = new ApiKeysRepository();
const apiKeysService = new ApiKeysService(apiKeysRepo);
const apiKeysCtrl = new ApiKeysController(apiKeysService);

/**
 * Express router for all team-management endpoints.
 * Mounted at /api/v1/teams.
 *
 * Sub-resources:
 *   /teams/:id/members  — member listing + role management
 *   /teams/:id/invites  — invite creation, listing, revocation
 *   /teams/:id/api-keys — team-scoped API key management
 *   /teams/:id/audit    — team-wide audit trail (Finding #13)
 */
export const teamsRouter = Router();

// ── Member management ──────────────────────────────────────────────────────
teamsRouter.use('/:id/members', membersRouter);

// ── Invite management ──────────────────────────────────────────────────────
teamsRouter.use('/:id/invites', invitesRouter);

// ── Team-scoped API keys ───────────────────────────────────────────────────
teamsRouter.post(
  '/:id/api-keys',
  requireAuth,
  requireTeamRole('owner', 'admin'),
  apiKeysCtrl.createTeamApiKey,
);

teamsRouter.get(
  '/:id/api-keys',
  requireAuth,
  requireTeamRole('owner', 'admin'),
  apiKeysCtrl.listTeamApiKeys,
);

teamsRouter.delete(
  '/:id/api-keys/:keyId',
  requireAuth,
  requireTeamRole('owner', 'admin'),
  apiKeysCtrl.revokeTeamApiKey,
);

// ── Team-wide audit trail (Finding #13) ────────────────────────────────────
// `/audit/actors` is declared first: Express matches in order, and `/:id/audit`
// would not swallow it, but keeping the more specific path above the list route
// keeps the intent obvious to the next reader.
teamsRouter.get(
  '/:id/audit/actors',
  requireAuth,
  requireTeamRole('owner', 'admin'),
  listTeamAuditActors,
);

teamsRouter.get(
  '/:id/audit',
  requireAuth,
  requireTeamRole('owner', 'admin'),
  listTeamAuditEvents,
);
