import { randomUUID } from 'node:crypto';
import prisma from '../shared/db/client';
import { AuthRepository } from './auth.repository';

const repo = new AuthRepository();

describe('AuthRepository.ensurePersonalTeam', () => {
  it('gives a teamless user their own team with the owner role', async () => {
    const email = `ept-${randomUUID()}@example.com`;
    const user = await prisma.user.create({ data: { email } });

    const team = await repo.ensurePersonalTeam(user.id, email);
    expect(team.name).toBe(`${email}'s team`);

    const member = await prisma.teamMember.findFirst({
      where: { userId: user.id, teamId: team.id },
    });
    expect(member?.role).toBe('owner');
  });

  it('is idempotent — a second call returns the same team and adds no membership', async () => {
    // This is the property `requireAuth` depends on: it calls this on every
    // request whose user somehow has no team, so a non-idempotent version would
    // hand out a fresh team per request.
    const email = `idem-${randomUUID()}@example.com`;
    const user = await prisma.user.create({ data: { email } });

    const first = await repo.ensurePersonalTeam(user.id, email);
    const second = await repo.ensurePersonalTeam(user.id, email);

    expect(second.id).toBe(first.id);
    expect(await prisma.teamMember.count({ where: { userId: user.id } })).toBe(1);
  });

  it('returns the existing team rather than creating a personal one', async () => {
    // A user invited into someone else's team before ever owning one must not
    // silently acquire a second, empty team.
    const email = `inv-${randomUUID()}@example.com`;
    const user = await prisma.user.create({ data: { email } });
    const other = await prisma.team.create({ data: { name: 'someone elses team' } });
    await prisma.teamMember.create({ data: { userId: user.id, teamId: other.id, role: 'viewer' } });

    const team = await repo.ensurePersonalTeam(user.id, email);
    expect(team.id).toBe(other.id);
    expect(await prisma.teamMember.count({ where: { userId: user.id } })).toBe(1);
  });

  it('concurrent calls for one user still produce exactly one team', async () => {
    // Sequential idempotency is not enough. `requireAuth` calls this on every
    // request from a membership-less user, and one page load fires several API
    // calls at once — under READ COMMITTED all of them would miss the lookup and
    // each create a team, after which requests within that same page load
    // resolve to different `teamId`s. Six is well past the two needed to fail.
    const email = `race-${randomUUID()}@example.com`;
    const user = await prisma.user.create({ data: { email } });

    const teams = await Promise.all(
      Array.from({ length: 6 }, () => repo.ensurePersonalTeam(user.id, email)),
    );

    expect(new Set(teams.map((t) => t.id)).size).toBe(1);
    expect(await prisma.teamMember.count({ where: { userId: user.id } })).toBe(1);
    expect(await prisma.team.count({ where: { name: `${email}'s team` } })).toBe(1);
  });
});

describe('AuthRepository.createUserWithTeam', () => {
  it('creates user, team, membership, and owner role in one transaction', async () => {
    const email = `cuw-${randomUUID()}@example.com`;
    const { user, team } = await repo.createUserWithTeam({ email });

    expect(user.email).toBe(email);
    expect(user.emailVerified).toBe(false);
    const member = await prisma.teamMember.findFirst({
      where: { userId: user.id, teamId: team.id },
    });
    expect(member?.role).toBe('owner');
  });

  it('honours emailVerified, which the first-run claim relies on', async () => {
    const email = `cuwv-${randomUUID()}@example.com`;
    const { user } = await repo.createUserWithTeam({ email, emailVerified: true });
    expect(user.emailVerified).toBe(true);
  });
});

describe('AuthRepository.countUsers', () => {
  it('counts users, which is what makes the first-run claim single-use', async () => {
    const before = await repo.countUsers();
    await prisma.user.create({ data: { email: `cnt-${randomUUID()}@example.com` } });
    expect(await repo.countUsers()).toBe(before + 1);
  });
});

describe('AuthRepository.findDefaultTeamId', () => {
  it('returns the recorded default, and null when none is set', async () => {
    const email = `dft-${randomUUID()}@example.com`;
    const { user, team } = await repo.createUserWithTeam({ email });
    expect(await repo.findDefaultTeamId(user.id)).toBeNull();

    await repo.setDefaultTeam(user.id, team.id);
    expect(await repo.findDefaultTeamId(user.id)).toBe(team.id);
  });

  it('returns null for a user that does not exist', async () => {
    expect(await repo.findDefaultTeamId(randomUUID())).toBeNull();
  });
});
