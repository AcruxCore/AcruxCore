import { getRedisConnection } from '../evaluations/queue/connection';
import { HealthRepository } from './health.repository';

/** Outcome of a single dependency check. */
export interface HealthCheckResult {
  status: 'ok' | 'error';
  latencyMs: number;
  error?: string;
}

/** Aggregate result returned by the health endpoint. */
export interface HealthStatus {
  status: 'ok' | 'error';
  checks: {
    database: HealthCheckResult;
    redis: HealthCheckResult;
  };
}

/**
 * Runs the dependency checks the health endpoint reports.
 * Database and Redis are the two dependencies the API cannot serve a real
 * request without — Postgres for every domain, Redis for BullMQ (email and
 * eval-run queues) and the auth rate limiter.
 */
export class HealthService {
  constructor(private readonly repository: HealthRepository) {}

  /**
   * Pings the database and Redis concurrently and rolls the results into one
   * status. Never throws — a failed dependency is reported in the result,
   * not as a rejected promise, so the controller always has a body to send.
   *
   * @returns `status: 'ok'` only when every check reports `'ok'`.
   */
  async check(): Promise<HealthStatus> {
    const [database, redis] = await Promise.all([this.checkDatabase(), this.checkRedis()]);
    const status = database.status === 'ok' && redis.status === 'ok' ? 'ok' : 'error';
    return { status, checks: { database, redis } };
  }

  private async checkDatabase(): Promise<HealthCheckResult> {
    const start = performance.now();
    try {
      await this.repository.pingDatabase();
      return { status: 'ok', latencyMs: Math.round(performance.now() - start) };
    } catch (err) {
      return {
        status: 'error',
        latencyMs: Math.round(performance.now() - start),
        error: err instanceof Error ? err.message : 'Unknown database error',
      };
    }
  }

  private async checkRedis(): Promise<HealthCheckResult> {
    const start = performance.now();
    try {
      await getRedisConnection().ping();
      return { status: 'ok', latencyMs: Math.round(performance.now() - start) };
    } catch (err) {
      return {
        status: 'error',
        latencyMs: Math.round(performance.now() - start),
        error: err instanceof Error ? err.message : 'Unknown Redis error',
      };
    }
  }
}
