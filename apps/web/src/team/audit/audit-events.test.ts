import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALL_AUDIT_EVENTS, AUDIT_EVENT_LABELS, eventGroupLabel } from './audit-events';

/**
 * This catalogue is a hand-kept copy of the API's `AuditEvent` enum, and nothing
 * connects the two: an event added to the enum and written by a service still
 * renders here, just with a raw snake_case name under a blank Area. That is how
 * five evaluation events would have landed (issue #508) had the enum been
 * extended without this file.
 *
 * So the test reads the enum from `schema.prisma` — the source of truth named in
 * CLAUDE.md — and requires the catalogue to cover it. Adding an event to the API
 * now fails here until the dashboard knows what to call it.
 */
const SCHEMA = fileURLToPath(new URL('../../../../api/prisma/schema.prisma', import.meta.url));

/** Every value of the `AuditEvent` enum, read from the Prisma schema. */
function auditEventsInSchema(): string[] {
  const body = /enum AuditEvent \{([^}]*)\}/.exec(readFileSync(SCHEMA, 'utf8'))?.[1];
  if (body === undefined) throw new Error(`No AuditEvent enum found in ${SCHEMA}`);
  return body
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => line.length > 0);
}

describe('the audit-event catalogue tracks the API enum', () => {
  it('finds the enum at all, so a rename cannot make this suite vacuous', () => {
    const events = auditEventsInSchema();
    expect(events.length).toBeGreaterThan(30);
    expect(events).toContain('prompt_created');
  });

  it('gives every API event an area and a label', () => {
    const missing = auditEventsInSchema().filter((e) => !ALL_AUDIT_EVENTS.includes(e));
    expect(missing).toEqual([]);

    const unlabelled = auditEventsInSchema().filter((e) => AUDIT_EVENT_LABELS[e] === undefined);
    expect(unlabelled).toEqual([]);
  });

  it('lists no event the API cannot write', () => {
    const inSchema = new Set(auditEventsInSchema());
    expect(ALL_AUDIT_EVENTS.filter((e) => !inSchema.has(e))).toEqual([]);
  });

  it('files the evaluation events under Evaluations rather than Other', () => {
    expect(eventGroupLabel('dataset_deleted')).toBe('Evaluations');
    expect(eventGroupLabel('eval_rule_created')).toBe('Evaluations');
  });
});
