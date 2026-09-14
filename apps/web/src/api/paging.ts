import type { Paginated } from './types';

/**
 * Page size used when reading a whole collection. The API caps `limit` at 100, so this
 * is the largest page it will serve and therefore the fewest round-trips.
 */
export const PAGE_SIZE = 100;

/**
 * Safety valve on the loop. Twenty pages is 2,000 rows — far past any list a dashboard
 * screen should render in one go, and short enough that a server returning nonsense
 * cannot turn a page load into an unbounded request loop.
 */
const MAX_PAGES = 20;

/**
 * Reads every page of a paginated endpoint and returns the rows as one array.
 *
 * Exists because "fetch the list" and "fetch the first page of the list" look identical
 * at the call site, and the difference only shows up on an account big enough to have a
 * second page. When it does show up, it does not look like a paging bug: rows referenced
 * by id elsewhere in the app simply fail to resolve, which reads as deleted data.
 *
 * Stops on the first short page rather than trusting `total`, so a count that is stale
 * by one row cannot cost a wasted request or, worse, spin.
 *
 * Hitting `MAX_PAGES` without ever seeing a short page is not a supported outcome — it
 * means some rows were silently dropped, reproducing the exact failure this function
 * exists to prevent. That case logs a `console.warn` naming the endpoint and the cap, so
 * it surfaces as a bug to raise rather than passing for "that was everything".
 *
 * @param fetchPage - Fetches one page; receives a 1-indexed page number and the limit.
 * @param endpointLabel - Identifies the caller in the cap-hit warning (e.g. `GET /tools`),
 *   so the warning names which endpoint needs raising as a bug.
 * @returns Every row, in page order. Truncated at `MAX_PAGES` pages if the cap is hit —
 *   see the warning above.
 */
export async function fetchAllPages<T>(
  fetchPage: (page: number, limit: number) => Promise<Paginated<T>>,
  endpointLabel: string,
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const result = await fetchPage(page, PAGE_SIZE);
    rows.push(...result.data);
    if (result.data.length < PAGE_SIZE) return rows;
  }
  console.warn(
    `fetchAllPages: ${endpointLabel} hit the ${MAX_PAGES}-page cap (${MAX_PAGES * PAGE_SIZE} rows) ` +
      'without reaching a short page. Rows past the cap are silently missing from the result — ' +
      'this is a bug to raise, not a supported mode.',
  );
  return rows;
}
