import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, usePromoteToolAlias, useTool, useToolAliases, useToolVersions } from '@/api';
import { useAuth } from '@/auth/AuthContext';
import { timeAgo } from '@/lib/format';
import { Badge, Button, Empty, Field, Input, PageSpinner, Select, Tabs, useToast } from '@/ui';
import type { TabItem } from '@/ui';
import { CommitVersionDialog } from './CommitVersionDialog';
import { ToolAuditTab } from './audit/ToolAuditTab';

const TABS: TabItem[] = [
  { value: 'versions', label: 'Versions' },
  { value: 'aliases', label: 'Aliases' },
  { value: 'audit', label: 'Audit' },
];

/**
 * Tool detail: name/description header, a "New version" action opening
 * {@link CommitVersionDialog}, and tabs for the tool's versions and its
 * resolved aliases (e.g. `production`/`staging`), each promotable to a
 * different version number. Mirrors `PromptDetailPage`'s tab + `useParams`
 * structure; mutations are gated behind `canWrite` (owner/admin/editor),
 * matching the server's commit/promote role gate.
 *
 * Each version shows where it came from (`code`, `dashboard`, or `api`). When the
 * live `production` version came from a decorated function, the header carries a
 * "Defined in code" badge and the New-version dialog warns that the next deploy will
 * supersede whatever is committed by hand.
 */
