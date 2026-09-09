import { describe, expect, it } from 'vitest';
import type { AuditEntry } from '@/api';
import { auditSummary } from './summary';
import {
  ALL_AUDIT_EVENTS,
  AUDIT_EVENT_LABELS,
  eventGroupLabel,
  eventLabel,
  eventsInGroups,
  toEventNames,
} from './audit-events';

function entry(event: string, metadata: Record<string, unknown> | null, extra: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: 'e1',
    event,
    actor: { id: 'u1', email: 'someone@example.com' },
    metadata,
    createdAt: '2026-09-09T10:00:00.000Z',
    ...extra,
  };
}

describe('auditSummary', () => {
  it('names the prompt on create and delete', () => {
    expect(auditSummary(entry('prompt_created', { name: 'greet' }))).toBe('greet');
    expect(auditSummary(entry('prompt_deleted', { name: 'greet' }))).toBe('greet');
  });

  it('shows both sides of a rename, and just the new name when the old is missing', () => {
    expect(auditSummary(entry('prompt_renamed', { old_name: 'a', new_name: 'b' }))).toBe('a → b');
    expect(auditSummary(entry('prompt_renamed', { new_name: 'b' }))).toBe('b');
  });

  it('shows an alias promotion as a version move', () => {
    expect(auditSummary(entry('alias_promoted', { alias: 'production', fromVersionNumber: 2, toVersionNumber: 3 })))
      .toBe('production · v2 → v3');
    // First promotion: there is no previous version.
    expect(auditSummary(entry('alias_promoted', { alias: 'production', fromVersionNumber: null, toVersionNumber: 1 })))
      .toBe('production · → v1');
  });

  it('flags a tool version that came from a code sync', () => {
    expect(auditSummary(entry('tool_version_committed', { versionNumber: 3, via: 'sync' }))).toBe('v3 · via code sync');
    expect(auditSummary(entry('tool_version_committed', { versionNumber: 3 }))).toBe('v3');
  });

  it('reads a tool binding as name, alias and destination', () => {
    expect(
      auditSummary(
        entry('prompt_tool_route_set', {
          toolName: 'get_weather',
          promptAlias: 'production',
          toToolAlias: 'staging',
          pinned: false,
          off: false,
        }),
      ),
    ).toBe('get_weather · alias "production" · staging');

    expect(auditSummary(entry('prompt_tool_route_set', { toolName: 'get_weather', promptAlias: null, off: true })))
      .toBe('get_weather · default alias · excluded');
  });

  it('summarises a binding reset with how many bindings went', () => {
    expect(auditSummary(entry('prompt_tool_route_removed', { promptAlias: 'production', reset: true, removedCount: 1 })))
      .toBe('alias "production" reset · 1 binding dropped');
    expect(auditSummary(entry('prompt_tool_route_removed', { promptAlias: 'production', reset: true, removedCount: 3 })))
      .toBe('alias "production" reset · 3 bindings dropped');
  });

  it('names the affected member from the resolved target, not the raw id', () => {
    const removed = entry('member_removed', { targetUserId: 'u9' }, { target: { id: 'u9', email: 'gone@example.com' } });
    expect(auditSummary(removed)).toBe('gone@example.com');

    const rolechange = entry(
      'member_role_updated',
      { targetUserId: 'u9', role: 'admin' },
      { target: { id: 'u9', email: 'gone@example.com' } },
    );
    expect(auditSummary(rolechange)).toBe('gone@example.com · now admin');
  });

  it('falls back to the role alone when no target was resolved', () => {
    expect(auditSummary(entry('member_role_updated', { targetUserId: 'u9', role: 'admin' }))).toBe('now admin');
  });

  it('says whether an invite was emailed or link-only', () => {
    expect(auditSummary(entry('member_invited', { role: 'editor', emailed: true }))).toBe('editor · emailed');
    expect(auditSummary(entry('member_invited', { role: 'editor', emailed: false }))).toBe('editor · link only');
  });

  it('formats a budget limit as dollars', () => {
    expect(auditSummary(entry('budget_created', { scope: 'team', period: 'monthly', limitUsd: 50 })))
      .toBe('team · monthly · $50.00');
    expect(auditSummary(entry('budget_updated', { limitUsd: 12.5 }))).toBe('$12.50');
  });

  it('counts a virtual key’s model allow-list, and says so when unrestricted', () => {
    expect(auditSummary(entry('virtual_key_created', { name: 'ci', allowedModels: ['gpt-4o-mini'] })))
      .toBe('ci · 1 model');
    expect(auditSummary(entry('virtual_key_created', { name: 'ci', allowedModels: [] }))).toBe('ci · all models');
  });

  it('says which way payload capture moved', () => {
    expect(auditSummary(entry('trace_settings_updated', { capturePayloads: true }))).toBe('payload capture on');
    expect(auditSummary(entry('trace_settings_updated', { capturePayloads: false }))).toBe('payload capture off');
  });

  it('returns null rather than a broken string for a null or wrong-shaped payload', () => {
    expect(auditSummary(entry('prompt_created', null))).toBeNull();
    expect(auditSummary(entry('prompt_created', { name: 42 }))).toBeNull();
    expect(auditSummary(entry('version_committed', { versionNumber: 'three' }))).toBeNull();
    expect(auditSummary(entry('some_future_event', { anything: true }))).toBeNull();
  });

  it('never throws on any known event with an empty payload', () => {
    for (const event of ALL_AUDIT_EVENTS) {
      expect(() => auditSummary(entry(event, {}))).not.toThrow();
    }
  });
});

describe('audit event catalogue', () => {
  it('labels every event it groups, and groups every event it labels', () => {
    expect([...ALL_AUDIT_EVENTS].sort()).toEqual(Object.keys(AUDIT_EVENT_LABELS).sort());
  });

  it('lists each event in exactly one group', () => {
    expect(new Set(ALL_AUDIT_EVENTS).size).toBe(ALL_AUDIT_EVENTS.length);
  });

  it('falls back to the raw name and "Other" for an event added after this table', () => {
    expect(eventLabel('brand_new_event')).toBe('brand_new_event');
    expect(eventGroupLabel('brand_new_event')).toBe('Other');
  });

  it('expands an area into its event names when no single event is named', () => {
    expect(toEventNames(['keys'], []).sort()).toEqual(['api_key_generated', 'api_key_revoked']);
    expect(toEventNames([], [])).toEqual([]);
    expect(toEventNames(['not_a_group'], [])).toEqual([]);
  });

  it('lets a named event narrow the area rather than widen back to it', () => {
    expect(toEventNames(['keys'], ['api_key_revoked'])).toEqual(['api_key_revoked']);
    expect(toEventNames([], ['api_key_revoked', 'api_key_revoked'])).toEqual(['api_key_revoked']);
  });

  it('offers only the events inside the chosen areas', () => {
    expect(eventsInGroups(['keys'])).toEqual(['api_key_generated', 'api_key_revoked']);
    expect(eventsInGroups(['keys', 'settings'])).toEqual([
      'api_key_generated',
      'api_key_revoked',
      'trace_settings_updated',
    ]);
    expect(eventsInGroups([])).toEqual(ALL_AUDIT_EVENTS);
  });
});
