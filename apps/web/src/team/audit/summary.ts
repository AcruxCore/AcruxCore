import type { AuditEntry } from '@/api';

/**
 * Turns one audit row's stored `metadata` into a short readable phrase for the
 * table's Detail column.
 *
 * `metadata` is free-form JSON written by whichever service raised the event, so
 * every field is read defensively and an unrecognised shape returns null rather
 * than printing `[object Object]`. Where the payload holds only an opaque id
 * (`secret_rotated`, `api_key_revoked`), that is all there is to say — the
 * matching create event above it in the trail carries the name.
 *
 * @param entry - The audit row, including its resolved `target` where present.
 * @returns A one-line detail, or null when the row has nothing to add.
 */
export function auditSummary(entry: AuditEntry): string | null {
  const m = entry.metadata ?? {};
  const str = (k: string): string | null => (typeof m[k] === 'string' ? (m[k] as string) : null);
  const num = (k: string): number | null => (typeof m[k] === 'number' ? (m[k] as number) : null);

  switch (entry.event) {
    // ── Prompts ─────────────────────────────────────────────────────────────
    case 'prompt_created':
    case 'prompt_deleted':
      return str('name');
    case 'prompt_renamed': {
      const from = str('old_name');
      const to = str('new_name');
      return from && to ? `${from} → ${to}` : (to ?? null);
    }
    case 'prompt_updated':
      return str('field');
    case 'version_committed': {
      const v = num('versionNumber');
      return v === null ? null : `v${v}`;
    }
    case 'alias_promoted':
    case 'tool_alias_promoted':
      return versionMove(str('alias'), num('fromVersionNumber'), num('toVersionNumber'));
    case 'alias_deleted':
      return str('alias');

    // ── Tools ───────────────────────────────────────────────────────────────
    case 'tool_created':
      return m.updated === true ? `${str('name') ?? 'tool'} · updated` : str('name');
    case 'tool_version_committed': {
      const v = num('versionNumber');
      const via = str('via');
      return join([v === null ? null : `v${v}`, via === 'sync' ? 'via code sync' : null]);
    }
    case 'tool_version_superseded':
      return join([
        str('toolName'),
        versionMove(str('alias'), num('supersededVersionNumber'), num('newVersionNumber')),
      ]);
    case 'prompt_tool_route_set':
      return join([
        str('toolName'),
        str('promptAlias') ? `alias "${str('promptAlias')}"` : 'default alias',
        m.off === true ? 'excluded' : m.pinned === true ? 'pinned' : (str('toToolAlias') ?? null),
      ]);
    case 'prompt_tool_route_removed':
      if (m.reset === true) {
        const n = num('removedCount');
        return join([
          str('promptAlias') ? `alias "${str('promptAlias')}" reset` : 'reset to default',
          n === null ? null : `${n} binding${n === 1 ? '' : 's'} dropped`,
        ]);
      }
      return join([str('promptAlias') ? `alias "${str('promptAlias')}"` : 'default alias', str('fromToolAlias')]);

    // ── Members & invites ───────────────────────────────────────────────────
    case 'member_invited':
      return join([str('role'), m.emailed === true ? 'emailed' : 'link only']);
    case 'member_joined':
      return str('role');
    case 'member_role_updated':
      return join([entry.target?.email ?? null, str('role') ? `now ${str('role')}` : null]);
    case 'member_removed':
      return entry.target?.email ?? null;
    case 'member_invite_revoked':
      return null;

    // ── API keys ────────────────────────────────────────────────────────────
    case 'api_key_generated':
      return str('name');
    case 'api_key_revoked':
      return null;

    // ── Gateway ─────────────────────────────────────────────────────────────
    case 'provider_connection_created':
      return join([str('provider'), str('label')]);
    case 'provider_connection_updated':
      return m.rotatedKey === true ? 'key rotated' : 'settings changed';
    case 'provider_connection_deleted':
      return str('provider');
    case 'virtual_key_created': {
      const models = Array.isArray(m.allowedModels) ? (m.allowedModels as unknown[]) : [];
      return join([
        str('name'),
        models.length > 0 ? `${models.length} model${models.length === 1 ? '' : 's'}` : 'all models',
      ]);
    }
    case 'virtual_key_revoked':
      return null;
    case 'budget_created':
      return join([str('scope'), str('period'), usd(num('limitUsd'))]);
    case 'budget_updated':
      return usd(num('limitUsd'));
    case 'gateway_model_created':
      return join([str('publicName'), str('upstreamModel') ? `→ ${str('upstreamModel')}` : null]);
    case 'gateway_model_updated':
    case 'gateway_model_deleted':
      return str('publicName');

    // ── Secrets ─────────────────────────────────────────────────────────────
    case 'secret_created':
    case 'secret_deleted':
      return str('name');
    case 'secret_rotated':
      return null;

    // ── Evaluations ─────────────────────────────────────────────────────────
    case 'dataset_created':
    case 'dataset_deleted':
      // Recorded on the row rather than looked up: a deleted dataset is filtered
      // out of every list, so this is the only place the name survives.
      return str('name');
    case 'eval_rule_created':
      return join([str('name'), str('judgeModel') ? `judged by ${str('judgeModel')}` : null]);
    case 'eval_rule_updated': {
      const changed = Array.isArray(m.changed) ? (m.changed as unknown[]).filter((c) => typeof c === 'string') : [];
      // `enabled` is called out by name because it is the field that starts and
      // stops the spend; the rest are listed as the fields that were touched.
      const state = typeof m.enabled === 'boolean' ? (m.enabled ? 'enabled' : 'disabled') : null;
      const rest = (changed as string[]).filter((c) => c !== 'enabled');
      return join([str('name'), state, rest.length > 0 ? `${rest.join(', ')} changed` : null]);
    }
    case 'eval_rule_deleted':
      return str('name');

    // ── Settings ────────────────────────────────────────────────────────────
    case 'trace_settings_updated':
      if (typeof m.capturePayloads === 'boolean') {
        return `payload capture ${m.capturePayloads ? 'on' : 'off'}`;
      }
      return null;

    default:
      return null;
  }
}

/** `alias · v2 → v3`, dropping whichever half the payload is missing. */
function versionMove(alias: string | null, from: number | null, to: number | null): string | null {
  const move = from !== null && to !== null ? `v${from} → v${to}` : to !== null ? `→ v${to}` : null;
  return join([alias, move]);
}

/** `$12.50` from a dollar amount, or null. */
function usd(amount: number | null): string | null {
  return amount === null ? null : `$${amount.toFixed(2)}`;
}

/** Joins the non-empty parts with a middot, or null when nothing survives. */
function join(parts: (string | null)[]): string | null {
  const kept = parts.filter((p): p is string => !!p);
  return kept.length > 0 ? kept.join(' · ') : null;
}
