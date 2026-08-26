import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Result of comparing a TypeScript source tree against its compiled output. */
export interface DistFreshness {
  /** True when at least one source file is newer than the newest compiled file. */
  stale: boolean;
  /** Modification time of the newest source file considered, or null if none exist. */
  newestSrcAt: Date | null;
  /** Modification time of the newest compiled file, or null when `dist` is absent/empty. */
  builtAt: Date | null;
  /** Up to {@link SAMPLE_LIMIT} source paths newer than `builtAt`, relative to `srcDir`. */
  staleFiles: string[];
}

/** How many stale paths to name in the result; enough to recognise the area, short enough to log. */
const SAMPLE_LIMIT = 5;

/**
 * Walks a directory tree, returning the newest mtime among files the filter accepts.
 *
 * A missing directory yields `null` rather than throwing: callers treat "never built" the
 * same as "built before every source file", and an absent `dist` is the normal state of a
 * fresh checkout.
 *
 * @param dir - Absolute path to walk.
 * @param accept - Predicate on the file name (not the full path).
 * @param onNewerThan - When given, accepted files newer than this are collected into `hits`.
 * @param hits - Collector for paths newer than `onNewerThan`, relative to the initial `dir`.
 * @param base - Internal: the root the collected paths are made relative to.
 * @returns The newest mtime found, or null when the tree holds no accepted file.
 */
function newestMtime(
  dir: string,
  accept: (name: string) => boolean,
  onNewerThan?: Date,
  hits?: string[],
  base = dir,
): Date | null {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let newest: Date | null = null;
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      const sub = newestMtime(full, accept, onNewerThan, hits, base);
      if (sub && (!newest || sub > newest)) newest = sub;
      continue;
    }
    if (!entry.isFile() || !accept(entry.name)) continue;
    const { mtime } = statSync(full);
    if (!newest || mtime > newest) newest = mtime;
    if (onNewerThan && hits && mtime > onNewerThan && hits.length < SAMPLE_LIMIT) {
      hits.push(full.slice(base.length + 1));
    }
  }
  return newest;
}

/**
 * Reports whether a compiled `dist` tree is older than the sources it was built from.
 *
 * This exists because `apps/worker` does not import `apps/api`'s TypeScript — it imports
 * the compiled output through `apps/api`'s `exports` map, and its own `tsx watch` sees only
 * `apps/worker/src`. So editing `apps/api/src` without rebuilding leaves the worker running
 * the previous build with no log line, no crash and no type error: the job simply behaves as
 * if the change was never made (issue #231).
 *
 * `.test.ts` files are ignored — a changed test cannot alter what a queued job does, and
 * counting them would raise the alarm on every red-green cycle.
 *
 * @param srcDir - Absolute path to the TypeScript source tree.
 * @param distDir - Absolute path to the compiled output tree.
 * @returns The comparison; `stale` is false when `srcDir` has no sources to compare.
 */
export function checkDistFreshness(srcDir: string, distDir: string): DistFreshness {
  const builtAt = newestMtime(distDir, (n) => n.endsWith('.js'));
  const staleFiles: string[] = [];
  const isSource = (n: string): boolean => n.endsWith('.ts') && !n.endsWith('.test.ts');
  const newestSrcAt = newestMtime(srcDir, isSource, builtAt ?? undefined, staleFiles, srcDir);

  if (!newestSrcAt) return { stale: false, newestSrcAt: null, builtAt, staleFiles: [] };
  return { stale: !builtAt || newestSrcAt > builtAt, newestSrcAt, builtAt, staleFiles };
}

/**
 * Formats a {@link DistFreshness} as a multi-line warning banner, or null when fresh.
 *
 * Deliberately loud and deliberately non-fatal: the process that notices this is usually
 * already running correctly against the previous build, so refusing to boot would be worse
 * than saying plainly what is wrong and what to run.
 *
 * @param f - A freshness result.
 * @param label - Name of the package whose build is stale, used in the message.
 * @param buildCommand - The exact command that fixes it.
 * @returns The banner text, or null when nothing is stale.
 */
export function formatStaleBuildWarning(
  f: DistFreshness,
  label: string,
  buildCommand: string,
): string | null {
  if (!f.stale) return null;
  const when = f.builtAt ? f.builtAt.toISOString() : 'never built';
  const sample = f.staleFiles.length > 0 ? `\n  newer sources: ${f.staleFiles.join(', ')}` : '';
  return [
    '',
    `  ${'='.repeat(74)}`,
    `  STALE BUILD — this process is running ${label}'s COMPILED output, not its source.`,
    `  ${label} last built: ${when}`,
    `  newest source:    ${f.newestSrcAt ? f.newestSrcAt.toISOString() : 'unknown'}${sample}`,
    `  Your recent ${label} edits are NOT running. Fix with:  ${buildCommand}`,
    `  ${'='.repeat(74)}`,
    '',
  ].join('\n');
}
