import { describe, expect, it } from 'vitest';
import { buildSideBySide } from './side-by-side-diff';

/** Joins a cell's segments back into its text, or null for an empty side. */
function text(cell: { segments: { text: string }[] } | null): string | null {
  return cell ? cell.segments.map((s) => s.text).join('') : null;
}

describe('buildSideBySide', () => {
  it('keeps identical text as unchanged rows and counts no changes', () => {
    const result = buildSideBySide('a\nb', 'a\nb');
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.rows.map((r) => [text(r.left), text(r.right)])).toEqual([
      ['a', 'a'],
      ['b', 'b'],
    ]);
    expect(result.rows.every((r) => r.left?.kind === 'same' && r.right?.kind === 'same')).toBe(true);
  });

  it('pairs a changed line on one row and marks only the changed words', () => {
    const result = buildSideBySide('Route the ticket to billing.', 'Route the ticket to support.');
    expect(result.rows).toHaveLength(1);
    const [row] = result.rows;
    expect(row.left?.kind).toBe('removed');
    expect(row.right?.kind).toBe('added');
    expect(text(row.left)).toBe('Route the ticket to billing.');
    expect(text(row.right)).toBe('Route the ticket to support.');
    expect(row.left?.segments.filter((s) => s.changed).map((s) => s.text)).toEqual(['billing']);
    expect(row.right?.segments.filter((s) => s.changed).map((s) => s.text)).toEqual(['support']);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
  });

  it('drops word marks on a line that was mostly rewritten, where they would mark nearly every word', () => {
    const result = buildSideBySide(
      'Read the support ticket and decide its category.',
      'You route tickets using the policy below exactly.',
    );
    const [row] = result.rows;
    expect(row.left?.kind).toBe('removed');
    expect(row.right?.kind).toBe('added');
    expect(row.left?.segments.some((s) => s.changed)).toBe(false);
    expect(row.right?.segments.some((s) => s.changed)).toBe(false);
    expect(text(row.right)).toBe('You route tickets using the policy below exactly.');
  });

  it('leaves the other side empty for a line that exists on one side only', () => {
    const result = buildSideBySide('a\nc', 'a\nb\nc');
    expect(result.rows.map((r) => [text(r.left), text(r.right)])).toEqual([
      ['a', 'a'],
      [null, 'b'],
      ['c', 'c'],
    ]);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(0);
  });

  it('pads the shorter side when more lines were removed than added', () => {
    const result = buildSideBySide('x\ny\nz', 'w');
    expect(result.rows.map((r) => [text(r.left), text(r.right)])).toEqual([
      ['x', 'w'],
      ['y', null],
      ['z', null],
    ]);
    expect(result.removed).toBe(3);
    expect(result.added).toBe(1);
  });

  it('keeps blank lines as rows instead of dropping them', () => {
    const result = buildSideBySide('a\n\nb', 'a\n\nb');
    expect(result.rows).toHaveLength(3);
    expect(text(result.rows[1].left)).toBe('');
  });

  it('does not mark the old last line as changed when lines are appended after it', () => {
    const result = buildSideBySide('a\nb', 'a\nb\nc');
    expect(result.rows.map((r) => [text(r.left), text(r.right)])).toEqual([
      ['a', 'a'],
      ['b', 'b'],
      [null, 'c'],
    ]);
    expect(result.removed).toBe(0);
    expect(result.added).toBe(1);
  });

  it('shows the old indentation on the left when only the indentation changed', () => {
    const result = buildSideBySide('  - item one', '    - item one');
    const [row] = result.rows;
    expect(text(row.left)).toBe('  - item one');
    expect(text(row.right)).toBe('    - item one');
  });

  it('pairs an edited line with its new version when a new line is inserted above it', () => {
    const result = buildSideBySide('Route the ticket to billing.', 'You are a router.\nRoute the ticket to support.');
    expect(result.rows.map((r) => [text(r.left), text(r.right)])).toEqual([
      [null, 'You are a router.'],
      ['Route the ticket to billing.', 'Route the ticket to support.'],
    ]);
    expect(result.rows[1].left?.segments.filter((s) => s.changed).map((s) => s.text)).toEqual(['billing']);
  });
});
