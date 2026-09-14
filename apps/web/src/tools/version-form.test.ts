import { describe, expect, it } from 'vitest';
import type { ToolVersion } from '@/api';
import {
  advancedSectionOpen,
  emptyVersionForm,
  versionFormFromVersion,
  versionFormToCommit,
} from './version-form';

/** A committed http version carrying every executor field the API accepts. */
const FULL_HTTP_VERSION = {
  id: 'v-1',
  toolId: 't-1',
  versionNumber: 3,
  description: 'Look up a city’s coordinates.',
  changelog: 'v3, added the failure predicate.',
  source: 'api',
  parametersSchema: {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name.' } },
    required: ['city'],
  },
  executor: {
    type: 'http',
    url: 'https://geocode.example.com/search',
    method: 'GET',
    headers: [{ name: 'X-Key', value: '{{secret.GEO_KEY}}' }],
    query: [{ name: 'q', value: '{{arg.city}}' }],
    requestTransform: 'function transform(input) { return input; }',
    responseTransform: 'function transform(input) { return input.body; }',
    failureWhen:
      'function transform(input) { return input.body.results?.length ? null : { message: "not found" }; }',
    resultSchema: { type: 'object', properties: { lat: { type: 'number' } } },
    resultSchemaSeverity: 'error',
  },
  createdBy: 'u-1',
  createdAt: '2026-09-01T00:00:00.000Z',
} as unknown as ToolVersion;

describe('versionFormToCommit', () => {
  /**
   * The regression this file exists for. The dialog prefilled from the previous version
   * but only ever read the executor fields it rendered, so committing a new version from
   * the dashboard silently dropped `failureWhen`, `resultSchema` and its severity. The
   * tool kept working and simply stopped reporting the failures it was built to catch —
   * the worst shape a data loss can take, because nothing anywhere says it happened.
   */
  it('round-trips every executor field a committed version can hold', () => {
    const result = versionFormToCommit(versionFormFromVersion(FULL_HTTP_VERSION));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.body.executor).toEqual(FULL_HTTP_VERSION.executor);
    expect(result.body.parametersSchema).toEqual(FULL_HTTP_VERSION.parametersSchema);
    expect(result.body.description).toBe(FULL_HTTP_VERSION.description);
  });

  /**
   * A release note describes one commit. Carrying the previous one forward would make it
   * wrong on every version after the first, so prefill deliberately leaves it blank —
   * unlike `description`, which is config the model reads and must not be dropped.
   */
  it('carries the description forward but not the changelog', () => {
    const form = versionFormFromVersion(FULL_HTTP_VERSION);
    expect(form.description).toBe(FULL_HTTP_VERSION.description);
    expect(form.changelog).toBe('');
  });

  it('omits every http-only field for a client executor', () => {
    const form = { ...emptyVersionForm(), executorType: 'client' as const };
    const result = versionFormToCommit(form);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.executor).toEqual({ type: 'client' });
  });

  it('drops blank optional fields rather than sending empty strings', () => {
    const form = {
      ...emptyVersionForm(),
      executorType: 'http' as const,
      url: 'https://example.com',
      headers: [{ name: '', value: 'ignored' }],
      query: [{ name: 'q', value: '1' }],
    };
    const result = versionFormToCommit(form);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.executor).toEqual({
      type: 'http',
      url: 'https://example.com',
      method: 'GET',
      headers: [],
      query: [{ name: 'q', value: '1' }],
    });
  });

  it('reports a bad parameters schema instead of committing it', () => {
    const form = { ...emptyVersionForm(), schemaMode: 'json' as const, schemaText: '{ not json' };
    const result = versionFormToCommit(form);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe('parameters');
  });

  it('reports a bad result schema instead of committing it', () => {
    const form = {
      ...emptyVersionForm(),
      executorType: 'http' as const,
      url: 'https://example.com',
      resultSchemaText: '{ not json',
    };
    const result = versionFormToCommit(form);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe('resultSchema');
  });

  /**
   * `resultSchemaSeverity` only means something alongside a schema. Sending it alone
   * would write a key into the stored executor for a check that can never run, and
   * `POST /tools/sync` compares stored executors byte-for-byte to decide whether a spec
   * changed — so a stray key is a phantom version on the next deploy.
   */
  it('does not send a severity when there is no result schema', () => {
    const form = {
      ...emptyVersionForm(),
      executorType: 'http' as const,
      url: 'https://example.com',
      resultSchemaSeverity: 'error' as const,
    };
    const result = versionFormToCommit(form);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.executor).not.toHaveProperty('resultSchemaSeverity');
  });

  /**
   * Regression test for finding 4e. An SDK- or `sync`-authored version can carry a
   * `resultSchema` with deliberately no `resultSchemaSeverity` (`versions.types.ts`: "a
   * default would write the key into every executor ever committed"). Prefilling the form
   * from it and committing straight back with nothing touched must reproduce that same
   * shape — including the *absence* of the key — because `POST /tools/sync` fingerprints
   * the stored executor byte-for-byte; a `resultSchemaSeverity: 'warn'` this round trip
   * added on its own would make the next deploy commit a version for a tool nobody edited.
   */
  it('round-trips a resultSchema with no severity without adding one', () => {
    const sdkVersion: ToolVersion = {
      ...FULL_HTTP_VERSION,
      executor: {
        type: 'http',
        url: FULL_HTTP_VERSION.executor.url,
        method: FULL_HTTP_VERSION.executor.method,
        headers: FULL_HTTP_VERSION.executor.headers,
        query: FULL_HTTP_VERSION.executor.query,
        resultSchema: FULL_HTTP_VERSION.executor.resultSchema,
        // No `resultSchemaSeverity` — the shape `versionFormFromVersion` must not invent.
      },
    };

    const result = versionFormToCommit(versionFormFromVersion(sdkVersion));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.executor).toEqual(sdkVersion.executor);
    expect(result.body.executor).not.toHaveProperty('resultSchemaSeverity');
  });

  /**
   * The builder is the default and starts with no rows, which must still commit as a
   * valid zero-argument schema rather than as `{}`.
   */
  it('compiles an empty builder to a zero-argument object schema', () => {
    const result = versionFormToCommit(emptyVersionForm());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.parametersSchema).toEqual({ type: 'object', properties: {} });
  });
});

