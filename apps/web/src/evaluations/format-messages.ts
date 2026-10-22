import type { Message } from '@/api/types';
import { describeContent } from '@/lib/message-content';

/**
 * Renders a messages array as readable `[role]` + content text, one message per
 * block, so a prompt template can be shown in a monospace panel or diffed line by line.
 * A message marked for prompt caching reads `[role · cached]`, the same marker the
 * prompt's Diff tab uses, so two versions that differ only in that marker do not
 * read as identical.
 *
 * @param messages - The template's messages, in order.
 * @returns The messages as text, separated by a blank line.
 */
export function formatMessages(messages: Message[]): string {
  return messages.map((m) => `[${m.role}${m.cache_control ? ' · cached' : ''}]\n${describeContent(m.content)}`).join('\n\n');
}
