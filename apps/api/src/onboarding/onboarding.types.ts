/**
 * Whether the active team has finished each getting-started step.
 *
 * Every flag describes the **team**, not the caller. An editor cannot create an API
 * key, but a team whose owner already did is set up, and the editor must not be held
 * on a step only an owner or admin can finish.
 */
export interface OnboardingStatus {
  /** At least one provider credential is saved. */
  credential: boolean;
  /** At least one gateway model is registered. */
  model: boolean;
  /** At least one active key can call the API: a member's personal key, a team key, or a gateway virtual key. */
  apiKey: boolean;
  /** At least one gateway request or one trace has reached the platform. */
  firstRequest: boolean;
}
