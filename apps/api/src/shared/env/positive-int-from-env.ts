/**
 * Reads a positive whole number from the environment.
 *
 * Unset or empty means "use the default" and is not reported. A value that is set but is
 * not a positive integer (non-numeric, fractional, zero or negative) is ignored with a
 * warning that names it, so a mistyped setting is visible instead of silently replaced.
 * `Number('')` is 0, which for a timeout or a cap would mean "at once" or "never", so an
 * empty export is never taken at its word.
 *
 * Read it on every use rather than once at load, so an operator restart or a test can
 * change it.
 *
 * @param name - The environment variable.
 * @returns The value, or `undefined` when unset, empty or unusable.
 */
export function positiveIntFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    console.warn(`[env] ignoring ${name}=${JSON.stringify(raw)}: not a positive whole number; using the default`);
    return undefined;
  }
  return value;
}
