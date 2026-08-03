/** A single header/query key-value pair, as stored on an http executor. */
interface KeyValue {
  value: string;
}

/** The subset of an http executor's shape this helper needs to scan for secret references. */
export interface SecretRefScanTarget {
  headers: KeyValue[];
  query: KeyValue[];
}

/** Matches `{{secret.NAME}}` — the placeholder syntax teams use to reference a team Secret by name. */
const SECRET_REF_PATTERN = /\{\{\s*secret\.([A-Z0-9_]{1,64})\s*\}\}/g;

/**
 * Extracts every distinct `{{secret.NAME}}` name referenced in an http executor's
 * headers and query values. Used at commit time to verify each referenced secret
 * actually exists for the team (FAQ Q11) before the version becomes immutable.
 *
 * @param http - The executor's headers + query key/value pairs.
 * @returns The distinct secret names referenced, in first-seen order.
 */
export function extractSecretRefs(http: SecretRefScanTarget): string[] {
  const names = new Set<string>();
  for (const kv of [...http.headers, ...http.query]) {
    for (const match of kv.value.matchAll(SECRET_REF_PATTERN)) {
      names.add(match[1]!);
    }
  }
  return [...names];
}
