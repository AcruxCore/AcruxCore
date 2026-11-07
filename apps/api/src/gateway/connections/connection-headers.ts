import { ConnectionHeaderNameSchema, ConnectionHeaderValueSchema } from './connections.types';

/**
 * Reads the headers to send off a stored connection config (issue #790).
 *
 * Each entry is checked against today's rules on its own, and a failing entry is dropped
 * alone with a warning. A rule tightened after a connection was saved (a newly denied
 * name, say) must not silently strip the headers that are still valid: a provider such as
 * OpenCode Go refuses every call without its session header.
 *
 * @param config - A connection's `config` column (Prisma `JsonValue`).
 * @param connectionId - Named in the warning, so an operator can find the row.
 * @returns The valid headers, or `undefined` when none are set, none are valid, or the
 *   stored value is not an object (a row written before this setting existed).
 */
export function connectionHeaders(config: unknown, connectionId?: string): Record<string, string> | undefined {
  const raw = (config ?? {}) as Record<string, unknown>;
  const stored = raw['headers'];
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return undefined;

  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(stored as Record<string, unknown>)) {
    const valid =
      ConnectionHeaderNameSchema.safeParse(name).success &&
      ConnectionHeaderValueSchema.safeParse(value).success &&
      !seen.has(name.toLowerCase());
    if (!valid) {
      console.warn(
        `[gateway] connection ${connectionId ?? '(unknown)'}: not sending stored header ${JSON.stringify(name)}, ` +
          'which the connection-header rules now refuse. Edit the connection to remove it.',
      );
      continue;
    }
    seen.add(name.toLowerCase());
    headers[name] = value as string;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}
