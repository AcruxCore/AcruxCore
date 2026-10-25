import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ROUTES } from '@/marketing/entry-prerender';

/**
 * nginx decides the HTTP status before React ever runs, so it has to know which
 * paths are real dashboard routes (200, the app shell) and which are typos (a
 * real 404). That list lives as a regex in `apps/web/nginx.conf`, a file
 * TypeScript cannot import from. These tests read both files and fail when a
 * route is added to the router without being added to nginx — which would
 * otherwise ship as a 404 on a page that works in the dev server.
 */
const appTsx = readFileSync(fileURLToPath(new URL('./App.tsx', import.meta.url)), 'utf8');
const nginxConf = readFileSync(fileURLToPath(new URL('../../nginx.conf', import.meta.url)), 'utf8');

/** Every `path="..."` the router declares, minus the catch-all. */
const routerPaths = [...appTsx.matchAll(/<Route\s+path="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((p) => p !== '*');

const prerendered = new Set(ROUTES.map((r) => r.path));

/** Router paths that nginx can only serve through the app shell. */
const appPaths = routerPaths.filter((p) => !prerendered.has(p) && !p.startsWith('/features/'));

/** The regex of the nginx location that serves the app shell. */
function appShellRegex(): RegExp {
  const match = nginxConf.match(/location ~ (\^\/\([^\s]+) \{\s*\n(?:\s*#.*\n)*[^}]*app-shell\.html/);
  if (!match) throw new Error('No app-shell location found in nginx.conf');
  return new RegExp(match[1]);
}

describe('nginx app-shell routes', () => {
  it('found the router paths to check', () => {
    expect(appPaths.length).toBeGreaterThan(30);
    expect(appPaths).toContain('/login');
    expect(appPaths).toContain('/prompts/:id');
  });

  it.each(appPaths)('serves %s through the app shell', (path) => {
    const concrete = path.replace(/:[a-z]+/gi, 'abc123');
    expect(concrete).toMatch(appShellRegex());
  });

  it.each(['/zzz-nonexistent-123', '/llms-full.txt', '/dashboard', '/promptsx', '/loginx', '/wp-admin'])(
    'does not serve %s as a dashboard route',
    (path) => {
      expect(path).not.toMatch(appShellRegex());
    },
  );

  it('answers every other unknown path with a real 404 page', () => {
    const rootLocation = nginxConf.match(/location \/ \{[^}]*\}/)?.[0] ?? '';
    expect(rootLocation).toMatch(/try_files \$uri \$uri\/index\.html =404;/);
    expect(nginxConf).toMatch(/error_page 404 \/404\.html;/);
    expect(nginxConf).not.toMatch(/location @spa/);
  });
});
