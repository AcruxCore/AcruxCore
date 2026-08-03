import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AliasDetail } from '@/api';
import { ApiError, useAliases, useDeleteAlias, usePromoteAlias, useVersions } from '@/api';
import { timeAgo } from '@/lib/format';
import {
  Badge,
  Button,
  Dialog,
  DialogFooter,
  Empty,
  Field,
  Input,
  PageSpinner,
  Select,
  useToast,
} from '@/ui';

interface PendingPromote {
  alias: string;
  versionNumber: number;
}

/**
 * Version history with alias badges and promote/rollback controls.
 *
 * Promoting `production` requires confirmation (it changes what the SDK serves);
 * `staging` promotes immediately. Custom aliases can be created and deleted.
 */
export function VersionsTab({ promptId, canWrite }: { promptId: string; canWrite: boolean }) {
  const toast = useToast();
  const versions = useVersions(promptId);
  const aliases = useAliases(promptId);
  const promote = usePromoteAlias(promptId);
  const deleteAlias = useDeleteAlias(promptId);
  const [pending, setPending] = useState<PendingPromote | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [newAliasName, setNewAliasName] = useState('');
  const [newAliasVersion, setNewAliasVersion] = useState('');

  const aliasFor = (versionNumber: number): AliasDetail[] =>
    (aliases.data ?? []).filter((a) => a.versionNumber === versionNumber);

  const versionNumbers = useMemo(() => {
    const nums = (versions.data?.data ?? []).map((v) => v.versionNumber);
    return [...new Set(nums)].sort((a, b) => b - a);
  }, [versions.data]);

  async function doPromote(alias: string, versionNumber: number) {
    try {
      await promote.mutateAsync({ alias, versionNumber });
      toast.success(`Pointed ${alias} → v${versionNumber}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : `Could not promote ${alias}`);
    } finally {
      setPending(null);
    }
  }

  async function doDelete() {
    if (!pendingDelete) return;
    try {
      await deleteAlias.mutateAsync(pendingDelete);
      toast.success(`Deleted alias "${pendingDelete}"`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : `Could not delete "${pendingDelete}"`);
    } finally {
      setPendingDelete(null);
    }
  }

  async function handleCreateAlias() {
    const name = newAliasName.trim();
    const n = Number(newAliasVersion);
    if (!name || !Number.isInteger(n)) return;
    try {
      await promote.mutateAsync({ alias: name, versionNumber: n });
      toast.success(`Created alias "${name}" → v${n}`);
      setNewAliasName('');
      setNewAliasVersion('');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : `Could not create alias "${name}"`);
    }
  }

  if (versions.isLoading) return <PageSpinner />;
  const items = versions.data?.data ?? [];
  if (items.length === 0) {
    return (
      <Empty
        title="No versions yet"
        description="Commit a version in the Editor tab to start the history."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-hidden rounded-xl border border-line">
        {items.map((v) => {
          const here = aliasFor(v.versionNumber);
          const isProd = here.some((a) => a.alias === 'production');
          const isStaging = here.some((a) => a.alias === 'staging');
          const otherAliases = here.filter(
            (a) => a.alias !== 'production' && a.alias !== 'staging',
          );
          // Aliases NOT pointing at this version (for promote buttons)
          const otherAliasesForPromote = (aliases.data ?? []).filter(
            (a) => a.versionNumber !== v.versionNumber,
          );

          return (
            <div
              key={v.id}
              className="flex flex-wrap items-center gap-3 border-b border-line-soft bg-surface px-4 py-3 last:border-b-0"
            >
              <span className="font-mono text-[14px] font-semibold text-ink">v{v.versionNumber}</span>
              <span className="text-[12px] text-faint">{timeAgo(v.createdAt)}</span>
              {v.variables.length > 0 && (
                <span className="font-mono text-[11.5px] text-faint">
                  {v.variables.length} var{v.variables.length === 1 ? '' : 's'}
                </span>
              )}
              {v.model && (
                <span
                  className="font-mono text-[11.5px] text-faint"
                  title={`Default model: ${v.model}`}
                >
                  {v.model}
                </span>
              )}

              <div className="ml-auto flex items-center gap-2">
                {isProd && (
                  <Badge tone="prod" dot>
                    <span className="uppercase tracking-[0.05em]">production</span>
                  </Badge>
                )}
                {isStaging && (
                  <Badge tone="staging" dot>
                    <span className="uppercase tracking-[0.05em]">staging</span>
                  </Badge>
                )}
                {otherAliases.map((a) => (
                  <Badge key={a.id} tone="default" dot>
                    <span className="uppercase tracking-[0.05em]">{a.alias}</span>
                    {canWrite && a.alias !== 'production' && a.alias !== 'staging' && (
                      <button
                        className="ml-1 text-faint hover:text-ink"
                        title={`Delete "${a.alias}"`}
                        onClick={() => setPendingDelete(a.alias)}
                      >
                        ×
                      </button>
                    )}
                  </Badge>
                ))}

                <Link
                  to={`/traces?prompt_version_id=${v.id}`}
                  className="rounded-md px-2 py-1 text-[12px] text-muted hover:bg-elevated hover:text-ink"
                  data-testid="version-view-traces"
                >
                  View traces
                </Link>

                {canWrite && otherAliasesForPromote.map((a) => {
                  const isDefault = a.alias === 'production' || a.alias === 'staging';
                  return (
                    <Button
                      key={a.id}
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        if (isDefault) {
                          setPending({ alias: a.alias, versionNumber: v.versionNumber });
                        } else {
                          doPromote(a.alias, v.versionNumber);
                        }
                      }}
                    >
                      → {a.alias}
                    </Button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {canWrite && versionNumbers.length > 0 && (
        <div className="rounded-xl border border-line bg-surface p-4">
          <p className="text-[13px] font-medium text-ink">New alias</p>
          <p className="mt-0.5 text-[12px] text-faint">
            Point a new alias name at a version — promoting an unused name creates it.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <Field label="Alias name" htmlFor="new-alias-name" className="w-40">
              <Input
                id="new-alias-name"
                value={newAliasName}
                onChange={(e) => setNewAliasName(e.target.value)}
                placeholder="staging"
              />
            </Field>
            <Field label="Version" htmlFor="new-alias-version" className="w-24">
              <Select
                id="new-alias-version"
                value={newAliasVersion}
                onChange={(e) => setNewAliasVersion(e.target.value)}
              >
                <option value="">—</option>
                {versionNumbers.map((n) => (
                  <option key={n} value={n}>
                    v{n}
                  </option>
                ))}
              </Select>
            </Field>
            <Button
              size="sm"
              disabled={!newAliasName.trim() || !newAliasVersion || promote.isPending}
              onClick={handleCreateAlias}
            >
              {promote.isPending ? 'Creating…' : 'Promote'}
            </Button>
          </div>
        </div>
      )}

      {/* Promote confirmation dialog (for production/staging) */}
      <Dialog
        open={!!pending}
        onOpenChange={(o) => !o && setPending(null)}
        title={`Update ${pending?.alias ?? ''}?`}
        description={
          pending
            ? `Point the ${pending.alias} alias at v${pending.versionNumber}. This changes what the SDK serves immediately.`
            : ''
        }
      >
        <DialogFooter>
          <Button variant="ghost" onClick={() => setPending(null)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={promote.isPending}
            onClick={() => pending && doPromote(pending.alias, pending.versionNumber)}
          >
            {promote.isPending ? 'Promoting…' : `Promote to ${pending?.alias ?? ''}`}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog
        open={!!pendingDelete}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title={`Delete alias "${pendingDelete ?? ''}"?`}
        description="This alias will be removed. This action cannot be undone."
      >
        <DialogFooter>
          <Button variant="ghost" onClick={() => setPendingDelete(null)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={deleteAlias.isPending}
            onClick={doDelete}
          >
            {deleteAlias.isPending ? 'Deleting…' : 'Delete alias'}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
