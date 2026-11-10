import type request from 'supertest';
import { randomUUID } from 'node:crypto';
import { lookupDefaultPricing } from '../gateway/providers/models';

/**
 * The static registry's input and output price for an upstream model, as a body
 * fragment for `POST /gateway/models`, or `{}` when the registry does not know it.
 *
 * The API stores an omitted price as null (cross-cutting FAQ Q160), so a test that
 * asserts a cost or a budget increment must send prices itself. Spreading this keeps
 * those tests on the same numbers they used when the API filled them in.
 *
 * @param upstreamModel - The upstream id being registered.
 */
export function registryPrices(upstreamModel: string): { inputPricePerM?: number; outputPricePerM?: number } {
  return lookupDefaultPricing(upstreamModel) ?? {};
}

/**
 * Registers a real gateway connection + model for the given agent's team, via
 * the actual API endpoints (not a direct DB insert) — every online-eval-rule
 * test needs one now that `judgeModel` must resolve to a real registered
 * model (phase-5-faq).
 *
 * @param agent - A pre-authenticated supertest agent (see {@link authedAgent}).
 * @param publicName - Defaults to a unique name so parallel calls in the same
 *   test file (different teams) never collide on the team-scoped uniqueness constraint.
 * @returns The model's `publicName`, ready to pass as `judgeModel`.
 */
export async function registerTestModel(
  agent: ReturnType<typeof request.agent>,
  publicName: string = `gpt-4o-mini-${randomUUID()}`,
): Promise<string> {
  const conn = await agent
    .post('/api/v1/gateway/connections')
    .send({ provider: 'openai', label: 'openai test', apiKey: 'sk-test-abcdAB12', config: {} })
    .expect(201);
  await agent
    .post('/api/v1/gateway/models')
    .send({ publicName, upstreamModel: 'gpt-4o-mini', credentialId: conn.body.id })
    .expect(201);
  return publicName;
}
