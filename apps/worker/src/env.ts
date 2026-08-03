import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from 'dotenv';

/**
 * Loads the monorepo's single root `.env` into this process, for local
 * development only.
 *
 * The worker has no `.env` of its own and its working directory is
 * `apps/worker`, so `dotenv/config` — which looks at `cwd/.env` — finds nothing.
 * There is one `.env` for the whole repo (see its own header comment), so this
 * walks up from wherever this file actually lives — `src` under `tsx`, `dist`
 * once built — until it finds `turbo.json`, the repo root marker, and loads
 * `.env` from there.
 *
 * `override` is left at its default of false, so a variable already present in
 * the real environment always wins. In production `docker-compose.yml` passes
 * every value explicitly and no such file exists in the image, making this a
 * no-op there.
 */
export function loadWorkerEnv(): void {
  let dir = __dirname;
  while (!existsSync(join(dir, 'turbo.json'))) {
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
  config({ path: join(dir, '.env') });
}

loadWorkerEnv();
