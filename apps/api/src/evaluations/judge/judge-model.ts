import { ValidationError } from '../../shared/errors';
import { ModelsRepository } from '../../gateway/models/models.repository';

const modelsRepo = new ModelsRepository();

/**
 * Checks that a model a caller named — a judge, or the optimize run's
 * candidate-writing model — is one this team has registered under
 * Gateway → Models.
 *
 * The platform has no default judge: every offline run and every online rule
 * carries the model its caller chose. That choice is checked here, at request
 * time, because a judge call that fails later happens in the worker — after the
 * run row exists and the paid cell calls have already been made.
 *
 * @param teamId - Isolation boundary. A model registered by another team does not count.
 * @param publicName - The `GatewayModel.publicName` the caller sent (`judge_model` or `optimizer_model`).
 * @throws {ValidationError} If the team has no model with that public name (HTTP 400).
 */
export async function assertModelRegistered(teamId: string, publicName: string): Promise<void> {
  const model = await modelsRepo.findByPublicName(teamId, publicName);
  if (!model) {
    throw new ValidationError(`Model '${publicName}' is not registered. Add it under Gateway → Models.`);
  }
}
