import prisma from '../shared/db/client';

/**
 * Existence checks behind the getting-started checklist.
 *
 * Each method answers "is there at least one row" with a `findFirst` that selects only
 * the id, so Postgres stops at the first match on the team index. Counting rows, as the
 * list endpoints do, would scan every gateway request a busy team has ever made just to
 * learn that the number is above zero.
 */
export class OnboardingRepository {
  /**
   * @param teamId - The team to check.
   * @returns True when the team has saved a provider credential.
   */
  async hasCredential(teamId: string): Promise<boolean> {
    return (await prisma.providerConnection.findFirst({ where: { teamId }, select: { id: true } })) !== null;
  }

  /**
   * @param teamId - The team to check.
   * @returns True when the team has registered a gateway model.
   */
  async hasModel(teamId: string): Promise<boolean> {
    return (await prisma.gatewayModel.findFirst({ where: { teamId }, select: { id: true } })) !== null;
  }

  /**
   * Looks for any active key that can call the API for this team.
   *
   * Personal keys of every member count, as do team-scoped keys and gateway virtual
   * keys. Revoked keys do not.
   *
   * @param teamId - The team to check.
   * @returns True when at least one such key exists.
   */
  async hasApiKey(teamId: string): Promise<boolean> {
    const [apiKey, virtualKey] = await Promise.all([
      prisma.apiKey.findFirst({ where: { teamId, revokedAt: null }, select: { id: true } }),
      prisma.virtualKey.findFirst({ where: { teamId, revokedAt: null }, select: { id: true } }),
    ]);
    return apiKey !== null || virtualKey !== null;
  }

  /**
   * Both tables are read because either proves a call arrived: the gateway request log
   * covers calls through the gateway, and traces also cover an app that only reports
   * spans through an SDK or OTLP.
   *
   * @param teamId - The team to check.
   * @returns True when the team has at least one gateway request or trace.
   */
  async hasRequest(teamId: string): Promise<boolean> {
    const [gatewayRequest, trace] = await Promise.all([
      prisma.gatewayRequest.findFirst({ where: { teamId }, select: { id: true } }),
      prisma.trace.findFirst({ where: { teamId }, select: { id: true } }),
    ]);
    return gatewayRequest !== null || trace !== null;
  }
}
