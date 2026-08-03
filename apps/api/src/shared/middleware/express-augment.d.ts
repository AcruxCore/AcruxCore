import 'express';
import type { GatewayCallContext } from '../../gateway/completions/completions.types';

declare module 'express' {
  interface Request {
    user?: { id: string; email: string; displayName: string | null };
    teamId?: string;
    gateway?: GatewayCallContext;
  }
}
