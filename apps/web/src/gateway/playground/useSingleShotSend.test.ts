// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompletionBody } from '@/api';
import { usePlaygroundTelemetry } from './usePlaygroundTelemetry';
import { useSingleShotSend } from './useSingleShotSend';

/** A streamed gateway response carrying one delta, the usage chunk, then `[DONE]`. */
function streamedResponse(): Response {
  const frames = [
    { object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: null }] },
    { object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 22, completion_tokens: 8, total_tokens: 30 } },
  ]
    .map((f) => `data: ${JSON.stringify(f)}\n\n`)
    .join('');
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`${frames}data: [DONE]\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

const BODY: CompletionBody = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useSingleShotSend streamed telemetry (issue #834)', () => {
  it('fills the Tokens telemetry from a streamed call', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamedResponse()));
    const { result } = renderHook(() => {
      const telemetry = usePlaygroundTelemetry();
      const send = useSingleShotSend(telemetry, () => BODY);
      return { telemetry, send };
    });

    act(() => result.current.send.setStream(true));
    await act(async () => {
      await result.current.send.send();
    });

    await waitFor(() => expect(result.current.telemetry.state).toBe('done'));
    expect(result.current.telemetry.response).toBe('Hi');
    expect(result.current.telemetry.usage).toEqual({ prompt: 22, completion: 8 });
  });
});
