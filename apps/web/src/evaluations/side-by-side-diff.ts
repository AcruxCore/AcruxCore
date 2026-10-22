import { diffLines, diffWordsWithSpace } from 'diff';

/** One run of text inside a diff cell; `changed` marks the words that differ from the other side. */
export interface DiffSegment {
  text: string;
  changed: boolean;
}

/** One side of one row: the line's text, split into changed and unchanged runs. */
export interface DiffCell {
  kind: 'same' | 'removed' | 'added';
  segments: DiffSegment[];
}

/** One aligned row. A side is null when the line exists on the other side only. */
export interface DiffRow {
  left: DiffCell | null;
  right: DiffCell | null;
}

/** The aligned rows plus how many lines each side changed. */
export interface SideBySideDiff {
  rows: DiffRow[];
  added: number;
  removed: number;
}

/**
 * Above this share of changed (non-space) characters, a paired line gets no word
 * marks. A mostly rewritten paragraph would otherwise mark nearly every word,
 * which says nothing the line's own colour does not already say.
 */
const MAX_CHANGED_SHARE = 0.5;

/** The share of a side's non-space characters that sit in changed segments. */
function changedShare(segments: DiffSegment[]): number {
  const size = (t: string) => t.replace(/\s/g, '').length;
  const total = segments.reduce((n, s) => n + size(s.text), 0);
  const changed = segments.reduce((n, s) => n + (s.changed ? size(s.text) : 0), 0);
  return total === 0 ? 0 : changed / total;
}

/** Splits a `diffLines` part into its lines, without the empty string a trailing newline would add. */
function toLines(value: string): string[] {
  return value.replace(/\n$/, '').split('\n');
}

/** A whole line in one kind, with no word-level highlight. */
function plain(kind: DiffCell['kind'], line: string): DiffCell {
  return { kind, segments: [{ text: line, changed: false }] };
}

/**
 * A removed line and an added line on one row, with the differing words marked.
 * Returns null when most of the line changed: the two are then not the same line
 * edited, and marking nearly every word would say nothing.
 *
 * Whitespace counts as a change, so a re-indented line shows its old indentation
 * on the left instead of the new one on both sides.
 */
function pairLines(left: string, right: string): DiffRow | null {
  const words = diffWordsWithSpace(left, right);
  const leftSegments = words.filter((w) => !w.added).map((w) => ({ text: w.value, changed: !!w.removed }));
  const rightSegments = words.filter((w) => !w.removed).map((w) => ({ text: w.value, changed: !!w.added }));
  if (changedShare(leftSegments) > MAX_CHANGED_SHARE || changedShare(rightSegments) > MAX_CHANGED_SHARE) return null;
  return { left: { kind: 'removed', segments: leftSegments }, right: { kind: 'added', segments: rightSegments } };
}

/** Puts unmatched removed and added lines next to each other, row by row, with no word marks. */
function zipUnmatched(removedLines: string[], addedLines: string[]): DiffRow[] {
  const rows: DiffRow[] = [];
  for (let r = 0; r < Math.max(removedLines.length, addedLines.length); r++) {
    const left = removedLines[r];
    const right = addedLines[r];
    rows.push({
      left: left === undefined ? null : plain('removed', left),
      right: right === undefined ? null : plain('added', right),
    });
  }
  return rows;
}

/**
 * Lays out one changed block. Each removed line is matched, in order, with the
 * first later added line that is an edit of it, so a line inserted above an edit
 * does not push the edit onto the wrong row. Lines left unmatched between two
 * matches sit side by side without word marks.
 */
function alignChangedBlock(removedLines: string[], addedLines: string[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let pendingRemoved: string[] = [];
  let next = 0;
  for (const left of removedLines) {
    let match: { at: number; row: DiffRow } | null = null;
    for (let k = next; k < addedLines.length && !match; k++) {
      const row = pairLines(left, addedLines[k]);
      if (row) match = { at: k, row };
    }
    if (!match) {
      pendingRemoved.push(left);
      continue;
    }
    rows.push(...zipUnmatched(pendingRemoved, addedLines.slice(next, match.at)), match.row);
    pendingRemoved = [];
    next = match.at + 1;
  }
  rows.push(...zipUnmatched(pendingRemoved, addedLines.slice(next)));
  return rows;
}

/**
 * Builds a two-column diff of two prompt texts: the left side is `before`, the
 * right side is `after`, and matching lines sit on the same row.
 *
 * A prompt line is often a whole paragraph, so a line-level diff alone would
 * paint a long paragraph red and green for one changed word. When a removed
 * line and an added line are two versions of the same line, they share a row
 * and only the words that differ are marked `changed`.
 *
 * @param before - The text shown on the left (the version being compared against).
 * @param after - The text shown on the right (the prompt being read).
 * @returns The aligned rows, and the count of added and removed lines.
 */
export function buildSideBySide(before: string, after: string): SideBySideDiff {
  // Both texts end in a newline, so a line appended after the last one does not
  // make the old last line read as removed and added again.
  const parts = diffLines(`${before}\n`, `${after}\n`);
  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const lines = toLines(part.value);

    if (!part.added && !part.removed) {
      for (const line of lines) rows.push({ left: plain('same', line), right: plain('same', line) });
      continue;
    }

    if (part.added) {
      added += lines.length;
      for (const line of lines) rows.push({ left: null, right: plain('added', line) });
      continue;
    }

    // A removal followed by an addition is a changed block.
    removed += lines.length;
    const nextPart = parts[i + 1];
    const addedLines = nextPart?.added ? toLines(nextPart.value) : [];
    if (nextPart?.added) {
      added += addedLines.length;
      i++;
    }
    rows.push(...alignChangedBlock(lines, addedLines));
  }

  return { rows, added, removed };
}
