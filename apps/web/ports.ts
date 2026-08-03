import { loadEnv } from 'vite';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Finds the monorepo root by walking up from the working directory until
 * `turbo.json` appears.
 *
 * The root `.env` is the single source of truth for ports, but Vite only reads
 * env files from the app folder (`apps/web`), which has none. Resolving the
 * root here is what lets both configs below see `WEB_PORT` / `API_PORT`.
 * Walking from `process.cwd()` covers being launched from `apps/web` (turbo,
 * npm scripts) and from the repo root alike.
 */
function findRepoRoot(): string {
  let dir = process.cwd();
  while (!existsSync(join(dir, 'turbo.json'))) {
    const parent = dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
  return dir;
}

// Empty prefix = load every key, not just `VITE_`. `loadEnv` layers the real
// process env over the file, so an ambient value (direnv, CI) still wins.
// Nothing here reaches the client bundle — these values only configure the dev
// server — so the secrets that share that `.env` stay on the Node side.
const env = loadEnv('development', findRepoRoot(), '');

/**
 * Port the Vite dev server binds, resolved from the repo's single `.env`.
 *
 * `VITE_PORT` wins so a git worktree (e.g. a parallel agent session) can run
 * its own dev server without editing the shared `.env`; `WEB_PORT` is the
 * normal answer; 5173 is Vite's default, reached only if neither is set.
 */
export const WEB_PORT = Number(env.VITE_PORT ?? env.WEB_PORT ?? 5173);

/**
 * Origin the dev server proxies `/api` to — the Express API, same-origin so the
 * httpOnly session cookie is sent.
 *
 * Follows the same `API_PORT` the API itself binds, so moving the port in
 * `.env` moves both ends together.
 */
export const API_PROXY_TARGET =
  env.VITE_API_PROXY_TARGET ?? `http://localhost:${env.API_PORT ?? 3001}`;
