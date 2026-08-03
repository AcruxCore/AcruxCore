import { ImportRepository } from './import.repository';
import { extractVariables } from '../versions/nunjucks.utils';
import type { ImportBody, ImportResponse } from './import.types';

/**
 * Service for importing a prompt from an export file.
 * Re-extracts variables from the message templates; never trusts the imported variables array.
 */
export class ImportService {
  private readonly repo: ImportRepository;

  constructor() {
    this.repo = new ImportRepository();
  }

  /**
   * Imports an export file to create a new prompt with version 1 and two default aliases.
   * Resolves name collisions automatically by appending `-imported-<unix_ms>`.
   * Always re-derives the `variables` array from the message content via nunjucks AST.
   *
   * @param teamId  - UUID of the team receiving the import.
   * @param actorId - UUID of the user performing the import.
   * @param body    - Validated import body (output of ImportBodySchema.parse()).
   * @returns Response shape with prompt and version identifiers.
   */
  async importPrompt(
    teamId: string,
    actorId: string,
    body: ImportBody,
  ): Promise<ImportResponse> {
    let name = body.prompt.name;
    const exists = await this.repo.nameExistsInTeam(name, teamId);
    if (exists) {
      name = `${name}-imported-${Date.now()}`;
    }

    const variables = extractVariables(body.version.messages);

    const { promptId, versionId, versionNumber } = await this.repo.createImportedPrompt({
      teamId,
      actorId,
      name,
      description: body.prompt.description ?? null,
      messages:    body.version.messages,
      variables,
    });

    return {
      prompt:  { id: promptId, name },
      version: { id: versionId, versionNumber },
    };
  }
}
