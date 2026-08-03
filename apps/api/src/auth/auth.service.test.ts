import { randomUUID } from 'node:crypto';
import prisma from '../shared/db/client';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';

const repo = new AuthRepository();
const service = new AuthService(repo);

/** Creates a user with their personal team, as Better Auth's signup hook would. */
async function seedUser(): Promise<{ userId: string; email: string; teamId: string }> {
  const email = `svc-${randomUUID()}@example.com`;
  const { user, team } = await repo.createUserWithTeam({ email });
  return { userId: user.id, email, teamId: team.id };
}

describe('AuthService.resolveActiveTeam', () => {
  it('resolves the personal team when no default is recorded', async () => {
    const { userId, email, teamId } = await seedUser();
    const resolved = await service.resolveActiveTeam({
      userId,
      email,
      displayName: null,
    });
    expect(resolved.teamId).toBe(teamId);
    expect(resolved.user.id).toBe(userId);
  });

  it('prefers the recorded default team while the user is still a member', async () => {
    const { userId, email } = await seedUser();
    const second = await prisma.team.create({ data: { name: 'second' } });
    await prisma.teamMember.create({
      data: { userId, teamId: second.id, role: 'owner' },
    });
    await repo.setDefaultTeam(userId, second.id);

    const resolved = await service.resolveActiveTeam({ userId, email, displayName: null });
    expect(resolved.teamId).toBe(second.id);
  });

  it('falls back to the oldest membership once the default is no longer a membership', async () => {
    // The removed-member protection: losing access to a team must stop requests
    // acting in it, even though `users.default_team_id` still points there.
    const { userId, email, teamId } = await seedUser();
    const second = await prisma.team.create({ data: { name: 'revoked' } });
    const m = await prisma.teamMember.create({ data: { userId, teamId: second.id, role: 'owner' } });
    await repo.setDefaultTeam(userId, second.id);

    await prisma.teamMember.delete({ where: { id: m.id } });

    const resolved = await service.resolveActiveTeam({ userId, email, displayName: null });
    expect(resolved.teamId).toBe(teamId);
  });

  it('heals a user who has no membership at all', async () => {
    // Unreachable via normal signup (the `user.create.after` hook provisions a
    // team), but if that hook ever failed the account would 404 on every
    // authenticated route with no way for the person to recover.
    const email = `heal-${randomUUID()}@example.com`;
    const user = await prisma.user.create({ data: { email } });
    expect(await prisma.teamMember.count({ where: { userId: user.id } })).toBe(0);

    const resolved = await service.resolveActiveTeam({
      userId: user.id,
      email,
      displayName: null,
    });

    expect(resolved.teamId).toBeDefined();
    const member = await prisma.teamMember.findFirst({
      where: { userId: user.id, teamId: resolved.teamId },
    });
    expect(member?.role).toBe('owner');
  });

  it('passes the session display name straight through', async () => {
    const { userId, email } = await seedUser();
    const resolved = await service.resolveActiveTeam({
      userId,
      email,
      displayName: 'Ada Lovelace',
    });
    expect(resolved.user.displayName).toBe('Ada Lovelace');
  });
});
