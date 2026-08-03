import { NotFoundError } from '../shared/errors/http-errors';
import { AuditRepository } from './audit.repository';
import type { AuditListResponse } from './audit.types';

/**
 * Service for the audit log read feature.
 * Verifies prompt ownership before returning events.
 */
export class AuditService {
  private readonly repo: AuditRepository;

  constructor() {
    this.repo = new AuditRepository();
  }

  /**
   * Returns a paginated audit trail for a specific prompt.
   * Throws NotFoundError if the prompt does not exist in the given team.
   *
   * @param promptId - UUID of the prompt.
   * @param teamId   - UUID of the requesting team.
   * @param page     - 1-indexed page number.
   * @param limit    - Page size (max 100).
   * @returns Paginated list of audit events with actor details.
   * @throws {NotFoundError} If the prompt is not found or belongs to another team.
   */
  async listForPrompt(
    promptId: string,
    teamId: string,
    page: number,
    limit: number,
  ): Promise<AuditListResponse> {
    const prompt = await this.repo.findPrompt(promptId, teamId);
    if (!prompt) {
      throw new NotFoundError('Prompt not found.');
    }

    const { rows, total } = await this.repo.listForPrompt(promptId, teamId, page, limit);

    return { data: rows, total, page, limit };
  }

  /**
   * Returns a paginated, team-wide audit trail (Finding #13) — every event for
   * the team, not just those scoped to one prompt. No prompt-ownership check:
   * `teamId` itself is the isolation boundary, already verified by the
   * `requireTeamRole` middleware before this is called.
   *
   * @param teamId - UUID of the team.
   * @param page   - 1-indexed page number.
   * @param limit  - Page size (max 100).
   * @returns Paginated list of audit events with actor details.
   */
  async listForTeam(
    teamId: string,
    page: number,
    limit: number,
  ): Promise<AuditListResponse> {
    const { rows, total } = await this.repo.listForTeam(teamId, page, limit);
    return { data: rows, total, page, limit };
  }
}
