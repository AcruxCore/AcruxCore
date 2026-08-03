import { useState } from 'react';
import type { CompletionBody } from '@/api';
import { gatewayComplete, gatewayStream } from '@/api';
import type { PlaygroundTelemetry } from './usePlaygroundTelemetry';

/**
 * The original single-shot request path (streamed or not) — used whenever no
 * tools are attached (see the Global Constraint in the TC5 plan: the
 * tool-calling loop must never change this path's behavior).
 */
export function useSingleShotSend(telemetry: PlaygroundTelemetry, buildBody: () => CompletionBody) {
  const [stream, setStream] = useState(false);

  async function send() {
    let body: CompletionBody;
    try {
      body = buildBody();
    } catch (e) {
      telemetry.setError(e instanceof Error ? e.message : 'Invalid request');
      telemetry.setState('error');
      return;
    }

    telemetry.reset();

    try {
      if (stream) {
        const started = performance.now();
        await gatewayStream(body, {
          onMeta: (m) => telemetry.setMeta(m),
          onDelta: (t) => telemetry.setResponse((r) => r + t),
        });
        telemetry.setLatencyMs(Math.round(performance.now() - started));
      } else {
        const result = await gatewayComplete(body);
        telemetry.setMeta(result.meta);
        telemetry.setResponse(result.completion.choices[0]?.message?.content ?? '');
        telemetry.setUsage({
          prompt: result.completion.usage.prompt_tokens,
          completion: result.completion.usage.completion_tokens,
        });
        telemetry.setLatencyMs(result.latencyMs);
      }
      telemetry.setState('done');
    } catch (e) {
      telemetry.fail(e, 'Request failed');
    }
  }

  return { stream, setStream, send };
}
