import { Queue } from 'bullmq';
import { getQueuePrefix, getRedisConnection } from '../queue/connection';

export const ONLINE_EVAL_QUEUE = 'eval-online';

/** Job payload carries only ids: the worker does every read. Enqueue reads only the cached rule list (phase-5-faq Q62). */
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
    onlineEvalQueue = new Queue<OnlineEvalJobData>(ONLINE_EVAL_QUEUE, {
      connection: getRedisConnection(),
      prefix: getQueuePrefix(),
    });
  }
  return onlineEvalQueue;
}
