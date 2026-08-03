import { Router } from 'express';
import { requireAuth, requireAnyAuth } from '../../shared/middleware';
import { requireTeamRole } from '../../shared/middleware/require-role.middleware';
import { InvitesController } from './invites.controller';
import { InvitesService } from './invites.service';
import { InvitesRepository } from './invites.repository';
import { MembersRepository } from '../members/members.repository';
import { AuthRepository } from '../../auth/auth.repository';
import { EmailRepository, EmailService } from '../../email';

const invitesRepo = new InvitesRepository();
const membersRepo = new MembersRepository();
const authRepo = new AuthRepository();
const emailRepo = new EmailRepository();
const emailService = new EmailService(emailRepo);
const service = new InvitesService(invitesRepo, membersRepo, authRepo, emailService, emailRepo);
const ctrl = new InvitesController(service);

/**
 * Router for invite management.
 * Mounted by teams.router.ts at /api/v1/teams/:id for team-scoped routes.
 * The accept route (/teams/invites/:token/accept) is mounted separately in app.ts.
 */
const invitesRouter = Router({ mergeParams: true });

invitesRouter.post('/', requireAnyAuth, requireTeamRole('owner', 'admin'), ctrl.create);
invitesRouter.get('/', requireAnyAuth, requireTeamRole('owner', 'admin'), ctrl.list);
invitesRouter.delete('/:inviteId', requireAnyAuth, requireTeamRole('owner', 'admin'), ctrl.revoke);

export { invitesRouter };

/**
 * Separate router for the accept-invite endpoint.
 * Mounted at /api/v1 (no team prefix) because the user doesn't know the team ID yet.
 */
const inviteAcceptRouter = Router();
inviteAcceptRouter.post('/teams/invites/:token/accept', requireAuth, ctrl.accept);

export { inviteAcceptRouter };
