import { NotFoundError } from '../../shared/errors/http-errors';
import { ExportRepository } from './export.repository';
import type { ExportFile } from './export.types';

/**
 * Service for building the portable export JSON for a prompt version.
 */
export class ExportService {
  private readonly repo: ExportRepository;

  constructor() {
    this.repo = new ExportRepository();
  }

  /**
   * Builds an ExportFile object for a specific prompt version.
   * The export captures the raw nunjucks template strings — never rendered output.
   *
   * @param promptId      - UUID of the prompt.
   * @param teamId        - UUID of the requesting team.
   * @param versionNumber - The version number to export.
   * @returns Fully populated ExportFile object plus the prompt name for Content-Disposition.
   * @throws {NotFoundError} If the prompt or the version number is not found.
   */
  async exportVersion(
    promptId: string,
    teamId: string,
    versionNumber: number,
  ): Promise<ExportFile & { promptName: string }> {
    const prompt = await this.repo.findPrompt(promptId, teamId);
    if (!prompt) {
      throw new NotFoundError('Prompt not found.');
    }

    const version = await this.repo.findVersion(promptId, versionNumber);
    if (!version) {
      throw new NotFoundError('Version not found.');
    }

    return {
      schemaVersion: 1,
      exportedAt:    new Date().toISOString(),
      prompt: {
        name:        prompt.name,
        description: prompt.description,
      },
      version: {
        versionNumber: version.versionNumber,
        messages:      version.messages,
        variables:     version.variables,
        createdAt:     version.createdAt.toISOString(),
      },
      promptName: prompt.name,
    };
  }
}
