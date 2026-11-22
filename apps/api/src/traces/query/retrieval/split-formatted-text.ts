/**
 * A numbered label that starts one passage in a formatted search result: `Doc 1:`,
 * `Document #2:`, `Source 3 -`, `Passage 4.`, `Chunk 5)`, `Result 6:` or `[7]`. It must
 * start the string or follow whitespace, so `v1.2` or `page[3]` never match. Group 1 or
 * 2 is the number, group 3 the separator after a word label.
 */
const LABEL = /(?<=^|\s)(?:\[(\d{1,3})\]|(?:doc(?:ument)?|source|passage|chunk|result)\s*#?(\d{1,3})\s*([:\-.)\]]))/gi;

/** True when only spaces or tabs sit between the line's start and `index`. */
function atLineStart(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  return text.slice(lineStart, index).trim() === '';
}

/**
 * The start offsets of the labels that really begin a passage. `[N]` and a word label
 * ending in `.` count only at the start of a line, because mid-sentence they are a
 * citation (`France [1] with…`) or prose (`policy document 3.`). The numbers must then
 * run 1, 2, 3 from the first label, so a stray `Document 7:` inside passage 2 is text.
 */
function passageStarts(text: string): number[] {
  const starts: number[] = [];
  let last = 0;
  for (const m of text.matchAll(LABEL)) {
    const index = m.index ?? 0;
    const n = Number(m[1] ?? m[2]);
    const strictForm = m[1] !== undefined || m[3] === '.';
    if (strictForm && !atLineStart(text, index)) continue;
    if (starts.length > 0 && n !== last + 1) continue;
    starts.push(index);
    last = n;
  }
  return starts;
}

/**
 * Splits one formatted string of search results (`"Doc 1: … Doc 2: …"`) into its
 * passages, each keeping its own label so the reader sees the numbering the model saw.
 *
 * Used only for a tool the developer marked `kind="retrieval"`: on an unmarked tool a
 * numbered string is not evidence of a search. A string with fewer than two labels is
 * not split, because one label (or none) gives no boundary to trust.
 *
 * @param text - The tool's output as text.
 * @returns The passages, trimmed and non-empty, or null when the string has fewer than
 *   two labels.
 */
export function splitFormattedText(text: string): string[] | null {
  const starts = passageStarts(text);
  if (starts.length < 2) return null;
  const parts = starts.map((start, i) => text.slice(start, starts[i + 1] ?? text.length).trim());
  // Text before the first label (a header such as "Results:") is kept on the first passage.
  const lead = text.slice(0, starts[0]).trim();
  if (lead) parts[0] = `${lead}\n${parts[0]}`;
  return parts.filter((p) => p !== '');
}
