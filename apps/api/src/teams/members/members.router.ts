import { Router } from 'express';
import { requireAnyAuth } from '../../shared/middleware';
import { requireTeamRole } from '../../shared/middleware/require-role.middleware';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';
import { MembersRepository } from './members.repository';

const repo = new MembersRepository();
const service = new MembersService(repo);
const ctrl = new MembersController(service);

/**
 * Express router for team member management.
 * All routes require authentication in the target team (:id) — list requires
 * any role; write operations require owner or admin.
 * This router is mounted by teams.router.ts at /api/v1/teams/:id.
 */
const membersRouter = Router({ mergeParams: true });

membersRouter.get(
  '/',
  requireAnyAuth,
  requireTeamRole('owner', 'admin', 'editor', 'viewer'),
  ctrl.list,
);

membersRouter.patch(
  '/:userId/roles',
  requireAnyAuth,
  requireTeamRole('owner', 'admin'),
  ctrl.updateRole,
);

membersRouter.delete(
  '/:userId',
  requireAnyAuth,
  requireTeamRole('owner', 'admin'),
  ctrl.remove,
);

export { membersRouter };
