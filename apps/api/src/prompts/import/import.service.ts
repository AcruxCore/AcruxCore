import type { Prisma } from '@prisma/client';
import { ImportRepository } from './import.repository';
import { PromptsRepository } from '../prompts.repository';
import { MAX_PROMPT_NAME_LENGTH } from '../prompts.types';
import { extractVariables } from '../versions/nunjucks.utils';
import { runInTransaction } from '../../shared/db';
import type { ImportBody, ImportResponse } from './import.types';

/**
 * Service for importing a prompt from an export file.
 * Re-extracts variables from the message templates; never trusts the imported variables array.
 */
export class ImportService {
  private readonly repo: ImportRepository;
  private readonly prompts: PromptsRepository;

  constructor() {
    this.repo = new ImportRepository();
    this.prompts = new PromptsRepository();
  }

  /**
   * Imports an export file to create a new prompt with version 1 and two default aliases.
   * Resolves name collisions automatically by appending `-imported-<unix_ms>`, inside
   * the same transaction and under the same name lock as a create.
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
    const variables = extractVariables(body.version.messages);

    const { name, promptId, versionId, versionNumber } = await runInTransaction(async (tx) => {
      const name = await this.claimName(teamId, body.prompt.name, tx);
      const created = await this.repo.createImportedPrompt(
        {
          teamId,
          actorId,
          name,
          description: body.prompt.description ?? null,
          messages:    body.version.messages,
          variables,
        },
        tx,
      );
      return { name, ...created };
    });

    return {
      prompt:  { id: promptId, name },
      version: { id: versionId, versionNumber },
    };
  }

  // Picks the name the import will store and returns it locked in `tx`: the
  // requested name if no active prompt holds it, else `<name>-imported-<unix_ms>`,
  // with the requested part cut short so the whole name stays within the length limit.
  // Each candidate is locked before it is checked — a suffixed name is a name like
  // any other, and a create or rename could be claiming it at the same moment.
  // Imports of one name are serialised by the first lock, so two can still land in
  // the same millisecond; the stamp steps until a candidate is free.
  private async claimName(teamId: string, requested: string, tx: Prisma.TransactionClient): Promise<string> {
    let name = requested;
    for (let stamp = Date.now(); ; stamp++) {
      await this.prompts.lockName(teamId, name, tx);
      if (!(await this.prompts.findByName(name, teamId, tx))) return name;
      const suffix = `-imported-${stamp}`;
      name = requested.slice(0, MAX_PROMPT_NAME_LENGTH - suffix.length) + suffix;
    }
  }
}