describe('versionFormFromVersion', () => {
  it('opens a round-trippable schema in the row builder', () => {
    const form = versionFormFromVersion(FULL_HTTP_VERSION);
    expect(form.schemaMode).toBe('builder');
    expect(form.paramRows).toEqual([
      { name: 'city', type: 'string', description: 'City name.', required: true },
    ]);
  });

  /** A schema the rows cannot express opens as JSON rather than losing detail. */
  it('falls back to raw JSON for a schema the builder cannot show', () => {
    const version = {
      ...FULL_HTTP_VERSION,
      parametersSchema: { type: 'object', properties: { n: { type: 'integer', minimum: 1 } } },
    } as unknown as ToolVersion;
    const form = versionFormFromVersion(version);
    expect(form.schemaMode).toBe('json');
    expect(JSON.parse(form.schemaText)).toEqual(version.parametersSchema);
  });
});

describe('advancedSectionOpen', () => {
  /**
   * The regression this covers. The section's open state was seeded by a `useState`
   * initializer in a dialog that stays mounted between openings, so it read the blank
   * form once and stayed shut for every version afterwards — including versions that did
   * carry a failure predicate. The dialog then offered "Show failure checks" over a tool
   * that had them, which reads as "this tool has none" and is how a dashboard commit went
   * on to drop them.
   */
  it('opens itself for a version that carries failure checks', () => {
    const withChecks = { ...emptyVersionForm(), failureWhen: 'function transform(i) { return null; }' };
    expect(advancedSectionOpen(null, withChecks)).toBe(true);
    expect(advancedSectionOpen(null, { ...emptyVersionForm(), resultSchemaText: '{}' })).toBe(true);
  });

  it('stays shut for a version with none', () => {
    expect(advancedSectionOpen(null, emptyVersionForm())).toBe(false);
  });

  it('lets the user close a section that opened itself, and open an empty one', () => {
    const withChecks = { ...emptyVersionForm(), failureWhen: 'function transform(i) { return null; }' };
    expect(advancedSectionOpen(false, withChecks)).toBe(false);
    expect(advancedSectionOpen(true, emptyVersionForm())).toBe(true);
  });

  /** Whitespace is not content — a textarea holding a newline must not force it open. */
  it('treats blank text as empty', () => {
    expect(advancedSectionOpen(null, { ...emptyVersionForm(), failureWhen: '  \n ' })).toBe(false);
  });
});
