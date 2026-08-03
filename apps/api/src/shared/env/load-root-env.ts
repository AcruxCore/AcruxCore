import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from 'dotenv';

/**
 * Loads the monorepo's single root `.env` into this process.
 *
 * There is one `.env` for the whole repo (see its own header comment), not
 * one per app. `dotenv/config` would instead load `cwd/.env`, which breaks
 * depending on where the process was launched from and doesn't exist at all
 * in `apps/api` anymore. This walks up from wherever this file actually lives
 * — `src` under `tsx`, `dist/src` once built — until it finds `turbo.json`,
 * the repo root marker, so it works the same regardless of build layout.
 *
 * `override` stays at dotenv's default of `false`, so a variable already
 * present in the real environment (e.g. loaded by direnv, or set by Docker
 * Compose in production) always wins.
 */
export function loadRootEnv(): void {
  let dir = __dirname;
  while (!existsSync(join(dir, 'turbo.json'))) {
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
  config({ path: join(dir, '.env') });
}

loadRootEnv();
