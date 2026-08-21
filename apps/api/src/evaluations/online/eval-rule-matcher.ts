import prisma from '../../shared/db/client';
import type { EvalRuleFilter } from './online-eval-rule.types';

/** Everything the matcher needs from one span + its trace, decoupled from Prisma's row shape. */
export interface SpanMatchContext {
  promptVersionId: string | null;
  model: string | null;
  tags: string[];
  sessionId: string | null;
}

/**
 * Evaluates one rule's `filter` against one span. All conditions are ANDed;
 * an empty filter matches every span (the caller is responsible for the
 * `kind === 'llm'` gate — this function doesn't see span kind at all).
 *
 * `promptId`/`promptAlias` require a DB lookup (a version doesn't carry its
 * parent prompt id, and an alias is a live pointer) — both are cheap, single
 * scoped queries, and this function is called from the worker (never the
 * request path), so that cost is acceptable per the spec's non-goals.
 *
 * @param filter - The rule's filter conditions, all ANDed together.
 * @param ctx - The span (and resolved trace fields) being evaluated against the filter.
 * @returns `true` when every condition present in `filter` matches `ctx`.
 */
export async function matchesFilter(filter: EvalRuleFilter, ctx: SpanMatchContext): Promise<boolean> {
  if (filter.model && filter.model !== ctx.model) return false;
  if (filter.tags && !filter.tags.every((t) => ctx.tags.includes(t))) return false;
  if (filter.sessionOnly && !ctx.sessionId) return false;

  if (filter.promptId || filter.promptAlias) {
    if (!ctx.promptVersionId) return false;
    // Hoisted: a rule filtering on both promptId and promptAlias would
    // otherwise re-fetch the same PromptVersion row twice.
    const version = await prisma.promptVersion.findUnique({
      where: { id: ctx.promptVersionId },
      select: { promptId: true },
    });
    if (!version) return false;

    if (filter.promptId && version.promptId !== filter.promptId) return false;

    if (filter.promptAlias) {
      const aliasRow = await prisma.promptAlias.findFirst({
        where: { promptId: version.promptId, alias: filter.promptAlias },
        select: { versionId: true },
      });
      if (!aliasRow || aliasRow.versionId !== ctx.promptVersionId) return false;
    }
  }

  return true;
}
