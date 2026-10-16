/**
 * Renders a Zod issue path as the caller would write it — `examples[17].input`
 * rather than `examples.17.input` — so the row that failed is named in a form
 * that maps straight back to a line in their file or an entry in their batch.
 *
 * @param path - A Zod issue's `path`.
 * @returns The path in dotted-and-indexed form, or `''` for a root-level issue.
 */
export function formatIssuePath(path: Array<string | number>): string {
  return path.reduce<string>(
    (out, part) => (typeof part === 'number' ? `${out}[${part}]` : out ? `${out}.${part}` : part),
    '',
  );
}

/**
 * The message for a 400 built from the first Zod issue, prefixed with its path
 * (`results[3].scores: …`) so a bad row in a batch is named.
 *
 * @param issues - A failed parse's `error.issues`; must hold at least one issue.
 * @returns `"<path>: <message>"`, or just the message for a root-level issue.
 */
export function firstIssueMessage(issues: Array<{ path: Array<string | number>; message: string }>): string {
  const issue = issues[0];
  const where = formatIssuePath(issue.path);
  return where ? `${where}: ${issue.message}` : issue.message;
}
