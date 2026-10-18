import type { AcruxCoreClient } from './client';
import { AcruxCoreApiError } from './errors';

/** Matches a canonical v4-shaped UUID, which is what every AcruxCore id is. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reports whether a reference is already an id rather than a name.
 *
 * @param ref - The user-supplied reference.
 * @returns True when it looks like a UUID.
 */
export function isUuid(ref: string): boolean {
  return UUID_RE.test(ref.trim());
}

/** One entry of a `{ data: [...] }` list response with a name. */
interface NamedRow {
  id: string;
  name: string;
}

/**
 * Resolves a prompt reference — a UUID or a prompt name — to a prompt id.
 *
 * Accepting names is not a convenience, it is what makes the tools usable by a model.
 * An assistant is told "promote customer-support"; requiring the UUID first costs an
 * extra round trip and invites a hallucinated id that then 404s confusingly.
 *
 * @param client - REST client.
 * @param ref - Prompt UUID or exact prompt name.
 * @returns The prompt's UUID.
 * @throws {AcruxCoreApiError} `NOT_FOUND` when no active prompt carries that name.
 */
export async function resolvePromptRef(client: AcruxCoreClient, ref: string): Promise<string> {
  return resolveNamedRef(client, '/prompts', ref, 'prompt');
}

/**
 * Resolves a catalog-tool reference — a UUID or a tool name — to a tool id.
 *
 * @param client - REST client.
 * @param ref - Tool UUID or exact tool name.
 * @returns The tool's UUID.
 * @throws {AcruxCoreApiError} `NOT_FOUND` when no active tool carries that name.
 */
export async function resolveToolRef(client: AcruxCoreClient, ref: string): Promise<string> {
  return resolveNamedRef(client, '/tools', ref, 'tool');
}

/**
 * Shared name→id lookup for the two collections that support `?search=`.
 *
 * The search endpoint is a substring match, so the exact name is picked out of the
 * results rather than trusting the first row: searching `weather` when both
 * `get_weather` and `get_weather_forecast` exist must not silently pick one.
 *
 * @param client - REST client.
 * @param path - Collection path, e.g. `/prompts`.
 * @param ref - UUID or name.
 * @param noun - Singular noun for error messages.
 * @returns The resolved UUID.
 * @throws {AcruxCoreApiError} `NOT_FOUND` when the name matches nothing exactly.
 */
async function resolveNamedRef(
  client: AcruxCoreClient,
  path: string,
  ref: string,
  noun: string,
): Promise<string> {
  const trimmed = ref.trim();
  if (isUuid(trimmed)) return trimmed;

  const page = await client.get<{ data?: NamedRow[] }>(path, { search: trimmed, limit: 100 });
  const exact = (page.data ?? []).find((row) => row.name === trimmed);
  if (exact) return exact.id;

  const near = (page.data ?? []).map((row) => row.name).slice(0, 10);
  const hint = near.length > 0 ? ` Closest names: ${near.join(', ')}.` : '';
  throw new AcruxCoreApiError(
    `GET ${path}?search=${trimmed}`,
    404,
    'NOT_FOUND',
    `No ${noun} named "${trimmed}" in this team.${hint}`,
  );
}

/**
 * Resolves a prompt reference to both its id and its name.
 *
 * `render_prompt` and the gateway's stored-prompt path address prompts by **name**, but
 * every other prompt route addresses them by id, so a tool that does both needs the pair.
 *
 * @param client - REST client.
 * @param ref - Prompt UUID or name.
 * @returns The prompt's id and name.
 * @throws {AcruxCoreApiError} `NOT_FOUND` when the reference matches no prompt.
 */
export async function resolvePromptIdAndName(
  client: AcruxCoreClient,
  ref: string,
): Promise<{ id: string; name: string }> {
  const trimmed = ref.trim();
  if (isUuid(trimmed)) {
    const prompt = await client.get<{ id: string; name: string }>(`/prompts/${trimmed}`);
    return { id: prompt.id, name: prompt.name };
  }
  const id = await resolvePromptRef(client, trimmed);
  return { id, name: trimmed };
}
