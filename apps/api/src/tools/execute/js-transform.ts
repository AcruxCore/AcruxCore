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

/** Wraps a user-supplied `transform(input)` body so it can be invoked with the injected `input` global. */
function wrap(code: string): string {
  return `${code}\ntransform(input);`;
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
 * @returns The transform's return value (must be plain JSON — functions/classes don't survive the copy).
 * @throws {TransformError} When the script throws, times out, or its return value isn't copyable.
 */
export async function evaluateTransform(compiled: CompiledTransform, input: unknown, timeoutMs: number): Promise<unknown> {
  const isolate = new ivm.Isolate({ memoryLimit: MEMORY_LIMIT_MB });
  try {
    const context = await isolate.createContext();
    await context.global.set('input', new ivm.ExternalCopy(input).copyInto());
    const script = await isolate.compileScript(wrap(compiled.code));
    return await script.run(context, { timeout: timeoutMs, copy: true });
  } catch (err) {
    throw new TransformError(`Transform failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    // Runs on every path (success, thrown error, and timeout) so a runaway isolate
    // never keeps burning CPU/memory in the background after the call settles.
    isolate.dispose();
  }
}
