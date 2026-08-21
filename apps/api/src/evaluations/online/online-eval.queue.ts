import { Queue } from 'bullmq';
import { getRedisConnection } from '../queue/connection';

export const ONLINE_EVAL_QUEUE = 'eval-online';

/** Job payload carries only ids — the worker does every read, per the spec's "no DB read at enqueue time" requirement. */
export interface OnlineEvalJobData {
  teamId: string;
  traceId: string;
  spanId: string;
  spanKind: string;
}

let onlineEvalQueue: Queue<OnlineEvalJobData> | null = null;

/** Memoized singleton queue handle, matching the house pattern in `evaluations/queue/queues.ts`. */
export function getOnlineEvalQueue(): Queue<OnlineEvalJobData> {
  if (!onlineEvalQueue) {
    onlineEvalQueue = new Queue<OnlineEvalJobData>(ONLINE_EVAL_QUEUE, { connection: getRedisConnection() });
  }
  return onlineEvalQueue;
}