export function ToolDetailPage() {
  const { id = '' } = useParams();
  const { canWrite } = useAuth();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') ?? 'versions';
  const setTab = (value: string) => setSearchParams({ tab: value });

  const tool = useTool(id);
  const versions = useToolVersions(id);
  const aliases = useToolAliases(id);
  const promote = usePromoteToolAlias(id);

  const [commitOpen, setCommitOpen] = useState(false);
  const [promoteVersionByAlias, setPromoteVersionByAlias] = useState<Record<string, string>>({});
  const [promotingAlias, setPromotingAlias] = useState<string | null>(null);
  const [newAliasName, setNewAliasName] = useState('');
  const [newAliasVersion, setNewAliasVersion] = useState('');

  const versionNumbers = useMemo(() => {
    const nums = (versions.data?.data ?? []).map((v) => v.versionNumber);
    return [...new Set(nums)].sort((a, b) => b - a);
  }, [versions.data]);

  // The source of whatever `production` points at. Drives the "Defined in code"
  // badge and the New-version warning — a code-owned live version means the next
  // deploy supersedes anything edited here.
  const liveVersionSource = useMemo(() => {
    const production = (aliases.data?.data ?? []).find((a) => a.alias === 'production');
    if (!production) return null;
    const live = (versions.data?.data ?? []).find((v) => v.versionNumber === production.versionNumber);
    return live?.source ?? null;
  }, [aliases.data, versions.data]);

  async function handlePromote(alias: string, versionNumber: number) {
    try {
      setPromotingAlias(alias);
      await promote.mutateAsync({ alias, versionNumber });
      toast.success(`"${alias}" now points at v${versionNumber}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : `Could not promote "${alias}"`);
    } finally {
      setPromotingAlias(null);
    }
  }

  async function handleCreateAlias() {
    const name = newAliasName.trim();
    const n = Number(newAliasVersion);
    if (!name || !Number.isInteger(n)) return;
    await handlePromote(name, n);
    setNewAliasName('');
    setNewAliasVersion('');
  }

  if (tool.isLoading) return <PageSpinner />;
  if (tool.isError || !tool.data) {
    return (
      <div className="py-16 text-center">
        <p className="text-[15px] font-semibold text-ink">Tool not found</p>
        <Link to="/gateway/tools" className="mt-2 inline-block text-[13px] text-accent hover:underline">
          Back to tools
        </Link>
      </div>
    );
  }

  const t = tool.data;

  return (
    <div className="flex flex-col gap-5">
      <div className="text-[12.5px] text-faint">
        <Link to="/gateway/tools" className="hover:text-ink">
          Tools
        </Link>
        <span className="px-1.5">/</span>
        <span className="font-mono text-muted">{t.name}</span>
      </div>

      <header className="flex flex-wrap items-start gap-4">
        <div className="min-w-0">
          <h1 className="font-mono text-[22px] font-semibold tracking-tight text-ink">{t.name}</h1>
          {t.description && <p className="mt-1 text-[13.5px] text-muted">{t.description}</p>}
          {liveVersionSource === 'code' && (
            <span data-testid="defined-in-code" className="mt-2 inline-block">
              <Badge tone="prod">Defined in code</Badge>
            </span>
          )}
        </div>

        {canWrite && (
          <Button variant="primary" size="sm" className="ml-auto" onClick={() => setCommitOpen(true)}>
            New version
          </Button>
        )}
      </header>

      <Tabs items={TABS} value={tab} onChange={setTab} />

      {tab === 'versions' &&
        (versions.isLoading ? (
          <PageSpinner />
        ) : versions.isError ? (
          <Empty title="Couldn't load versions" description="Please try again." />
        ) : !versions.data || versions.data.data.length === 0 ? (
          <Empty
            title="No versions yet"
            description="Commit a version to define this tool's parameters and executor."
            action={
              canWrite ? (
                <Button variant="primary" onClick={() => setCommitOpen(true)}>
                  New version
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="overflow-hidden rounded-xl border border-line">
            {versions.data.data.map((v) => (
              <li
                key={v.id}
                className="flex items-center gap-4 border-b border-line-soft bg-surface px-4 py-3.5 last:border-b-0"
              >
                <Badge tone="default">v{v.versionNumber}</Badge>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] text-ink">{v.description || '—'}</p>
                  <p className="mt-0.5 truncate text-[12px] text-faint">
                    created {timeAgo(v.createdAt)}
                    {v.changelog ? ` · ${v.changelog}` : ''}
                  </p>
                </div>
                <Badge tone="muted" className="ml-auto flex-none">
                  {v.source}
                </Badge>
              </li>
            ))}
          </ul>
        ))}

      {tab === 'aliases' && (
        <div className="flex flex-col gap-4">
          {aliases.isLoading ? (
            <PageSpinner />
          ) : aliases.isError ? (
            <Empty title="Couldn't load aliases" description="Please try again." />
          ) : !aliases.data || aliases.data.data.length === 0 ? (
            <Empty
              title="No aliases yet"
              description="Promote a version below to create one (e.g. production, staging)."
            />
          ) : (
            <ul className="overflow-hidden rounded-xl border border-line">
              {aliases.data.data.map((a) => (
                <li
                  key={a.id}
                  className="flex flex-wrap items-center gap-3 border-b border-line-soft bg-surface px-4 py-3.5 last:border-b-0"
                >
                  <Badge
                    tone={a.alias === 'production' ? 'prod' : a.alias === 'staging' ? 'staging' : 'default'}
                    dot
                  >
                    {a.alias}
                  </Badge>
                  <p className="text-[13px] text-muted">
                    → v{a.versionNumber} · updated {timeAgo(a.updatedAt)}
                  </p>

                  {canWrite && versionNumbers.length > 0 && (
                    <div className="ml-auto flex items-center gap-2">
                      <Select
                        className="w-24"
                        value={promoteVersionByAlias[a.alias] ?? String(a.versionNumber)}
                        onChange={(e) =>
                          setPromoteVersionByAlias((prev) => ({ ...prev, [a.alias]: e.target.value }))
                        }
                      >
                        {versionNumbers.map((n) => (
                          <option key={n} value={n}>
                            v{n}
                          </option>
                        ))}
                      </Select>
                      <Button
                        size="sm"
                        disabled={promotingAlias === a.alias}
                        onClick={() =>
                          handlePromote(
                            a.alias,
                            Number(promoteVersionByAlias[a.alias] ?? a.versionNumber),
                          )
                        }
                      >
                        {promotingAlias === a.alias ? 'Promoting…' : 'Promote'}
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

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
                  disabled={
                    !newAliasName.trim() || !newAliasVersion || promotingAlias === newAliasName.trim()
                  }
                  onClick={handleCreateAlias}
                >
                  Promote
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'audit' && <ToolAuditTab toolId={id} />}

      <CommitVersionDialog
        toolId={id}
        prefillVersion={versionNumbers[0] ?? null}
        liveVersionSource={liveVersionSource}
        open={commitOpen}
        onOpenChange={setCommitOpen}
      />
    </div>
  );
}
