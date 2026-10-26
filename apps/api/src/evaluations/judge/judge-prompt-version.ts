import { ValidationError } from '../../shared/errors';
import { PromptsRepository } from '../../prompts/prompts.repository';
import { AliasesService } from '../../prompts/aliases/aliases.service';
import { VersionsRepository } from '../../prompts/versions/versions.repository';

const promptsRepo = new PromptsRepository();
const aliasesService = new AliasesService();
const versionsRepo = new VersionsRepository();

/**
 * Resolves the custom judge prompt an experiment names to the one version a
 * run will grade with: its `production` alias, else its latest committed
 * version — the same rule online evaluation rules use.
 *
 * Called twice. `ExperimentsService.create` calls it to reject a bad
 * `judge_prompt_id` before the experiment is saved. `RunsService.startRun`
 * calls it again and freezes the result onto the run's jobs, so promoting a
 * new judge version mid-run cannot change how that run grades (FAQ Q5), and a
 * prompt deleted since the experiment was created fails the request rather
 * than every judge job in the worker.
 *
 * A local run's judge call may instead name the exact version, so the runs
 * of a pipeline test grade with the version their optimize run froze, not with
 * whatever `production` serves by then (phase-5 FAQ Q58).
 *
 * @param teamId - Isolation boundary. Another team's prompt does not resolve.
 * @param promptId - The `judge_prompt_id` the caller sent.
 * @param versionNumber - An exact version to grade with, instead of the
 *   `production` alias; a positive integer.
 * @returns The id of the prompt version to grade with.
 * @throws {ValidationError} If the prompt is not a live prompt of this team,
 *   has no committed version yet, or has no version `versionNumber` (HTTP 400).
 */
export async function resolveJudgePromptVersion(teamId: string, promptId: string, versionNumber?: number): Promise<string> {
  const prompt = await promptsRepo.findById(promptId, teamId);
  if (!prompt) {
    throw new ValidationError('judge_prompt_id does not refer to a prompt in this team.');
  }
  if (versionNumber !== undefined) {
    const pinned = await versionsRepo.findByVersionNumber(promptId, versionNumber);
    if (!pinned) throw new ValidationError(`Judge prompt '${prompt.name}' has no version ${versionNumber}.`);
    return pinned.id;
  }
  const version = await aliasesService.resolveBaselineVersion(teamId, promptId);
  if (!version) {
    throw new ValidationError(
      `Judge prompt '${prompt.name}' has no committed version yet. Commit its judge template first.`,
    );
  }
  return version.versionId;
}
