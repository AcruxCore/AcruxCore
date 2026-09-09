import type { AuditActor } from '@/api';
import { Button, MultiSelect, Select } from '@/ui';
import { AUDIT_EVENT_GROUPS, eventLabel, eventsInGroups } from './audit-events';

export interface AuditFilterValue {
  /** Selected group slugs — each expands to its whole event list. */
  groups: string[];
  /** Individually selected event names. */
  events: string[];
  /** Selected actor id, or '' for everyone. */
  actorId: string;
}

export interface AuditFilterBarProps {
  value: AuditFilterValue;
  onChange: (next: AuditFilterValue) => void;
  /** Everyone who appears in the trail, for the actor picker. */
  actors: AuditActor[];
  /** How many events match the current filter, for the count line. */
  total: number;
  /** True while the actor list is still loading, to keep the picker honest. */
  actorsLoading?: boolean;
}

/**
 * Filter row for the team audit trail: area, event and actor, plus a clear.
 *
 * Area and event are separate controls rather than one flat list of 34 names.
 * "Who touched the gateway last week" is an area question, and "who revoked that
 * key" is a single-event question — collapsing both into one dropdown makes the
 * common case a scroll through 34 rows.
 *
 * Choosing an area narrows what the Event picker offers, and any event already
 * chosen outside the new area is dropped — so the two controls can never show a
 * combination that returns nothing.
 */
export function AuditFilterBar({ value, onChange, actors, total, actorsLoading }: AuditFilterBarProps) {
  const isFiltered = value.groups.length > 0 || value.events.length > 0 || value.actorId !== '';

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">Area</span>
          <MultiSelect
            options={AUDIT_EVENT_GROUPS.map((g) => ({ value: g.id, label: g.label }))}
            value={value.groups}
            onChange={(groups) => {
              const allowed = new Set(eventsInGroups(groups));
              onChange({ ...value, groups, events: value.events.filter((e) => allowed.has(e)) });
            }}
            placeholder="Every area"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">Event</span>
          <MultiSelect
            options={eventsInGroups(value.groups).map((e) => ({ value: e, label: eventLabel(e) }))}
            value={value.events}
            onChange={(events) => onChange({ ...value, events })}
            placeholder={value.groups.length > 0 ? "Every event in these areas" : "Every event"}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">Actor</span>
          <Select
            value={value.actorId}
            onChange={(e) => onChange({ ...value, actorId: e.target.value })}
            aria-label="Filter by actor"
          >
            <option value="">{actorsLoading ? 'Loading people…' : 'Everyone'}</option>
            {actors.map((a) => (
              <option key={a.id} value={a.id}>
                {a.email} ({a.eventCount})
              </option>
            ))}
          </Select>
        </label>
      </div>

      <div className="flex items-center gap-3 text-[12px] text-muted">
        <span>
          {total.toLocaleString()} event{total === 1 ? '' : 's'}
          {isFiltered ? ' match these filters' : ' recorded'}
        </span>
        {isFiltered && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onChange({ groups: [], events: [], actorId: '' })}
          >
            Clear filters
          </Button>
        )}
      </div>
    </div>
  );
}
