import { createPatch } from 'diff';
import { NotFoundError } from '../../shared/errors/http-errors';
import { AppError } from '../../shared/errors/app-error';
import { DiffRepository } from './diff.repository';
import type { DiffResponse } from './diff.types';
import type { TemplateContent } from '../versions/nunjucks.utils';

/**
 * Longest edit script (lines inserted plus lines removed) the diff will search for.
 * A real prompt rewrite is a few hundred lines; past this the patch is unreadable
 * anyway, and the line diff's cost grows with the square of the edit length.
 */
export const DIFF_MAX_EDIT_LENGTH = 5_000;

/**
 * Wall-clock budget for one diff, in milliseconds. `createPatch` is synchronous and
 * runs on the API's only event loop, so every other request on the instance waits
 * while it works; this is the bound that actually caps that wait, because two texts
 * of a few thousand disjoint lines reach the edit-length cap only after seconds.
 */
export const DIFF_TIMEOUT_MS = 500;

/**
 * Serialises a messages array to a human-readable text block suitable for diffing.
 * Each message is formatted as `[role]\ncontent`, separated by `\n\n---\n\n`. A message
 * marked for prompt caching reads `[role · cached]`, so toggling the marker shows in the diff.
 * Only raw nunjucks template strings are diffed — never rendered output. An image part reads
 * `[image: <url template>]`, so a changed image shows in the diff.
 *
 * @param messages - Array of role/content pairs, each optionally carrying `cache_control`.
 * @returns A single string representing all messages.
 */
function contentToDiffText(content: TemplateContent): string {
  if (typeof content === 'string') return content;
  return content.map((p) => (p.type === 'text' ? p.text : `[image: ${p.image_url.url}]`)).join('\n');
}

function messagesToDiffText(messages: Array<{ role: string; content: TemplateContent; cache_control?: unknown }>): string {
  return messages
    .map(m => `[${m.role}${m.cache_control ? ' · cached' : ''}]\n${contentToDiffText(m.content)}`)
    .join('\n\n---\n\n');
}

/**
 * Service for computing a unified diff between two prompt versions.
 */
export class DiffService {
  private readonly repo: DiffRepository;

  constructor() {
    this.repo = new DiffRepository();
  }

  /**
   * Computes a unified diff string between two versions of a prompt.
   * Comparing a version to itself returns a header with no hunks (not an error).
   *
   * @param promptId - UUID of the prompt.
   * @param teamId   - UUID of the requesting team; enforces tenant isolation.
   * @param from     - Version number to diff from.
   * @param to       - Version number to diff to.
   * @returns Object with the unified diff string and the version numbers.
   * @throws {NotFoundError} If the prompt is not in the team, or either version does not exist.
   * @throws {AppError} 422 `DIFF_TOO_LARGE` when the versions differ by more than
   *   {@link DIFF_MAX_EDIT_LENGTH} lines or the diff does not finish within
   *   {@link DIFF_TIMEOUT_MS}. The work is abandoned rather than finished, so one request
   *   can no longer stall every other tenant on the instance.
   */
  async computeDiff(
    promptId: string,
    teamId: string,
    from: number,
    to: number,
  ): Promise<DiffResponse> {
    const prompt = await this.repo.findPrompt(promptId, teamId);
    if (!prompt) {
      throw new NotFoundError('Prompt not found.');
    }

    const uniqueVersionNumbers = Array.from(new Set([from, to]));
    const versionRows = await this.repo.findVersionsByNumbers(promptId, uniqueVersionNumbers);

    const fromRow = versionRows.find(r => r.versionNumber === from);
    const toRow   = versionRows.find(r => r.versionNumber === to);

    if (!fromRow || !toRow) {
      throw new NotFoundError('One or both version numbers not found for this prompt.');
    }

    const fromText = messagesToDiffText(fromRow.messages);
    const toText   = messagesToDiffText(toRow.messages);
    const label    = `${prompt.name} v${from}..v${to}`;

    // Without these options jsdiff searches up to oldLines + newLines edits with no time
    // limit; it returns undefined when either bound is hit.
    const diffString = createPatch(label, fromText, toText, undefined, undefined, {
      maxEditLength: DIFF_MAX_EDIT_LENGTH,
      timeout: DIFF_TIMEOUT_MS,
    });
    if (diffString === undefined) {
      throw new AppError(
        `v${from} and v${to} differ in too many lines to show a diff. Open each version to compare them.`,
        422,
        'DIFF_TOO_LARGE',
      );
    }

    return { diff: diffString, fromVersion: from, toVersion: to };
  }
}
