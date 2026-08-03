import { ToolsRepository } from '../tools.repository';
import { ToolVersionsRepository } from '../versions/versions.repository';
import { ToolAliasesRepository } from '../aliases/aliases.repository';
import { ToolVersionsService } from '../versions/versions.service';
import { canonicalJson } from './canonical-json';
import type { SyncToolDto, SyncToolResult } from './sync.types';
import type { Executor } from '../versions/versions.types';
import { audit } from '../../shared/audit';
import prisma from '../../shared/db/client';
import { runInTransaction } from '../../shared/db/unit-of-work';

/**
 * Reconciles a tool spec that was authored in code against the catalog.
 *
 * One call replaces the find → create → commit → promote sequence a code-side
 * registration used to need, and it is idempotent: re-running a deploy with an
 * unchanged spec commits nothing. Everything that mutates happens inside a single
 * transaction, so a failure mid-way cannot leave a tool holding a version that no
 * alias points at.
 */
export class ToolSyncService {
  private readonly tools = new ToolsRepository();
  private readonly versions = new ToolVersionsRepository();
  private readonly aliases = new ToolAliasesRepository();
  private readonly versionsService = new ToolVersionsService();

  /**
   * Creates the tool if the name is new, then commits a version and moves the alias
   * only if the submitted spec differs from the one the alias currently points at.
   *
   * The comparison covers `description`, `parametersSchema` and `executor`. Including
   * `description` is deliberate: it is what the model reads, and the helper this
   * endpoint replaces compared only the schema and the executor — which is exactly why
   * a wrong description once survived a re-run.
   *
   * **Who owns the description.** The code owns it only when the code supplies one:
   *
   * - Decorated function **with** a docstring → that text becomes the version's
   *   description and wins on every sync, superseding a dashboard edit (which stays in
   *   history and can be re-promoted).
   * - Decorated function **without** a docstring → no description is sent, and whatever
   *   the dashboard wrote is carried forward untouched. Such a sync commits nothing at
   *   all when the schema and executor are also unchanged.
   *
   * The unversioned tool-level description is only ever *filled* when empty, never
   * overwritten — it has no history, so an overwrite could not be undone.
   *
   * @param teamId - Owning team, the isolation boundary for the name lookup.
   * @param userId - Authenticated user, stored as the version's `createdBy`.
   * @param dto - The validated spec plus the target alias and claimed source.
   * @returns The tool id, the version the alias now points at, whether anything was
   *   committed, and `supersededSource` when a dashboard-authored version just stopped
   *   being live.
   * @throws {ValidationError} An `http` executor whose transforms fail to compile,
   *   whose `{{secret.NAME}}` refs do not exist, or whose `url` is private — the same
   *   deep validation `POST /tools/:id/versions` applies.
   */
  async sync(teamId: string, userId: string, dto: SyncToolDto): Promise<SyncToolResult> {
    // Deep executor validation runs BEFORE the transaction: it performs DNS and secret
    // lookups, and holding a write transaction open across a network round-trip is how
    // connection pools get exhausted.
    await this.versionsService.assertExecutorDeepValid(dto.executor, teamId);

    const outcome = await runInTransaction(async (tx) => {
      // Claim the name before reading it. Everything below is a find-then-write, and
      // sync is machine-driven — `runToolLoop` calls it before the first model call,
      // so N replicas rolling out the same change arrive here at the same instant.
      // Without this, two callers both saw "no such tool" and created one each, or
      // both computed the same next version number and one died on the unique index.
      await this.tools.lockName(teamId, dto.name, tx);

      let tool = await this.tools.findByName(dto.name, teamId, tx);
      const isNewTool = !tool;
      if (!tool) {
        tool = await this.tools.create({ name: dto.name, description: dto.description, teamId, createdBy: userId }, tx);
      }

      // The version the alias points at right now — the thing we compare against and,
      // if we commit, the thing we supersede.
      const currentAlias = await this.aliases.findByAlias(tool.id, dto.alias, tx);
      const currentVersion = currentAlias
        ? await this.versions.findByVersionNumber(tool.id, currentAlias.versionNumber, tx)
        : null;

      // The code owns `description` only when the code actually supplies one.
      //
      // A decorated function with a docstring wins on every sync — that is the point of
      // the function being the source of its own interface. A function WITHOUT a
      // docstring sends no description at all, and in that case the description written
      // in the dashboard is carried forward rather than overwritten with null. Writing
      // null would mean "no docstring" silently erased the only description the model
      // had, and would also churn a new version on every deploy for a tool whose text
      // the dashboard legitimately owns.
      const description = dto.description ?? currentVersion?.description ?? null;
      const submitted = this.specFingerprint(description, dto.parametersSchema, dto.executor);

      if (currentVersion) {
        const live = this.specFingerprint(
          currentVersion.description,
          currentVersion.parametersSchema,
          currentVersion.executor as unknown as Executor,
        );
        if (live === submitted) {
          return {
            result: {
              toolId: tool.id,
              versionNumber: currentVersion.versionNumber,
              committed: false as const,
              alias: dto.alias,
            },
            superseded: null,
            toolName: tool.name,
          };
        }
      }

      const versionNumber = await this.versions.computeNextVersionNumber(tool.id, tx);
      const row = await this.versions.create(
        {
          toolId: tool.id,
          versionNumber,
          // Not `dto.description`: see the note above — a docstring-less function must
          // carry the dashboard's description forward, not blank it out.
          description: description ?? undefined,
          changelog: dto.changelog,
          source: dto.source,
          parametersSchema: dto.parametersSchema,
          executor: dto.executor,
          createdBy: userId,
        },
        tx,
      );

      if (versionNumber === 1) {
        // First version: `production` and `staging` are created pointing at it.
        const created = await this.aliases.autoCreateAliases(tool.id, row.id, tx);
        // ...but those are the only two names it creates, and `alias` accepts any
        // name the promote endpoint does. Without this, a first sync aimed at, say,
        // `canary` returned `alias: 'canary', committed: true` while creating no such
        // alias, so the tool_ref the SDK then sent resolved to a 404.
        if (!created.some((a) => a.alias === dto.alias)) {
          await this.aliases.upsertAlias(tool.id, dto.alias, row.id, tx);
        }
      } else {
        await this.aliases.upsertAlias(tool.id, dto.alias, row.id, tx);
      }

      // Fill the shell description from the code ONLY when nobody has written one, and
      // never clear or overwrite an existing one.
      //
      // This asymmetry is deliberate. Tool VERSIONS are immutable, so a code sync that
      // supersedes one destroys nothing — the old version stays in the list and can be
      // re-promoted, which is what makes the ownership warnings proportionate. The shell
      // description is a mutable field with no history, so overwriting it would destroy a
      // human-written label unrecoverably and silently. A decorated function with no
      // docstring would even blank it out.
      //
      // Staleness is the acceptable trade: for a synced tool the version description
      // (from the docstring) is what the model actually reads, so the shell description
      // is only a catalog label the dashboard owns.
      if (!isNewTool && !tool.description && dto.description) {
        await this.tools.setDescription(tool.id, dto.description, tx);
      }

      const supersededSource = currentVersion?.source === 'dashboard' ? ('dashboard' as const) : undefined;

      return {
        result: {
          toolId: tool.id,
          versionNumber,
          committed: true as const,
          alias: dto.alias,
          ...(supersededSource ? { supersededSource } : {}),
        },
        superseded: currentVersion && supersededSource ? { versionNumber: currentVersion.versionNumber } : null,
        toolName: tool.name,
      };
    });

    // Audit is written AFTER the transaction commits, deliberately. `audit` is
    // fire-and-forget and never throws (see audit.helper.ts); writing it on `tx` would
    // roll the row back with the transaction, which is wrong for an append-only log of
    // things that DID happen.
    if (outcome.result.committed) {
      if (outcome.superseded) {
        void audit(prisma, {
          teamId,
          actorId: userId,
          event: 'tool_version_superseded',
          metadata: {
            toolId: outcome.result.toolId,
            toolName: outcome.toolName,
            supersededVersionNumber: outcome.superseded.versionNumber,
            newVersionNumber: outcome.result.versionNumber,
            supersededSource: 'dashboard',
            alias: dto.alias,
          },
        });
      }
      void audit(prisma, {
        teamId,
        actorId: userId,
        event: 'tool_version_committed',
        metadata: { toolId: outcome.result.toolId, versionNumber: outcome.result.versionNumber, source: dto.source, via: 'sync' },
      });
    }

    return outcome.result;
  }

  /**
   * The three fields that define a tool's behaviour, in a form where key order cannot
   * cause a false "changed" verdict.
   *
   * `changelog` and `source` are excluded on purpose: a new release note is not a
   * behaviour change, and comparing `source` would make every deploy commit over a
   * dashboard edit forever.
   */
  private specFingerprint(description: string | null, parametersSchema: unknown, executor: Executor): string {
    return canonicalJson({ description, parametersSchema, executor });
  }
}
