import { AsyncLocalStorage } from 'node:async_hooks';
import { acruxcoreError } from './error';

/**
 * Prompt overrides: run your app on a prompt version that no alias points at yet.
 *
 * An app asks for a prompt by name and alias (`render('support-agent', 'production', …)`).
 * To test a candidate version in the whole app — retrieval, tools and all — before moving
 * `production` to it, the app's code must not change. So a pin is held in an
 * `AsyncLocalStorage`: inside {@link pinPrompts} (and inside every task a local experiment
 * runs with `promptOverrides`), `prompts.render` and `prompts.getByAlias` return the pinned
 * version for that prompt name, whatever alias the code asked for. The alias still decides
 * the tools, so only the template changes.
 *
 * Async-local rather than global, so a baseline run and a candidate run can share one
 * client at the same time (`experiments.compareLocal`) without seeing each other's pins.
 */
const pinned = new AsyncLocalStorage<Readonly<Record<string, number>>>();

/**
 * A checked copy of `{ promptName: versionNumber }`, so a typo fails before a local run
 * is created rather than on its first render.
 *
 * @param overrides - `{ promptName: versionNumber }`; null or undefined means no pins.
 * @returns A new object holding the same pins.
 * @throws {acruxcoreError} VALIDATION_ERROR for an empty name or a version that is not a
 *   positive integer.
 */
export function validateOverrides(overrides: Record<string, number> | null | undefined): Record<string, number> {
  const checked: Record<string, number> = {};
  for (const [name, version] of Object.entries(overrides ?? {})) {
    if (!name) throw new acruxcoreError('acruxcore: promptOverrides keys must be prompt names.', 'VALIDATION_ERROR');
    if (!Number.isInteger(version) || version < 1) {
      throw new acruxcoreError(
        `acruxcore: promptOverrides["${name}"] is ${JSON.stringify(version)}; it must be a version number such as 7.`,
        'VALIDATION_ERROR',
      );
    }
    checked[name] = version;
  }
  return checked;
}

/**
 * Runs `fn` with prompt versions pinned by name. Every `prompts.render` and
 * `prompts.getByAlias` of a pinned prompt inside it — including in code `fn` awaits or
 * starts — returns the pinned version.
 *
 * ```typescript
 * const answer = await pinPrompts({ 'support-agent': 7 }, () => myApp(question));
 * ```
 *
 * Pins nest: an inner call adds to, and may replace, the outer call's pins.
 *
 * @param overrides - `{ promptName: versionNumber }`.
 * @param fn - The code to run with the pins.
 * @returns What `fn` returns.
 * @throws {acruxcoreError} VALIDATION_ERROR for a version that is not a positive integer.
 */
export function pinPrompts<T>(overrides: Record<string, number>, fn: () => T): T {
  const merged = { ...(pinned.getStore() ?? {}), ...validateOverrides(overrides) };
  return pinned.run(merged, fn);
}

/**
 * The version pinned for `promptName` in the current async context.
 *
 * `prompts.render` and `prompts.getByAlias` apply pins on their own. Read this when the
 * app renders a prompt some other way — for example a gateway request with a `prompt`
 * reference, which the gateway renders on the server, where no pin can reach it.
 * Outside a pin it returns undefined, and `JSON.stringify` leaves `version` out:
 *
 * ```typescript
 * prompt: { name: 'support-agent', alias: 'production', version: pinnedVersion('support-agent') }
 * ```
 *
 * @param promptName - The prompt's exact name, as the pin names it.
 * @returns The pinned version number, or undefined when nothing pins `promptName`.
 */
export function pinnedVersion(promptName: string): number | undefined {
  return pinned.getStore()?.[promptName];
}
