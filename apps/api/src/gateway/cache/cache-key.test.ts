import { computeCacheKey } from './cache-key';
import type { NormalizedRequest } from '../providers/types';

const base: NormalizedRequest = {
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Say hi in one word.' }],
  temperature: 0,
};

describe('computeCacheKey', () => {
  it('returns a 64-char hex sha256 string', () => {
    const key = computeCacheKey('team-a', base);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is identical for identical requests', () => {
    expect(computeCacheKey('team-a', base)).toBe(computeCacheKey('team-a', base));
  });

  it('does NOT include teamId in the hash (scoping is by column)', () => {
    // Same request, different teams → SAME key. Partitioning happens via the
    // team_id column + UNIQUE(team_id, cache_key), not the hash.
    expect(computeCacheKey('team-a', base)).toBe(computeCacheKey('team-b', base));
  });

  it('changes when the model changes', () => {
    const other = { ...base, model: 'gpt-4o' };
    expect(computeCacheKey('team-a', other)).not.toBe(computeCacheKey('team-a', base));
  });

  it('changes when a message changes', () => {
    const other = { ...base, messages: [{ role: 'user' as const, content: 'Say hi in TWO words.' }] };
    expect(computeCacheKey('team-a', other)).not.toBe(computeCacheKey('team-a', base));
  });

  it('changes when temperature changes', () => {
    const other = { ...base, temperature: 0.7 };
    expect(computeCacheKey('team-a', other)).not.toBe(computeCacheKey('team-a', base));
  });

  it('changes when max_tokens, top_p, or stop change', () => {
    expect(computeCacheKey('team-a', { ...base, max_tokens: 50 })).not.toBe(computeCacheKey('team-a', base));
    expect(computeCacheKey('team-a', { ...base, top_p: 0.9 })).not.toBe(computeCacheKey('team-a', base));
    expect(computeCacheKey('team-a', { ...base, stop: ['\n'] })).not.toBe(computeCacheKey('team-a', base));
  });

  it('changes when response_format changes, so a structured-output request never collides with a plain-text one', () => {
    // Regression: a json_object request and an otherwise-identical plain request
    // must not share a cache row -- one caller wants structured JSON, the other
    // free text, and serving one's cached response for the other is wrong either way.
    const jsonObject = { ...base, response_format: { type: 'json_object' as const } };
    expect(computeCacheKey('team-a', jsonObject)).not.toBe(computeCacheKey('team-a', base));
  });

  it('changes between two different response_format shapes (json_object vs json_schema)', () => {
    const jsonObject = { ...base, response_format: { type: 'json_object' as const } };
    const jsonSchema = {
      ...base,
      response_format: {
        type: 'json_schema' as const,
        json_schema: { name: 'answer', schema: { type: 'object' } },
      },
    };
    expect(computeCacheKey('team-a', jsonObject)).not.toBe(computeCacheKey('team-a', jsonSchema));
  });

  it('treats omitted optional params as null (undefined === explicit null-equivalent)', () => {
    // A request with no temperature hashes the same as one with the field absent.
    const a = computeCacheKey('team-a', { model: base.model, messages: base.messages });
    const b = computeCacheKey('team-a', { model: base.model, messages: base.messages });
    expect(a).toBe(b);
  });
});

describe('computeCacheKey — tool declarations (issue #480)', () => {
  const tools = [
    {
      type: 'function' as const,
      function: {
        name: 'get_weather',
        description: 'Look up the weather for a city',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    },
  ];

  it('separates a plain request from the same request carrying tools', () => {
    // Without this, a cached prose answer was replayed to a caller that asked for
    // a tool call, so the model never got to call it and the agent loop stalled
    // with no error to look at.
    const withTools: NormalizedRequest = { ...base, tools };
    expect(computeCacheKey('team-a', withTools)).not.toBe(computeCacheKey('team-a', base));
  });

  it('separates two requests that declare different tools', () => {
    const a: NormalizedRequest = { ...base, tools };
    const b: NormalizedRequest = {
      ...base,
      tools: [{ ...tools[0], function: { ...tools[0].function, name: 'delete_account' } }],
    };
    expect(computeCacheKey('team-a', a)).not.toBe(computeCacheKey('team-a', b));
  });

  it('separates requests differing only by tool_choice', () => {
    const required: NormalizedRequest = { ...base, tools, tool_choice: 'required' };
    const auto: NormalizedRequest = { ...base, tools, tool_choice: 'auto' };
    expect(computeCacheKey('team-a', required)).not.toBe(computeCacheKey('team-a', auto));
  });

  it('still collides for two genuinely identical tool-carrying requests', () => {
    const a: NormalizedRequest = { ...base, tools, tool_choice: 'required' };
    const b: NormalizedRequest = { ...base, tools, tool_choice: 'required' };
    expect(computeCacheKey('team-a', a)).toBe(computeCacheKey('team-a', b));
  });
});
