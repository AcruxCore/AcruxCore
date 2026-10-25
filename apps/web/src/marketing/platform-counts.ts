import { COMPARISON_LIST } from './comparisons';

/**
 * How many platforms the marketing site compares, derived from the data that
 * lists them, so no sentence can state a count of its own.
 *
 * Three sets are counted, and each sentence must name which one it means:
 * the competitors on `/compare`, the same competitors plus AcruxCore (the
 * platforms on `/compare` and `/best-open-source-llmops-platforms`), and the
 * platforms in the hands-on blog post, which adds LangSmith and PromptLayer.
 * `platform-counts.test.ts` reads every page and llms.txt and fails on a count
 * that matches none of them.
 */

/** Competitors with a column on `/compare`. */
export const COMPETITOR_COUNT = COMPARISON_LIST.length;

/** The competitors plus AcruxCore. */
export const PLATFORM_COUNT = COMPETITOR_COUNT + 1;

/**
 * The platforms the hands-on post tests that have no column on `/compare`.
 * Closed-source, which is why the open-source matrix leaves them out.
 */
export const HANDS_ON_EXTRA_PLATFORMS = ['LangSmith', 'PromptLayer'] as const;

/** Platforms in the hands-on blog post: every one on `/compare`, plus {@link HANDS_ON_EXTRA_PLATFORMS}. */
export const HANDS_ON_PLATFORM_COUNT = PLATFORM_COUNT + HANDS_ON_EXTRA_PLATFORMS.length;

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

/**
 * A count as an English word, for use inside a sentence.
 *
 * @param n - A whole number. Above twelve, the digits are returned instead.
 * @param options - `capitalize` for the start of a sentence or heading.
 * @returns "seven", "Ten", or "42".
 */
export function countWord(n: number, options: { capitalize?: boolean } = {}): string {
  const word = NUMBER_WORDS[n] ?? String(n);
  return options.capitalize ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}
