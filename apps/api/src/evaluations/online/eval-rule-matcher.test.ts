import { randomUUID } from 'node:crypto';
import prisma from '../../shared/db/client';
import { matchesFilter, type SpanMatchContext } from './eval-rule-matcher';

async function truncate(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE prompt_aliases, prompt_versions, prompts, traces, teams, users RESTART IDENTITY CASCADE`,
  );
}
beforeEach(truncate);
afterAll(async () => {
  await truncate();
  await prisma.$disconnect();
});

const baseCtx: SpanMatchContext = { promptVersionId: null, model: 'gpt-4o-mini', tags: [], sessionId: null };

describe('matchesFilter', () => {
  it('an empty filter matches anything', async () => {
    expect(await matchesFilter({}, baseCtx)).toBe(true);
  });

  it('rejects on model mismatch', async () => {
    expect(await matchesFilter({ model: 'gpt-4o' }, baseCtx)).toBe(false);
  });

  it('requires every listed tag to be present (subset match)', async () => {
    const ctx = { ...baseCtx, tags: ['support', 'billing'] };
    expect(await matchesFilter({ tags: ['support'] }, ctx)).toBe(true);
    expect(await matchesFilter({ tags: ['support', 'urgent'] }, ctx)).toBe(false);
  });

  it('sessionOnly requires a non-null sessionId', async () => {
    expect(await matchesFilter({ sessionOnly: true }, baseCtx)).toBe(false);
    expect(await matchesFilter({ sessionOnly: true }, { ...baseCtx, sessionId: 'sess-1' })).toBe(true);
  });

  it('promptId matches by resolving the span\'s promptVersionId to its parent prompt', async () => {
    const user = await prisma.user.create({ data: { email: `${randomUUID()}@test.dev` } });
    const team = await prisma.team.create({ data: { name: 'Acme' } });
    const prompt = await prisma.prompt.create({ data: { teamId: team.id, name: 'greeting', createdBy: user.id } });
    const version = await prisma.promptVersion.create({
      data: { promptId: prompt.id, versionNumber: 1, messages: [], createdBy: user.id },
    });
    const ctx = { ...baseCtx, promptVersionId: version.id };
    expect(await matchesFilter({ promptId: prompt.id }, ctx)).toBe(true);
    expect(await matchesFilter({ promptId: randomUUID() }, ctx)).toBe(false);
  });

  it('promptAlias matches only when the alias currently points at the span\'s version', async () => {
    const user = await prisma.user.create({ data: { email: `${randomUUID()}@test.dev` } });
    const team = await prisma.team.create({ data: { name: 'Acme' } });
    const prompt = await prisma.prompt.create({ data: { teamId: team.id, name: 'greeting', createdBy: user.id } });
    const v1 = await prisma.promptVersion.create({
      data: { promptId: prompt.id, versionNumber: 1, messages: [], createdBy: user.id },
    });
    const v2 = await prisma.promptVersion.create({
      data: { promptId: prompt.id, versionNumber: 2, messages: [], createdBy: user.id },
    });
    await prisma.promptAlias.create({ data: { promptId: prompt.id, alias: 'production', versionId: v1.id } });

    expect(await matchesFilter({ promptAlias: 'production' }, { ...baseCtx, promptVersionId: v1.id })).toBe(true);
    expect(await matchesFilter({ promptAlias: 'production' }, { ...baseCtx, promptVersionId: v2.id })).toBe(false);
    expect(await matchesFilter({ promptAlias: 'staging' }, { ...baseCtx, promptVersionId: v1.id })).toBe(false);
  });
});
