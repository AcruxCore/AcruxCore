import type { Application } from 'express';

/**
 * Walks an Express app's real mounted router tree and flattens it to one entry
 * per method/path, with the guard middleware named in front of each.
 *
 * Shared by the two policy suites — `route-policy.test.ts` (which role gates a
 * route) and `cross-tenant.test.ts` (which resource ids it accepts) — because
 * both need the same question answered: what is actually mounted, right now.
 * Reading the routers instead would miss a route mounted from somewhere else,
 * which is the failure mode both suites exist to catch.
 *
 * It lives in `test-utils` rather than beside either suite so the two cannot
 * drift: the first copy of this walk could not see through a router mounted at a
 * path parameter, so every `/teams/:id/members/...` route came out as
 * `/api/v1/teams/...` and silently fell outside any prefix filter.
 */

/** One mounted route: its method, its full path, and the guards in front of it. */
export interface MountedRoute {
  method: string;
  /** Full path with parameters kept as `:name`, e.g. `/api/v1/teams/:id/members/:userId`. */
  path: string;
  /** Named middleware in front of the handler; anonymous functions are dropped. */
  guards: string[];
}

/** Layer shapes Express 4 puts on `app._router.stack`, narrowed enough to walk. */
interface Layer {
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ name: string }> };
  handle?: { stack?: Layer[] };
  regexp?: RegExp;
  keys?: Array<{ name: string }>;
}

/**
 * Recovers the path a sub-router was mounted at from its mount regexp.
 *
 * A literal mount (`app.use('/api/v1/prompts', …)`) produces a regexp of escaped
 * literals. A parameterised one (`teamsRouter.use('/:id/members', …)`) replaces
 * that segment with a capture group and records the name in `layer.keys`, so the
 * two have to be reassembled together — dropping the capture groups would fuse
 * `/teams/:id/members/:userId` into `/teams/:userId` and quietly under-report the
 * whole team-management surface.
 *
 * @param layer - A stack layer holding a sub-router.
 * @returns The mount path with parameters restored as `:name`, or `''` at the root.
 */
function prefixOf(layer: Layer): string {
  let source = layer.regexp?.source ?? '';
  // The app-level "matches everything" layer.
  if (source === '^\\/?(?=\\/|$)') return '';
  // Trim the trailing separator assertion the mount regexp carries, or every
  // nested path comes out with a doubled slash and matches no prefix.
  source = source.replace(/\\?\/\?\(\?=\\?\/\|\$\)$/, '').replace(/^\^/, '');
  const names = (layer.keys ?? []).map((k) => k.name);
  source = source.replace(/\(\?:\\?\/\(\[\^\/\]\+\?\)\)/g, () => `/:${names.shift() ?? '?'}`);
  const path = source.replace(/\\\//g, '/').replace(/\/+$/, '');
  // Everything above understands two mount shapes: escaped literals, and the one
  // capture group Express writes for `:param`. Anything else — a mount path with
  // a regex-escaped character such as `/v1.0/`, or a constrained parameter —
  // would come through as regex source and produce a path that matches nothing.
  // The suites built on this walk would then just not probe those routes, and
  // report a clean run. Fail loudly instead.
  if (/[\\()[\]?+*^$|]/.test(path)) {
    throw new Error(
      `Cannot read the mount path from ${String(layer.regexp)} — got ${path}. ` +
        'prefixOf understands literal mounts and `:param` mounts only; teach it this shape ' +
        'rather than letting the route-policy and cross-tenant suites silently skip it.',
    );
  }
  return path;
}

/**
 * Flattens a mounted router stack into one {@link MountedRoute} per method/path.
 *
 * @param stack - A router stack, normally `app._router.stack`.
 * @param prefix - Path accumulated from enclosing mounts; callers pass nothing.
 * @returns Every mounted route, in mount order.
 */
function collect(stack: Layer[], prefix = ''): MountedRoute[] {
  const out: MountedRoute[] = [];
  for (const layer of stack) {
    if (layer.route) {
      const guards = layer.route.stack.map((h) => h.name).filter((n) => n && n !== '<anonymous>');
      for (const method of Object.keys(layer.route.methods)) {
        const path = (prefix + layer.route.path).replace(/\/+$/, '') || '/';
        out.push({ method: method.toUpperCase(), path, guards });
      }
    } else if (layer.handle?.stack) {
      out.push(...collect(layer.handle.stack, prefix + prefixOf(layer)));
    }
  }
  return out;
}

/**
 * Every route mounted on an app, flattened.
 *
 * @param app - An app from `createApp()`.
 * @returns One entry per method/path. Never empty for a real app — a caller that
 *   filters this list should assert it found something first, since an empty walk
 *   would silently pass every policy built on top of it.
 */
export function mountedRoutes(app: Application): MountedRoute[] {
  // `_router` is private to Express and therefore untyped; there is no public
  // API that exposes the mounted tree.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return collect((app as any)._router.stack as Layer[]);
}

/** `METHOD /path` — the key both policy suites index a route by. */
export function routeKey(route: MountedRoute): string {
  return `${route.method} ${route.path}`;
}
