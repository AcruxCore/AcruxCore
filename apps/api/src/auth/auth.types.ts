import { z } from 'zod';
import type { team_role } from '@prisma/client';

/**
 * Shape of the user object attached to `req.user` and returned in API responses.
 * Does NOT include `passwordHash`.
 */
export interface UserDto {
  id: string;
  email: string;
  displayName: string | null;
}

/** Shape of a team as returned in auth responses. */
export interface TeamDto {
  id: string;
  name: string;
}

/** Response body for GET /auth/me — includes the user's role in the team. */
export interface MeResponseDto {
  user: UserDto;
  team: TeamDto;
  role: team_role;
}

/** One team the user belongs to, with their role in it (GET /auth/teams). */
export interface TeamMembershipDto {
  id: string;
  name: string;
  role: team_role;
}

/** Response body for GET /auth/teams. */
export interface MyTeamsResponseDto {
  teams: TeamMembershipDto[];
}

/** Zod schema for POST /auth/switch-team body. */
export const SwitchTeamSchema = z.object({
  teamId: z.string({ required_error: 'teamId is required.' }).uuid('teamId must be a valid UUID.'),
});

export type SwitchTeamDto = z.infer<typeof SwitchTeamSchema>;
