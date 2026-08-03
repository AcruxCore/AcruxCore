import { twMerge } from 'tailwind-merge';

/**
 * Join class-name fragments into a single string, resolving conflicting
 * Tailwind utilities (e.g. a later `w-40` overriding an earlier `w-full`) by
 * keeping the last one — matches the intuitive "last fragment wins" behavior
 * regardless of Tailwind's internal utility-generation order.
 *
 * @param parts - Class fragments; falsy values (`false`, `null`, `undefined`) are dropped.
 * @returns A space-joined, conflict-resolved class string.
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return twMerge(parts.filter(Boolean).join(' '));
}
