import http from 'node:http';
import type { AddressInfo } from 'node:net';
import prisma from '../../../../apps/api/src/shared/db/client';
import { resetAuthTables } from '../../../../apps/api/src/test-utils/reset-db';
import {
  allowLoopbackForTests,
  resetSsrfAllowlist,
} from '../../../../apps/api/src/tools/execute/safe-fetch';
import { callTool, payloadOf, rest, startHarness, type Harness } from './harness';

/** A stand-in for the paid model provider — the one outbound call tests may fake. */
let provider: http.Server;
let providerUrl: string;
let harness: Harness;

beforeAll(async () => {
  allowLoopbackForTests();
  provider = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'gen-1',
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, resolve));
  // `localhost`, not 127.0.0.1: the connection schema refuses a literal loopback IP.
  providerUrl = `http://localhost:${(provider.address() as AddressInfo).port}/v1`;
});

beforeEach(async () => {
  await resetAuthTables();
  harness = await startHarness();
  const connection = await rest<{ id: string }>(harness, 'POST', '/gateway/connections', {
    provider: 'openai_compatible',
    label: 'fake',
    apiKey: 'sk-fake-00000000000AB12',
    config: { base_url: providerUrl },
  });
  await rest(harness, 'POST', '/gateway/models', {
    publicName: 'fake-model',
    upstreamModel: 'fake-upstream',
    credentialId: connection.id,
    inputPricePerM: 1,
    outputPricePerM: 1,
  });
});

afterEach(async () => {
  await harness?.close();
});

afterAll(async () => {
  resetSsrfAllowlist();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await prisma.$disconnect();
});

/** The first line of a tool result: what a client reads before it parses any JSON. */
function summaryOf(text: string): string {
  return text.split('\n\n')[0];
}

describe('get_spending_limits', () => {
  // The gateway refuses a call with 402 once a budget is spent. Without this tool an MCP
  // client could see the refusal but not which limit caused it or when it resets.
  it('reports each budget with live spend, the key it belongs to, and no key secret', async () => {
    const key = await rest<{ id: string; key: string }>(harness, 'POST', '/gateway/keys', {
      name: 'ci-bot',
      maxRpm: 60,
    });
    await rest(harness, 'POST', '/gateway/budgets', { period: 'month', limitUsd: 10 });
    await rest(harness, 'POST', '/gateway/budgets', {
      virtualKeyId: key.id,
      period: 'day',
      limitUsd: 2,
    });
    await callTool(harness.client, 'chat_completion', {
      model: 'fake-model',
      messages: [{ role: 'user', content: 'ping' }],
    });

    const text = await callTool(harness.client, 'get_spending_limits');
    const payload = payloadOf<{
      budgets: Array<{
        scope: string;
        virtualKeyName: string | null;
        period: string;
        limitUsd: number;
        spendUsd: number;
        remainingUsd: number;
        exhausted: boolean;
      }>;
      virtualKeys: Array<{ name: string; maxRpm: number | null }>;
    }>(text);

    const team = payload.budgets.find((b) => b.scope === 'team')!;
    expect(team).toMatchObject({ period: 'month', limitUsd: 10, exhausted: false });
    expect(team.spendUsd).toBeGreaterThan(0);
    expect(team.remainingUsd).toBeCloseTo(10 - team.spendUsd, 10);

    const perKey = payload.budgets.find((b) => b.scope === 'virtual_key')!;
    expect(perKey).toMatchObject({ virtualKeyName: 'ci-bot', period: 'day', limitUsd: 2, spendUsd: 0 });

    expect(payload.virtualKeys).toEqual([expect.objectContaining({ name: 'ci-bot', maxRpm: 60 })]);
    expect(summaryOf(text)).toContain('2 budget(s)');
    expect(summaryOf(text)).toContain('"ci-bot"');
    expect(text).not.toContain(key.key);
  });

  it('says plainly when the team has no budgets', async () => {
    const text = await callTool(harness.client, 'get_spending_limits');
    expect(summaryOf(text)).toContain('No budgets');
    expect(payloadOf<{ budgets: unknown[] }>(text).budgets).toEqual([]);
  });

  it('is offered in read-only mode', async () => {
    const readOnly = await startHarness({ readOnly: true });
    try {
      const { tools } = await readOnly.client.listTools();
      expect(tools.map((t) => t.name)).toContain('get_spending_limits');
    } finally {
      await readOnly.close();
    }
  });
});
