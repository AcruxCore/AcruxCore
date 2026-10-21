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

describe('gateway tools name the trace id in their summary line', () => {
  // The result carries a request id and a trace id, both UUIDs. With only the request id
  // reachable by eye, an agent passed it to get_trace and got a bare 404.
  it('run_prompt: the summary names the trace id, and get_trace opens it', async () => {
    await callTool(harness.client, 'create_prompt', { name: 'ping' });
    await callTool(harness.client, 'commit_prompt_version', {
      prompt: 'ping',
      model: 'fake-model',
      messages: [{ role: 'user', content: 'ping' }],
    });

    const text = await callTool(harness.client, 'run_prompt', { prompt: 'ping' });
    const { gateway } = payloadOf<{ gateway: Record<string, string> }>(text);

    expect(gateway['trace-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(summaryOf(text)).toContain(`trace_id ${gateway['trace-id']}`);
    expect(summaryOf(text)).not.toContain(gateway['request-id']);

    const trace = await callTool(harness.client, 'get_trace', { trace_id: gateway['trace-id'] });
    expect(trace).toContain(gateway['trace-id']);
  });

  it('chat_completion: the summary names the trace id', async () => {
    const text = await callTool(harness.client, 'chat_completion', {
      model: 'fake-model',
      messages: [{ role: 'user', content: 'ping' }],
    });
    const { gateway } = payloadOf<{ gateway: Record<string, string> }>(text);

    expect(summaryOf(text)).toContain(`trace_id ${gateway['trace-id']}`);
  });
});
