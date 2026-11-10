import type { OnboardingRepository } from './onboarding.repository';
import type { OnboardingStatus } from './onboarding.types';

/** Builds the team's getting-started status from its real data. */
export class OnboardingService {
  constructor(private readonly repo: OnboardingRepository) {}

  /**
   * Reads all four steps in parallel.
   *
   * Each step is judged on its own fact, never on the steps before it, so a team that
   * only reports traces through an SDK still sees "first request" done.
   *
   * @param teamId - The caller's active team.
   * @returns The status of each step for the whole team.
   */
  async getStatus(teamId: string): Promise<OnboardingStatus> {
    const [credential, model, apiKey, firstRequest] = await Promise.all([
      this.repo.hasCredential(teamId),
      this.repo.hasModel(teamId),
      this.repo.hasApiKey(teamId),
      this.repo.hasRequest(teamId),
    ]);
    return { credential, model, apiKey, firstRequest };
  }
}
