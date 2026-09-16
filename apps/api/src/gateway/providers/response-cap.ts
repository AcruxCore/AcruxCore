import { ProviderError } from './adapter';

/**
 * The largest buffered provider response the gateway will read, in bytes.
 *
 * 25 MB, against the tool executor's 1 MB (`safe-fetch.ts`). The two numbers
 * differ because the things differ: a tool result is a record or a small
 * document, and a megabyte of one is already suspicious, while a completion is
 * the product the caller paid for. A 128k-token answer is roughly half a
 * megabyte of text and `logprobs` with a wide `top_logprobs` multiplies that
 * many times over, so the cap sits far above any real answer. It is there to
 * bound a broken or hostile endpoint, not to ration a long reply.
 *
 * It matters most on the `openai_compatible` path, where `base_url` comes from
 * the team — the BYOK and self-hosted-model case, the same caller-chosen
 * destination a tool executor has. It applies to the first-party providers too:
 * a bound that only covers the path someone remembered to think about is the
 * gap this closes (#509).
 */
export const MAX_PROVIDER_RESPONSE_BYTES = 25 * 1024 * 1024;

/**
 * Wraps a response body so reading it fails once it passes `maxBytes`.
 *
 * Counted while reading rather than after, and in **bytes** rather than string
 * length. Reading the whole body and then measuring it would have already done
 * the buffering the cap exists to prevent, and `String.length` counts UTF-16
 * code units, so a multi-byte body measures smaller than it is. Both were the
 * mistakes #496 fixed on the tool path; this is the same guard on the model one.
 *
 * A response with no readable body — a 204, or a `Response` that was never
 * backed by a stream — is returned untouched. There is nothing to read, so
 * there is nothing to bound.
 *
 * @param res - The provider's response.
 * @param providerLabel - Names the provider in the error, e.g. `'OpenAI'`.
 * @param maxBytes - The ceiling. Defaults to {@link MAX_PROVIDER_RESPONSE_BYTES}.
 * @returns A response whose body errors past the ceiling, or `res` unchanged
 *   when it has no body to wrap.
 */
export function capResponseBody(
  res: Response,
  providerLabel: string,
  maxBytes: number = MAX_PROVIDER_RESPONSE_BYTES,
): Response {
  if (!res.body) return res;

  let bytes = 0;
  const capped = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) {
          // `error` rather than `terminate`: a terminated stream ends cleanly and
          // the caller would parse a truncated body as if it were the whole answer.
          controller.error(
            new ProviderError(
              `${providerLabel} response exceeds the ${maxBytes} byte limit`,
              502,
              'response_too_large',
              // Not retryable: the same endpoint would send the same body again.
              false,
            ),
          );
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );

  // `status: 204` and friends reject a body, but those have no body to wrap and
  // returned above — so every response reaching here can carry one.
  return new Response(capped, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}
