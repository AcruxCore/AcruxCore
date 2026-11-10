import { Agent, Dispatcher1Wrapper } from 'undici';

/**
 * How long an idle connection to a model provider stays open for reuse, in milliseconds.
 *
 * Node's built-in `fetch` closes an idle connection after 4 seconds, so a caller that
 * paused longer paid a new TCP and TLS handshake on its next call: about 33 ms to a near
 * OpenAI edge address and about 250 ms to a far one. 60 seconds covers a caller that
 * sends one request a minute. OpenAI, Anthropic and Gemini all kept an idle HTTP/1.1
 * connection open past 65 seconds when measured, and none sends a `Keep-Alive` header,
 * so 60 seconds closes the connection before they do (phase-2 FAQ Q34).
 */
export const PROVIDER_KEEP_ALIVE_MS = 60_000;

/**
 * The connection pool for calls to a provider's default base URL.
 *
 * It is passed per call by `guardedFetch`, not installed as the global dispatcher, so
 * only provider calls get the longer keep-alive and every process that loads the gateway
 * (the API and the worker) gets it without a start-up step.
 *
 * - `keepAliveMaxTimeout` keeps undici's default. It only caps how long a server's own
 *   `Keep-Alive: timeout=N` header may hold a connection, and lowering it would close
 *   connections that a server says are still good.
 * - `allowH2: false` keeps HTTP/1.1, which is what Node's built-in `fetch` speaks. The
 *   undici 8 default offers HTTP/2, and all three providers accept it, which would
 *   silently move every provider call to a different protocol stack.
 * - The `Agent` is wrapped in `Dispatcher1Wrapper` because Node 22's built-in `fetch` is
 *   undici 6, which speaks the older handler interface; a bare undici 8 `Agent` fails
 *   with `invalid onRequestStart method`. This is the same wrapper undici 8's own
 *   `setGlobalDispatcher` puts in front of the global dispatcher for that `fetch`.
 */
export const PROVIDER_DISPATCHER = new Dispatcher1Wrapper(
  new Agent({ keepAliveTimeout: PROVIDER_KEEP_ALIVE_MS, allowH2: false }),
);
