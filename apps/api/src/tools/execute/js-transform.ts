import ivm from 'isolated-vm';

/** Thrown when a transform fails to compile, throws, or exceeds its time/memory budget. */
export class TransformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransformError';
  }
}

/** A syntax-checked transform, ready to run. Re-compiled inside a fresh isolate on every call. */
export interface CompiledTransform {
  code: string;
}

/**
 * Memory ceiling (MB) for every transform isolate — both the throwaway syntax-check
 * isolate in `compileTransform` and the per-execution isolate in `evaluateTransform`.
 * 8 MB is generous for a pure data-shaping function operating on small JSON payloads
 * and is enforced by V8 itself (`new ivm.Isolate({ memoryLimit })`), not a soft/cooperative cap.
 */
const MEMORY_LIMIT_MB = 8;

/**
 * The longest result a transform may hand back, in characters of its JSON encoding.
 *
 * The isolate's memory cap does not bound the result: a string doubled by concatenation
 * is a chain of small cons-string nodes inside the isolate, and copying it out flattens
 * all of it in the API process. So the result is encoded and measured inside the isolate,
 * under the same timeout, and only a string within this limit crosses the boundary.
 *
 * 2 Mi characters is twice the 1 MB response body the executor accepts (`safe-fetch.ts`),
 * so a response transform that passes a maximum-size body through, re-encoded, always
 * fits. A request transform shapes tool arguments, which are smaller still.
 */
export const MAX_TRANSFORM_RESULT_CHARS = 2 * 1024 * 1024;

/**
 * Wraps a user-supplied `transform(input)` body so it can be invoked with the injected
 * `input` global, and its result returned as a JSON string no longer than
 * {@link MAX_TRANSFORM_RESULT_CHARS}, or `undefined`.
 *
 * A function, symbol or Promise anywhere in the result is refused, as the structured
 * clone this replaced refused it, rather than silently dropped by `JSON.stringify`. The
 * limit is a literal in the source, not a global the transform could overwrite first.
 */
function wrap(code: string): string {
  return `${code}
;(function (result) {
  if (result === undefined) return undefined;
  var json = JSON.stringify(result, function (key, value) {
    if (typeof value === 'function' || typeof value === 'symbol' || value instanceof Promise) {
      throw new Error('transform must return plain JSON');
    }
    return value;
  });
  if (typeof json !== 'string') throw new Error('transform must return plain JSON');
  if (json.length > ${MAX_TRANSFORM_RESULT_CHARS}) {
    throw new Error('transform result passes the ${MAX_TRANSFORM_RESULT_CHARS} character limit');
  }
  return json;
})(transform(input));`;
}

/**
 * Syntax-checks a transform in a throwaway isolate. Call at commit time so a script
 * that fails to compile makes the tool version un-committable.
 *
 * @param code - A JavaScript source defining `function transform(input) { ... }`.
 * @returns The compiled transform (just the original source — isolated-vm re-compiles
 *   fresh inside a new isolate on every `evaluateTransform` call rather than reusing a
 *   handle, since a `Script`/`Isolate` handle cannot outlive the isolate that produced it).
 * @throws {TransformError} When the script cannot be parsed.
 */
export function compileTransform(code: string): CompiledTransform {
  const isolate = new ivm.Isolate({ memoryLimit: MEMORY_LIMIT_MB });
  try {
    isolate.compileScriptSync(wrap(code));
  } catch (err) {
    throw new TransformError(`Invalid transform: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    isolate.dispose();
  }
  return { code };
}

/**
 * Runs a compiled transform against an input inside a fresh `isolated-vm` isolate:
 * no bridged globals (no `require`/`fetch`/`process`/filesystem/network — the only
 * data crossing the boundary is the plain-JSON `input`/return value via `ExternalCopy`
 * and the `copy: true` result-transfer option), a memory cap, and a wall-clock timeout
 * the isolate itself enforces (it can kill an infinite loop, unlike a cooperative check).
 *
 * A fresh isolate is created per call and never pooled/reused — reusing an isolate
 * across different teams' scripts (or even across two calls for the same team) would
 * let state leak between executions, which is a cross-tenant risk this design avoids
 * by construction.
 *
 * @param compiled - A syntax-checked transform (from `compileTransform`).
 * @param input - The JSON input (tool arguments, or `{status,headers,body}`).
 * @param timeoutMs - Wall-clock budget in milliseconds.
 * @returns The transform's return value, after a JSON round trip: plain JSON in, plain JSON
 *   out (a `Date` arrives as its ISO string, `NaN` as `null`), or `undefined`.
 * @throws {TransformError} When the script throws, times out, returns something that is not
 *   plain JSON, or returns more than {@link MAX_TRANSFORM_RESULT_CHARS} characters of it.
 */
export async function evaluateTransform(compiled: CompiledTransform, input: unknown, timeoutMs: number): Promise<unknown> {
  const isolate = new ivm.Isolate({ memoryLimit: MEMORY_LIMIT_MB });
  try {
    const context = await isolate.createContext();
    await context.global.set('input', new ivm.ExternalCopy(input).copyInto());
    const script = await isolate.compileScript(wrap(compiled.code));
    const json = (await script.run(context, { timeout: timeoutMs, copy: true })) as string | undefined;
    return json === undefined ? undefined : (JSON.parse(json) as unknown);
  } catch (err) {
    throw new TransformError(`Transform failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    // Runs on every path (success, thrown error, and timeout) so a runaway isolate
    // never keeps burning CPU/memory in the background after the call settles. An isolate
    // that hit its memory limit is already disposed, and disposing it again would throw
    // "Isolate is already disposed" over the TransformError that says what happened.
    if (!isolate.isDisposed) isolate.dispose();
  }
}
