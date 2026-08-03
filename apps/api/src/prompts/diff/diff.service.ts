import { createPatch } from 'diff';
import { NotFoundError } from '../../shared/errors/http-errors';
import { DiffRepository } from './diff.repository';
import type { DiffResponse } from './diff.types';

/**
 * Serialises a messages array to a human-readable text block suitable for diffing.
 * Each message is formatted as `[role]\ncontent`, separated by `\n\n---\n\n`.
 * Only raw nunjucks template strings are diffed — never rendered output.
 *
 * @param messages - Array of role/content pairs.
 * @returns A single string representing all messages.
 */
function messagesToDiffText(messages: Array<{ role: string; content: string }>): string {
  return messages
    .map(m => `[${m.role}]\n${m.content}`)
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

    const diffString = createPatch(label, fromText, toText);

    return { diff: diffString, fromVersion: from, toVersion: to };
  }
}
