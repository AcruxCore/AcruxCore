import { useState } from 'react';
import type { GatewayMeta } from '@/api';
import type { TelemetryState } from '../Telemetry';

export interface PlaygroundUsage {
  prompt: number;
  completion: number;
}

/**
 * Owns the request/response lifecycle state shared by the single-shot and
 * tool-calling-loop send paths: gateway telemetry, latency, token usage, the
 * accumulated response text, and any error — plus the `reset()` shared by
 * both paths at the start of a new send.
 */
export function usePlaygroundTelemetry() {
  const [state, setState] = useState<TelemetryState>('idle');
  const [meta, setMeta] = useState<GatewayMeta | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [usage, setUsage] = useState<PlaygroundUsage | null>(null);
  const [response, setResponse] = useState('');
  const [error, setError] = useState<string | null>(null);

  /** Clears the previous run's telemetry/response and marks a new one running. */
  function reset() {
    setError(null);
    setResponse('');
    setMeta(null);
    setUsage(null);
    setLatencyMs(null);
    setState('running');
  }

  /** Records a request failure, deriving a user-facing message from the thrown value. */
  function fail(e: unknown, fallback: string) {
    setError(e instanceof Error ? e.message : fallback);
    setState('error');
  }

  return {
    state,
    meta,
    latencyMs,
    usage,
    response,
    error,
    setState,
    setMeta,
    setLatencyMs,
    setUsage,
    setResponse,
    setError,
    reset,
    fail,
  };
}

export type PlaygroundTelemetry = ReturnType<typeof usePlaygroundTelemetry>;
