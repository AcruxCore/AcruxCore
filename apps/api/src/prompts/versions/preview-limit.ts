import { RateLimitedError } from '../../shared/errors';

/**
 * Most draft previews one team renders at once in this API process.
 *
 * A preview runs up to `MAX_PREVIEW_TEMPLATES` templates in the render sandbox, each with
 * its own time limit, and every role can call it. Sandbox renders share a small pool of
 * threads with gateway prompt renders and eval cells, so without a cap one team's burst
 * of heavy previews made every tenant's renders wait. The Preview tab sends one request
 * at a time, so two leaves room for an overlap while typing.
 */
export const MAX_PREVIEWS_IN_FLIGHT_PER_TEAM = 2;

/** Seconds a refused preview is told to wait: about one heavy render. */
const PREVIEW_RETRY_AFTER_SECONDS = 1;

const inFlight = new Map<string, number>();

/**
 * Runs `render` while holding one of the team's preview slots.
 *
 * @param teamId - The team the preview is for.
 * @param render - The render to run.
 * @returns Whatever `render` returns.
 * @throws {RateLimitedError} 429 `RATE_LIMITED` when the team already has
 *   {@link MAX_PREVIEWS_IN_FLIGHT_PER_TEAM} previews rendering. Otherwise whatever
 *   `render` throws.
 */
export async function withTeamPreviewSlot<T>(teamId: string, render: () => Promise<T>): Promise<T> {
  const running = inFlight.get(teamId) ?? 0;
  if (running >= MAX_PREVIEWS_IN_FLIGHT_PER_TEAM) {
    throw new RateLimitedError('Too many previews are rendering for this team; try again in a moment.', PREVIEW_RETRY_AFTER_SECONDS);
  }
  inFlight.set(teamId, running + 1);
  try {
    return await render();
  } finally {
    const left = (inFlight.get(teamId) ?? 1) - 1;
    if (left > 0) inFlight.set(teamId, left);
    else inFlight.delete(teamId);
  }
}
