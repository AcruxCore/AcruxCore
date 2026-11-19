import { z } from 'zod';

/**
 * The hosted endpoint's own view of where the API lives, so the MCP tools can reach the
 * rest of the API over loopback.
 *
 * Set once by `server.ts` from the address the HTTP server actually bound to, rather
 * than reconstructed from `PORT`. Reconstruction is where this goes wrong: the port that
 * ends up in the environment and the port the process listens on are the same value
 * right up until a deployment sets one and not the other, and the failure then looks
 * like "every MCP tool call times out" rather than "the URL is wrong".
 */
let selfBaseUrl: string | undefined;

/**
 * Records the base URL the API is serving on.
 *
 * @param url - Absolute base URL including the `/api/v1` prefix.
 */
export function setSelfBaseUrl(url: string): void {
  selfBaseUrl = url;
}

/**
 * Returns the base URL the MCP tools should call.
 *
 * Falls back to `MCP_SELF_BASE_URL`, then to the same PORT/API_PORT chain `server.ts`
 * uses — that path is what a test importing `createApp()` directly gets, since nothing
 * called {@link setSelfBaseUrl}.
 *
 * @returns Base URL ending in `/api/v1`.
 */
export function getSelfBaseUrl(): string {
  if (selfBaseUrl) return selfBaseUrl;
  if (process.env.MCP_SELF_BASE_URL) return process.env.MCP_SELF_BASE_URL;
  const port = process.env.PORT ?? process.env.API_PORT ?? '3000';
  return `http://127.0.0.1:${port}/api/v1`;
}

/**
 * Options a hosted client may set as query parameters on the endpoint URL.
 *
 * The names are the local server's CLI flags, so `--read-only --toolsets prompts` on the
 * command line and `?read-only=true&toolsets=prompts` on the URL mean the same thing.
 * `base-url` and `api-key` are absent on purpose: the hosted endpoint always calls itself,
 * and a key in a URL ends up in logs.
 */
export const HOSTED_OPTIONS = [
  'toolsets',
  'read-only',
  'prompt-alias',
  'max-text-bytes',
  'timeout-ms',
] as const;

/** One of {@link HOSTED_OPTIONS}. */
export type HostedOption = (typeof HOSTED_OPTIONS)[number];

/**
 * Longest per-request timeout a hosted caller may ask for, in milliseconds (5 minutes).
 *
 * The local server takes any positive number because the caller owns that process. Here
 * the caller holds a loopback socket open on our API for as long as they ask, and past
 * Node's 32-bit timer limit (~24.8 days) the timeout fires after 1 ms instead, so every
 * tool call would fail at once.
 */
export const HOSTED_MAX_TIMEOUT_MS = 300_000;

/**
 * Largest tool-result text a hosted caller may ask for, in bytes (1 MB). Above it the
 * truncation that keeps a single result from filling the model's context is effectively
 * off, and the whole result is held in the API's memory per call.
 */
export const HOSTED_MAX_TEXT_BYTES = 1_000_000;

/** Values the hosted `read-only` option accepts, matching the local server's boolean words. */
const BOOLEAN_WORDS = ['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'];

/**
 * A query option that takes one value. Express's query parser turns a repeated parameter
 * into an array and `a[b]=c` into an object; neither has a meaning here, and joining an
 * array with commas (as `toolsets` does) would turn `read-only=true&read-only=true` into
 * `true,true`, which the local server reads as false.
 *
 * @param name - The option name, for the error message.
 */
function singleValue(name: HostedOption) {
  return z
    .unknown()
    .superRefine((value, ctx) => {
      if (Array.isArray(value)) {
        ctx.addIssue({ code: 'custom', message: `MCP option "${name}" was given more than once.` });
      } else if (typeof value !== 'string') {
        ctx.addIssue({ code: 'custom', message: `MCP option "${name}" must be a plain value.` });
      }
    })
    .transform((value) => value as string)
    .optional();
}

/**
 * A numeric option with a hosted-only ceiling. Values that are not positive integers pass
 * through untouched so the local server's own parser rejects them with its usual message.
 *
 * @param name - The option name, for the error message.
 * @param max - Largest value accepted.
 */
function cappedNumber(name: HostedOption, max: number) {
  return singleValue(name).superRefine((value, ctx) => {
    if (value !== undefined && Number(value) > max) {
      ctx.addIssue({
        code: 'custom',
        message: `MCP option "${name}" must be at most ${max} on the hosted endpoint, got "${value}".`,
      });
    }
  });
}

/**
 * The hosted endpoint's query parameters.
 *
 * - `toolsets` may repeat; the values are joined with commas, as the CLI flag takes them.
 * - Every other option takes one value and is rejected when repeated.
 * - A bare `?read-only` (empty value) means true, like the bare `--read-only` flag. Any
 *   value outside {@link BOOLEAN_WORDS} is rejected, so a typo such as `?read-only=ture`
 *   cannot silently leave the write tools on.
 * - Any other parameter is rejected rather than ignored, for the same reason: a misspelt
 *   `?readonly=true` must not quietly give a full, write-capable server.
 */
export const HostedMcpQuerySchema = z
  .object({
    toolsets: z
      .union([z.string(), z.array(z.string())], {
        errorMap: () => ({ message: 'MCP option "toolsets" must be a plain value.' }),
      })
      .transform((value) => (Array.isArray(value) ? value.join(',') : value))
      .optional(),
    'read-only': singleValue('read-only')
      .transform((value) => (value === undefined || value.trim() !== '' ? value : 'true'))
      .superRefine((value, ctx) => {
        if (value !== undefined && !BOOLEAN_WORDS.includes(value.trim().toLowerCase())) {
          ctx.addIssue({
            code: 'custom',
            message: `MCP option "read-only" must be one of ${BOOLEAN_WORDS.join(', ')}, got "${value}".`,
          });
        }
      }),
    'prompt-alias': singleValue('prompt-alias'),
    'max-text-bytes': cappedNumber('max-text-bytes', HOSTED_MAX_TEXT_BYTES),
    'timeout-ms': cappedNumber('timeout-ms', HOSTED_MAX_TIMEOUT_MS),
  })
  .passthrough()
  .superRefine((query, ctx) => {
    for (const name of Object.keys(query)) {
      if (!(HOSTED_OPTIONS as readonly string[]).includes(name)) {
        ctx.addIssue({
          code: 'custom',
          message: `Unknown MCP option "${name}". Valid options: ${HOSTED_OPTIONS.join(', ')}.`,
        });
        return;
      }
    }
  });

/** Validated hosted options, each as the string the matching CLI flag would carry. */
export type HostedMcpQuery = Partial<Record<HostedOption, string>>;
