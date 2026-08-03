import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { GatewayRepository } from './gateway.repository';
import { signupTestUser } from '../../test-utils';

const app = createApp();
const repo = new GatewayRepository();

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE gateway_requests, provider_connections, prompt_aliases, prompt_versions, audit_log, prompts, api_keys, team_members, teams, users RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GatewayRepository.recordRequest', () => {
  it('inserts a gateway_requests row and returns it', async () => {
    const { teamId } = await signupTestUser(app);

    const row = await repo.recordRequest({
      teamId,
      provider: 'openai',
      requestedModel: 'gpt-4o-mini',
      resolvedModel: 'gpt-4o-mini',
      status: 'success',
      promptTokens: 12,
      completionTokens: 1,
      totalTokens: 13,
      costUsd: 0.0000024,
      latencyMs: 42,
      cacheHit: false,
    });

    expect(row.id).toBeDefined();
    expect(row.status).toBe('success');
    expect(row.promptTokens).toBe(12);
    expect(Number(row.costUsd)).toBeCloseTo(0.0000024, 9);
    expect(row.virtualKeyId).toBeNull();

    const dbRow = await prisma.gatewayRequest.findUnique({ where: { id: row.id } });
    expect(dbRow?.teamId).toBe(teamId);
    expect(dbRow?.totalTokens).toBe(13);
  });

  it('records an error row with null-defaulting optionals', async () => {
    const { teamId } = await signupTestUser(app);

    const row = await repo.recordRequest({
      teamId,
      provider: 'openai',
      requestedModel: 'gpt-4o',
      status: 'error',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      latencyMs: 5,
      cacheHit: false,
      errorCode: '500',
    });

    expect(row.status).toBe('error');
    expect(row.errorCode).toBe('500');
    expect(row.resolvedModel).toBeNull();
  });
});

describe('GatewayRepository.findById', () => {
  it('returns the row when it exists', async () => {
    const { teamId } = await signupTestUser(app);
    const created = await repo.recordRequest({
      teamId,
      provider: 'openai',
      requestedModel: 'gpt-4o-mini',
      resolvedModel: 'gpt-4o-mini',
      status: 'success',
      promptTokens: 12,
      completionTokens: 1,
      totalTokens: 13,
      costUsd: 0.0000024,
      latencyMs: 42,
      cacheHit: false,
    });

    const found = await repo.findById(created.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(created.id);
    expect(found?.teamId).toBe(teamId);
    expect(found?.totalTokens).toBe(13);
  });

  it('returns null when the row does not exist', async () => {
    const found = await repo.findById('99999999-9999-9999-9999-999999999999');
    expect(found).toBeNull();
  });

  it('reads inside a supplied transaction client', async () => {
    const { teamId } = await signupTestUser(app);
    const created = await repo.recordRequest({
      teamId,
      provider: 'openai',
      requestedModel: 'gpt-4o',
      status: 'error',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      latencyMs: 5,
      cacheHit: false,
      errorCode: '500',
    });

    const found = await prisma.$transaction(async (tx) => repo.findById(created.id, tx));
    expect(found?.id).toBe(created.id);
    expect(found?.status).toBe('error');
  });
});
