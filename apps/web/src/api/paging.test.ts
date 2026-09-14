import { describe, expect, it, vi } from 'vitest';
import { PAGE_SIZE, fetchAllPages } from './paging';
import type { Paginated } from './types';

/** Builds a fake API page from a slice of `all`, the way the server would return it. */
function pageOf(all: number[], page: number, limit: number): Paginated<number> {
  return { data: all.slice((page - 1) * limit, page * limit), total: all.length, page, limit };
}

describe('fetchAllPages', () => {
  /**
   * The regression this file exists for. Every tool list in the dashboard asked for
   * `/tools` with no `limit`, took the server's default of 20, and then treated that
   * page as the whole catalog. On a team with 25 tools the five newest vanished from
   * the catalog screen and the Playground picker, and — worst of all — a prompt bound
   * to one of them rendered the row as "(deleted tool)", which reads as data loss.
   */
  it('returns every page, not just the first', async () => {
    const all = Array.from({ length: 25 }, (_, i) => i);
    const fetchPage = vi.fn(async (page: number, limit: number) => pageOf(all, page, limit));

    await expect(fetchAllPages(fetchPage, 'GET /test')).resolves.toEqual(all);
    expect(fetchPage).toHaveBeenCalledTimes(Math.ceil(25 / PAGE_SIZE));
  });

  it('makes one request when everything fits on a page', async () => {
    const all = [1, 2, 3];
    const fetchPage = vi.fn(async (page: number, limit: number) => pageOf(all, page, limit));

    await expect(fetchAllPages(fetchPage, 'GET /test')).resolves.toEqual(all);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('makes one request for an empty collection', async () => {
    const fetchPage = vi.fn(async (page: number, limit: number) => pageOf([], page, limit));

    await expect(fetchAllPages(fetchPage, 'GET /test')).resolves.toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  /**
   * A `total` that outruns what the server will actually return — a row deleted between
   * two pages, or a count that is momentarily stale — must not spin forever. Stopping on
   * a short page is the condition that cannot lie.
   */
  it('stops on a short page even when total claims there is more', async () => {
    const fetchPage = vi.fn(async (page: number, limit: number) => ({
      data: page === 1 ? [1, 2, 3] : [],
      total: 10_000,
      page,
      limit,
    }));

    await expect(fetchAllPages(fetchPage, 'GET /test')).resolves.toEqual([1, 2, 3]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  /** A runaway server can't turn a list screen into an unbounded request loop. */
  it('gives up after the page cap rather than looping', async () => {
    const fetchPage = vi.fn(async (page: number, limit: number) => ({
      data: Array.from({ length: limit }, (_, i) => (page - 1) * limit + i),
      total: Number.MAX_SAFE_INTEGER,
      page,
      limit,
    }));

    const all = await fetchAllPages(fetchPage, 'GET /test');
    expect(fetchPage.mock.calls.length).toBeLessThanOrEqual(20);
    expect(all.length).toBe(fetchPage.mock.calls.length * PAGE_SIZE);
  });

  /**
   * The regression 6a fixes: past `MAX_PAGES` the loop used to return successfully with a
   * short array, and nothing distinguished "that was everything" from "I gave up" — a
   * truncated result read exactly like a fully-loaded one. Hitting the cap must be loud.
   */
  it('warns once, naming the endpoint and the cap, when it hits the page cap', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchPage = vi.fn(async (page: number, limit: number) => ({
      data: Array.from({ length: limit }, (_, i) => (page - 1) * limit + i),
      total: Number.MAX_SAFE_INTEGER,
      page,
      limit,
    }));

    await fetchAllPages(fetchPage, 'GET /widgets');

    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0];
    expect(message).toContain('GET /widgets');
    expect(message).toContain('20');
    warn.mockRestore();
  });

  /** The happy path (a short page inside the cap) must never warn. */
  it('does not warn when every page loads within the cap', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const all = [1, 2, 3];
    const fetchPage = vi.fn(async (page: number, limit: number) => pageOf(all, page, limit));

    await fetchAllPages(fetchPage, 'GET /test');

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
