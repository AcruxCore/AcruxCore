import type { EmailPayload, RenderedEmail } from '../email.types';
import { verifyEmailEmail } from './verify-email';
import { passwordResetEmail } from './password-reset';
import { welcomeEmail } from './welcome';
import { passwordChangedEmail } from './password-changed';
import { newSignInEmail } from './new-sign-in';
import { teamInviteEmail } from './team-invite';
import { budgetThresholdEmail } from './budget-threshold';
import { budgetExhaustedEmail } from './budget-exhausted';
import { evalRunFinishedEmail } from './eval-run-finished';
import { memberJoinedEmail } from './member-joined';
import { memberRemovedEmail } from './member-removed';
import { memberRolesChangedEmail } from './member-roles-changed';
import { weeklyDigestEmail } from './weekly-digest';

export * from './layout';
export * from './verify-email';
export * from './password-reset';
export * from './welcome';
export * from './password-changed';
export * from './new-sign-in';
export * from './team-invite';
export * from './budget-threshold';
export * from './budget-exhausted';
export * from './eval-run-finished';
export * from './member-joined';
export * from './member-removed';
export * from './member-roles-changed';
export * from './weekly-digest';

/**
 * Renders a payload with its template.
 *
 * The switch is exhaustive over `EmailPayload`, so adding an `EmailType`
 * without a template here is a compile error rather than a job that fails in
 * the worker at 3am.
 *
 * @param payload - Discriminated template key + props.
 * @returns Subject plus both bodies.
 */
export function renderEmail(payload: EmailPayload): RenderedEmail {
  switch (payload.type) {
    case 'verify_email':
      return verifyEmailEmail(payload.props);
    case 'password_reset':
      return passwordResetEmail(payload.props);
    case 'welcome':
      return welcomeEmail(payload.props);
    case 'password_changed':
      return passwordChangedEmail(payload.props);
    case 'new_sign_in':
      return newSignInEmail(payload.props);
    case 'team_invite':
      return teamInviteEmail(payload.props);
    case 'budget_threshold':
      return budgetThresholdEmail(payload.props);
    case 'budget_exhausted':
      return budgetExhaustedEmail(payload.props);
    case 'eval_run_finished':
      return evalRunFinishedEmail(payload.props);
    case 'member_joined':
      return memberJoinedEmail(payload.props);
    case 'member_removed':
      return memberRemovedEmail(payload.props);
    case 'member_roles_changed':
      return memberRolesChangedEmail(payload.props);
    case 'weekly_digest':
      return weeklyDigestEmail(payload.props);
  }
}
