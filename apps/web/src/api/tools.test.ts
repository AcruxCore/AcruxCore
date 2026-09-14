// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keys } from './queryClient';
import { useCommitToolVersion, useCreateToolWithVersion, usePromoteToolAlias } from './tools';
import type { ToolAlias, ToolSummary, ToolVersion } from './types';

/** A response object shaped exactly the way `api()` reads it — no real fetch involved. */
function fakeResponse(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Wraps a hook in the QueryClientProvider every hook in `./tools` needs. */
function wrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useCommitToolVersion', () => {
  /**
   * Regression test for the stale readiness badge (PR #469 review, finding 3a). Readiness
   * (`callable`, `executorType`, …) moved onto the tool resource, keyed at `keys.tools` /
   * `keys.tool(id)`. Invalidating only `keys.toolVersions`/`keys.toolAliases` never
   * touches that prefix, so committing a first version left the amber "not callable"
   * badge showing on a page that was still mounted.
   */
  it('invalidates the shared tools cache so the readiness badge refetches', async () => {
    const qc = new QueryClient();
    // Seed a cache entry the way the catalog/detail page already have one mounted — an
    // invalidation with no matching cached query would trivially "pass" this assertion.
    qc.setQueryData(keys.tools, [] as ToolSummary[]);

    const version: ToolVersion = {
      id: 'v1',
      toolId: 'tool-1',
      description: null,
      changelog: null,
      source: 'dashboard',
      versionNumber: 1,
      parametersSchema: { type: 'object', properties: {} },
      executor: { type: 'client' },
      createdBy: 'user-1',
      createdAt: new Date().toISOString(),
    };
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(version)));

    const { result } = renderHook(() => useCommitToolVersion('tool-1'), { wrapper: wrapper(qc) });
    result.current.mutate({ source: 'dashboard', parametersSchema: {}, executor: { type: 'client' } });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(qc.getQueryState(keys.tools)?.isInvalidated).toBe(true);
  });
});

describe('usePromoteToolAlias', () => {
  /**
   * Same finding (3a), the alias-promote side: the header badge and the `/tools` row
   * summary both read from `keys.tools`/`keys.tool(id)`, so promoting an alias must
   * invalidate that prefix too, not just `keys.toolAliases`.
   */
  it('invalidates the shared tools cache', async () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.tools, [] as ToolSummary[]);

    const alias: ToolAlias = {
      id: 'a1',
      alias: 'production',
      versionId: 'v2',
      versionNumber: 2,
      updatedAt: new Date().toISOString(),
    };
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(alias)));

    const { result } = renderHook(() => usePromoteToolAlias('tool-1'), { wrapper: wrapper(qc) });
    result.current.mutate({ alias: 'production', versionNumber: 2 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(qc.getQueryState(keys.tools)?.isInvalidated).toBe(true);
  });
});

describe('useCreateToolWithVersion', () => {
  /**
   * Regression test for finding 3b: the one-step dialog's single Description field must
   * reach both writes. Sending `{ name }` alone to the shell POST left every
   * dashboard-created tool with a null catalog description forever — nothing else ever
   * re-sends it after creation.
   */
  it('sends the description on the shell POST, not just the version POST', async () => {
    const qc = new QueryClient();
    const shellBodies: unknown[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      if (shellBodies.length === 0) {
        shellBodies.push(body);
        const tool: ToolSummary = {
          id: 'tool-1',
          name: 'get_weather',
          description: body?.description ?? null,
          teamId: 'team-1',
          createdBy: 'user-1',
          createdAt: new Date().toISOString(),
          callable: false,
          versionCount: 0,
          latestVersionNumber: null,
          executorType: null,
          aliases: [],
        };
        return fakeResponse(tool);
      }
      const version: ToolVersion = {
        id: 'v1',
        toolId: 'tool-1',
        description: body?.description ?? null,
        changelog: null,
        source: 'dashboard',
        versionNumber: 1,
        parametersSchema: {},
        executor: { type: 'client' },
        createdBy: 'user-1',
        createdAt: new Date().toISOString(),
      };
      return fakeResponse(version);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useCreateToolWithVersion(), { wrapper: wrapper(qc) });
    result.current.mutate({
      name: 'get_weather',
      description: 'Looks up the current weather.',
      version: {
        source: 'dashboard',
        parametersSchema: {},
        executor: { type: 'client' },
        description: 'Looks up the current weather.',
      },
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(shellBodies).toEqual([{ name: 'get_weather', description: 'Looks up the current weather.' }]);
  });
});
