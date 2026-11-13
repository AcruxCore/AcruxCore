import { ExecutorSchema, type Executor } from './versions.types';
import { extractSecretRefs } from '../execute/secret-refs';

/** One header or query entry, as stored on an http executor. */
interface KeyValue {
  name: string;
  value: string;
}

/**
 * Whether `next` sends team secrets only where `previous` already sent them.
 *
 * Where a secret goes is decided by the executor's `url` and by the header or query
 * entry that carries the `{{secret.NAME}}` reference. Secrets are injected after
 * `requestTransform` and never into the URL, so nothing else in an executor can move
 * a secret's value somewhere new. A version that keeps the URL byte-for-byte and keeps
 * every secret-carrying entry exactly as it was can therefore be saved by someone who
 * may not bind secrets: it sends nothing to anywhere an owner or admin did not choose.
 *
 * The URL must match in full, path and query string included, because one host can
 * serve many tenants (a webhook relay, a shared API gateway) and a new path on it can
 * reach a different owner. Entry names and values must match exactly, so moving a
 * secret into a new header or query parameter, or swapping in another secret, counts
 * as a new binding. Non-secret entries, the method, the transforms and the schema are
 * free to change.
 *
 * @param next - The executor about to be stored.
 * @param previous - The stored executor JSON of the version it replaces, or
 *   null/undefined when there is none.
 * @returns `true` only when both are http executors, the URLs are equal and every
 *   secret-carrying entry of `next` appears unchanged in the same list of `previous`;
 *   `false` for anything else, including a `previous` that no longer parses.
 */
export function sendsSecretsAsBefore(next: Executor, previous: unknown): boolean {
  if (next.type !== 'http' || previous === null || previous === undefined) return false;
  const parsed = ExecutorSchema.safeParse(previous);
  if (!parsed.success || parsed.data.type !== 'http') return false;
  const before = parsed.data;
  if (next.url !== before.url) return false;
  return (
    secretEntriesKept(next.headers, before.headers) && secretEntriesKept(next.query, before.query)
  );
}

/** Every entry of `entries` that carries a secret has an identical entry in `before`. */
function secretEntriesKept(entries: KeyValue[], before: KeyValue[]): boolean {
  return entries
    .filter((e) => extractSecretRefs({ headers: [e], query: [] }).length > 0)
    .every((e) => before.some((b) => b.name === e.name && b.value === e.value));
}
