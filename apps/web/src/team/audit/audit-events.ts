/**
 * The audit-event catalogue the team-wide screen reads from: a human label and a
 * category for every `AuditEvent` the API can write.
 *
 * Grouping lives here, in the dashboard, rather than in the API. The API takes a
 * flat list of event names (`?event=a,b,c`) and knows nothing about categories,
 * so a category is just a saved list — which keeps the endpoint stable if the
 * grouping is later re-cut for readability.
 */

/** A category shown as one option in the event filter. */
export interface AuditEventGroup {
  /** Stable slug, used in the `group` URL param. */
  id: string;
  label: string;
  /** Every `AuditEvent` name in this category. */
  events: string[];
}

/**
 * Every event group, in the order the filter lists them. Prompts and tools come
 * first because they are the most common events; settings last because it holds one.
 */
export const AUDIT_EVENT_GROUPS: AuditEventGroup[] = [
  {
    id: 'prompts',
    label: 'Prompts',
    events: [
      'prompt_created',
      'prompt_renamed',
      'prompt_updated',
      'prompt_deleted',
      'version_committed',
      'alias_promoted',
      'alias_deleted',
    ],
  },
  {
    id: 'tools',
    label: 'Tools',
    events: [
      'tool_created',
      'tool_version_committed',
      'tool_alias_promoted',
      'tool_version_superseded',
      'prompt_tool_route_set',
      'prompt_tool_route_removed',
    ],
  },
  {
    id: 'members',
    label: 'Members & invites',
    events: [
      'member_invited',
      'member_joined',
      'member_role_updated',
      'member_removed',
      'member_invite_revoked',
    ],
  },
  {
    id: 'keys',
    label: 'API keys',
    events: ['api_key_generated', 'api_key_revoked'],
  },
  {
    id: 'gateway',
    label: 'Gateway',
    events: [
      'provider_connection_created',
      'provider_connection_updated',
      'provider_connection_deleted',
      'virtual_key_created',
      'virtual_key_revoked',
      'budget_created',
      'budget_updated',
      'gateway_model_created',
      'gateway_model_updated',
      'gateway_model_deleted',
    ],
  },
  {
    id: 'secrets',
    label: 'Secrets',
    events: ['secret_created', 'secret_rotated', 'secret_deleted'],
  },
  {
    id: 'settings',
    label: 'Settings',
    events: ['trace_settings_updated'],
  },
];

/**
 * Sentence-case label per event name. The stored name is snake_case and reads as
 * a database value; these are what the table shows.
 */
export const AUDIT_EVENT_LABELS: Record<string, string> = {
  prompt_created: 'Prompt created',
  prompt_renamed: 'Prompt renamed',
  prompt_updated: 'Prompt updated',
  prompt_deleted: 'Prompt deleted',
  version_committed: 'Version committed',
  alias_promoted: 'Alias promoted',
  alias_deleted: 'Alias deleted',

  tool_created: 'Tool created',
  tool_version_committed: 'Tool version committed',
  tool_alias_promoted: 'Tool alias promoted',
  tool_version_superseded: 'Tool version superseded',
  prompt_tool_route_set: 'Prompt tool binding set',
  prompt_tool_route_removed: 'Prompt tool binding removed',

  member_invited: 'Member invited',
  member_joined: 'Member joined',
  member_role_updated: 'Role changed',
  member_removed: 'Member removed',
  member_invite_revoked: 'Invite revoked',

  api_key_generated: 'API key generated',
  api_key_revoked: 'API key revoked',

  provider_connection_created: 'Provider credential added',
  provider_connection_updated: 'Provider credential updated',
  provider_connection_deleted: 'Provider credential deleted',
  virtual_key_created: 'Virtual key created',
  virtual_key_revoked: 'Virtual key revoked',
  budget_created: 'Budget created',
  budget_updated: 'Budget updated',
  gateway_model_created: 'Gateway model created',
  gateway_model_updated: 'Gateway model updated',
  gateway_model_deleted: 'Gateway model deleted',

  secret_created: 'Secret created',
  secret_rotated: 'Secret rotated',
  secret_deleted: 'Secret deleted',

  trace_settings_updated: 'Trace settings updated',
};

/** Every known event name, flattened — the option list for the per-event filter. */
export const ALL_AUDIT_EVENTS: string[] = AUDIT_EVENT_GROUPS.flatMap((g) => g.events);

/** Group id for each event name, derived once from {@link AUDIT_EVENT_GROUPS}. */
const GROUP_BY_EVENT: Record<string, string> = Object.fromEntries(
  AUDIT_EVENT_GROUPS.flatMap((g) => g.events.map((e) => [e, g.id])),
);

/**
 * The display label for an event name, falling back to the raw name so an event
 * added to the API before this table is updated still renders something.
 *
 * @param event - The stored `AuditEvent` name.
 * @returns A sentence-case label, or the raw name if unknown here.
 */
export function eventLabel(event: string): string {
  return AUDIT_EVENT_LABELS[event] ?? event;
}

/**
 * The group label for an event name, for the table's Area column.
 *
 * @param event - The stored `AuditEvent` name.
 * @returns The group's label, or 'Other' for an event this table does not know.
 */
export function eventGroupLabel(event: string): string {
  const id = GROUP_BY_EVENT[event];
  return AUDIT_EVENT_GROUPS.find((g) => g.id === id)?.label ?? 'Other';
}

/**
 * Resolves the two filter controls into the flat event-name list the API takes.
 *
 * The specific choice wins: naming events narrows to exactly those, and the area
 * selection only widens when no individual event is named. Unioning the two
 * instead would make picking one event inside a chosen area return that whole
 * area — the opposite of what adding a filter should do.
 *
 * @param groupIds - Selected group slugs.
 * @param events - Individually selected event names.
 * @returns Every event name to filter by; empty means "no filter".
 */
export function toEventNames(groupIds: string[], events: string[]): string[] {
  if (events.length > 0) return [...new Set(events)];

  const names = new Set<string>();
  for (const id of groupIds) {
    const group = AUDIT_EVENT_GROUPS.find((g) => g.id === id);
    group?.events.forEach((e) => names.add(e));
  }
  return [...names];
}

/**
 * The event names selectable given the chosen areas — every known event when no
 * area is chosen. Keeps the Event picker from offering a value that the Area
 * picker has already ruled out.
 *
 * @param groupIds - Selected group slugs.
 * @returns Event names in catalogue order.
 */
export function eventsInGroups(groupIds: string[]): string[] {
  if (groupIds.length === 0) return ALL_AUDIT_EVENTS;
  return AUDIT_EVENT_GROUPS.filter((g) => groupIds.includes(g.id)).flatMap((g) => g.events);
}

