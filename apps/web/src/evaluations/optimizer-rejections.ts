import type { RunReport } from '@/api/types';

/**
 * What the run report's "rewrites dropped before scoring" note shows (issue #686).
 *
 * The kept rewrites are counted from the report's own variants, so the count is
 * right as soon as the report loads. The note shows on a failed run too: when every
 * kept rewrite errored, the run error says nothing about the dropped ones.
 *
 * @param report - The run report, or the fields of it the note reads.
 * @returns The reasons and the number of rewrites kept, or null when nothing was
 *   dropped or nothing was kept. With nothing kept, the run failed and its error
 *   already names the reasons.
 */
export function optimizerRejectionsNote(
  report: Pick<RunReport, 'status' | 'variants' | 'optimizerRejections'>,
): { rejections: string[]; kept: number } | null {
  const rejections = report.optimizerRejections ?? [];
  const kept = report.variants.filter((v) => v.variantKind === 'candidate').length;
  if (rejections.length === 0 || kept === 0) return null;
  return { rejections, kept };
}
