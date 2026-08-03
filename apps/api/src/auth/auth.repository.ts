import prisma from '../shared/db/client';
import type { team_role } from '@prisma/client';
import { User, Team } from '../shared/db/schema';

/** Shape returned by createUserWithTeam. */
export interface CreatedUserWithTeam {
  user: User;
  team: Team;
}

/**
 * Data access layer for the auth domain.
 * All queries that touch users, teams, or team_members
 * from the auth context live here.
 */
export class AuthRepository {
  /**
   * Looks up a user by email. Returns undefined if not found.
   * Used by both signup (conflict check) and login (credential validation).
   *
   * @param email - Normalised (lowercase-trimmed) email address.
   */
  async findUserByEmail(email: string): Promise<User | undefined> {
    const user = await prisma.user.findUnique({
      where: { email },
    });
    return user ?? undefined;
  }

  /**
   * Creates a user, their personal team, the team_members join row, and the
   * 'owner' role — all inside a single transaction.
   * The personal team name is derived as `"<email>'s team"`.
   *
   * Better Auth owns the normal signup path and creates the user row itself, so
   * this now serves only callers that must create both halves at once: the
   * first-run claim and test fixtures.
   *
   * @param params - Required fields for the new user.
   * @returns The newly inserted user and team rows.
   * @throws If any insert fails; the transaction rolls back automatically.
   */
  async createUserWithTeam(params: {
    email: string;
    displayName?: string;
    emailVerified?: boolean;
  }): Promise<CreatedUserWithTeam> {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: params.email,
          displayName: params.displayName ?? null,
          emailVerified: params.emailVerified ?? false,
        },
      });

      const team = await tx.team.create({
        data: { name: `${params.email}'s team` },
      });

      await tx.teamMember.create({
        data: { userId: user.id, teamId: team.id, role: 'owner' },
      });

      return { user, team };
    });
  }

  /**
   * Gives an already-created user their own team, owner role included, if they
   * have no membership yet.
   *
   * Idempotent on purpose. Better Auth creates the user row and then calls our
   * `user.create.after` hook to run this; if that hook ever fails — or a social
   * signup takes a path we did not anticipate — the account would otherwise exist
   * with no team, which every authenticated route treats as a hard 404. Calling
   * this again from `requireAuth` heals such a user on their next request instead
   * of stranding them permanently.
   *
   * Concurrency-safe by advisory lock rather than by a unique constraint, because
   * there is no column to make unique: "one personal team per user" is a rule
   * about the *absence* of any membership, and a user may legitimately belong to
   * many teams later. Without the lock this is a plain check-then-act — and
   * `requireAuth` calls it on every request from a membership-less user, so a
   * single page load firing several API calls in parallel would have every one of
   * them miss the lookup and create a team of its own, after which requests in
   * that same page load resolve to different `teamId`s. `pg_advisory_xact_lock`
   * serializes only the callers for one user id and releases at commit.
   *
   * @param userId - The user to give a team to.
   * @param email - Used only to name the team `"<email>'s team"`.
   * @returns The team the user now owns — the existing one if they already had a
   *   membership, otherwise the freshly created one.
   * @throws If the user row does not exist (the FK rejects the membership).
   */
  async ensurePersonalTeam(userId: string, email: string): Promise<Team> {
    return await prisma.$transaction(async (tx) => {
      // Taken BEFORE the lookup, or the read that decides whether to create
      // would still race. `hashtextextended` maps the uuid onto the bigint the
      // lock namespace takes; a collision between two user ids costs one
      // needless wait and nothing else.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`;

      const existing = await tx.teamMember.findFirst({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        include: { team: true },
      });
      if (existing) return existing.team;

      const team = await tx.team.create({ data: { name: `${email}'s team` } });
      await tx.teamMember.create({
        data: { userId, teamId: team.id, role: 'owner' },
      });
      return team;
    });
  }

  /**
   * Counts registered users.
   *
   * Drives the first-run claim: a self-hosted instance with zero users is
   * unclaimed, and that single fact is what makes the printed claim token
   * single-use — a successful claim invalidates it by construction, with nothing
   * stored.
   *
   * @returns The total number of user rows.
   */
  async countUsers(): Promise<number> {
    return prisma.user.count();
  }

  /**
   * Reads just a user's email.
   *
   * Used by the session-create hook, which receives a `userId` but needs an
   * address to send a new-device alert to.
   *
   * @param userId - The user's UUID.
   * @returns The email, or undefined when the user no longer exists.
   */
  async findEmailById(userId: string): Promise<{ email: string } | undefined> {
    const row = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    return row ?? undefined;
  }

  /**
   * Reads the user's recorded active team without loading the whole row.
   *
   * @param userId - The user's UUID.
   * @returns The default team id, or null if none is recorded or the user is gone.
   */
  async findDefaultTeamId(userId: string): Promise<string | null> {
    const row = await prisma.user.findUnique({
      where: { id: userId },
      select: { defaultTeamId: true },
    });
    return row?.defaultTeamId ?? null;
  }

  /**
   * Returns the first team the user belongs to, ordered by join date ascending.
   * For a freshly signed-up user this is always their personal team.
   *
   * @param userId - The user's UUID.
   * @returns The team row, or undefined if the user has no team memberships.
   */
  async findTeamForUser(userId: string): Promise<Team | undefined> {
    const membership = await prisma.teamMember.findFirst({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      include: { team: true },
    });
    return membership?.team ?? undefined;
  }

  /**
   * Returns the role name the user holds in the given team.
   *
   * @param userId - The user's UUID.
   * @param teamId - The team's UUID.
   * @returns The role, or null if the user is not a member of the team.
   */
  async findRoleForUserInTeam(
    userId: string,
    teamId: string,
  ): Promise<team_role | null> {
    const member = await prisma.teamMember.findFirst({
      where: { userId, teamId },
      select: { role: true },
    });
    return member?.role ?? null;
  }

  /**
   * Returns a team by ID. Used by GET /auth/me to fetch the team name.
   *
   * @param teamId - The team's UUID.
   */
  async findTeamById(teamId: string): Promise<Team | undefined> {
    const team = await prisma.team.findUnique({
      where: { id: teamId },
    });
    return team ?? undefined;
  }

  /**
   * Lists every team the user belongs to with the role they hold in each,
   * ordered by membership creation ascending (their personal team first).
   *
   * @param userId - The user's UUID.
   * @returns One entry per membership: team id, name, and role.
   */
  async listTeamsForUser(
    userId: string,
  ): Promise<Array<{ id: string; name: string; role: team_role }>> {
    const memberships = await prisma.teamMember.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      include: { team: true },
    });
    return memberships.map((m) => ({
      id: m.team.id,
      name: m.team.name,
      role: m.role,
    }));
  }

  /**
   * Returns true if the user is a member of the given team.
   *
   * @param userId - The user's UUID.
   * @param teamId - The team's UUID.
   */
  async isMember(userId: string, teamId: string): Promise<boolean> {
    const m = await prisma.teamMember.findFirst({ where: { userId, teamId } });
    return m !== null;
  }

  /**
   * Persists the user's last-active team.
   *
   * @param userId - The user's UUID.
   * @param teamId - The team to record as default.
   */
  async setDefaultTeam(userId: string, teamId: string): Promise<void> {
    await prisma.user.update({ where: { id: userId }, data: { defaultTeamId: teamId } });
  }

  /**
   * Records a device against a user and reports whether it is new to the account.
   *
   * Read and write share one transaction so two simultaneous sign-ins from the
   * same unseen device cannot both conclude they saw it first — otherwise both
   * would send a "new sign-in" alert for one device.
   *
   * The account's very first device returns false: that is the signup itself,
   * which the verification and welcome emails already cover.
   *
   * @param userId - The user's UUID.
   * @param fingerprint - Opaque `sha256(ip|user-agent)` digest, never a raw IP.
   * @returns True when this device was not previously known AND the account had
   *   at least one device already — i.e. when an alert is warranted.
   */
  async recordDeviceAndDetectNew(userId: string, fingerprint: string): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.knownDevice.findUnique({
        where: { userId_fingerprint: { userId, fingerprint } },
        select: { id: true },
      });
      if (existing) {
        await tx.knownDevice.update({
          where: { id: existing.id },
          data: { lastSeenAt: new Date() },
        });
        return false;
      }
      const priorDevices = await tx.knownDevice.count({ where: { userId } });
      await tx.knownDevice.create({ data: { userId, fingerprint } });
      return priorDevices > 0;
    });
  }
}
