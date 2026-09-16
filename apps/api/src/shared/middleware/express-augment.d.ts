import 'express';
import type { GatewayCallContext } from '../../gateway/completions/completions.types';

declare module 'express' {
  interface Request {
    user?: { id: string; email: string; displayName: string | null };
    teamId?: string;
    /**
     * How this request authenticated.
     *
     * `requireTeamRole` needs it: a session's `teamId` is the team the user is
     * currently looking at and may legitimately differ from the team named in the
     * URL, but an API key's `teamId` is the key's own scope and must not be
     * escaped. Without this marker the two are indistinguishable downstream.
     */
    authMethod?: 'session' | 'api_key';
    /**
     * The caller's role in `teamId`, when authentication already resolved it.
     *
     * Only the API-key path sets it: that lookup joins `team_members` anyway, to
     * confirm the key's owner is still in the key's team, so the role comes back
     * for free. `requireRole` prefers it over its own query. A session leaves it
     * unset and `requireRole` reads the row itself.
     */
    teamRole?: string;
    gateway?: GatewayCallContext;
  }
}
