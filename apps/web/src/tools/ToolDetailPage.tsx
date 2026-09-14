import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ApiError,
  usePromoteToolAlias,
  useTool,
  useToolVersions,
  type ToolAliasTarget,
  type ToolVersionListItem,
} from '@/api';
import { useAuth } from '@/auth/AuthContext';
import { timeAgo } from '@/lib/format';
import { Badge, Button, Empty, Field, Input, PageSpinner, Select, Tabs, useToast } from '@/ui';
import type { TabItem } from '@/ui';
import { parseAliasVersionInput, toolStatus } from './catalog';
import { CommitVersionDialog } from './CommitVersionDialog';
import { ToolSettingsDialog } from './ToolSettingsDialog';
import { ToolAuditTab } from './audit/ToolAuditTab';

const TABS: TabItem[] = [
  { value: 'versions', label: 'Versions' },
  { value: 'audit', label: 'Audit' },
];

/** How a version's provenance reads to someone who did not write it. */
const SOURCE_LABEL: Record<string, string> = {
  code: 'from code',
  dashboard: 'from the dashboard',
  api: 'from the API',
};

/**
 * One version, with the aliases pointing at it and the control that moves them.
 *
 * Versions and aliases used to be two tabs, which meant the two halves of one question —
 * "what is live, and how do I change it" — were never on screen together. Reading the
 * aliases off the version they point at is the whole answer in one row.
 */
function VersionRow({
  version,
  aliases,
  allVersionNumbers,
  canWrite,
  promoting,
  onPromote,
}: {
  version: ToolVersionListItem;
  aliases: ToolAliasTarget[];
  allVersionNumbers: number[];
  canWrite: boolean;
  promoting: string | null;
  onPromote: (alias: string, versionNumber: number) => void;
}) {
  const here = aliases.filter((a) => a.versionNumber === version.versionNumber);
  // Aliases pointing somewhere else are what "promote to here" can move.
  const elsewhere = aliases.filter((a) => a.versionNumber !== version.versionNumber);
  const [moving, setMoving] = useState('');

  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-line-soft bg-surface px-4 py-3.5 last:border-b-0">
      <Badge tone="default" className="flex-none">
        v{version.versionNumber}
      </Badge>

      <div className="min-w-0 flex-1">
        {/* Two lines, not one: a model-facing description is a sentence or two, and the
            row is the only place it is readable without opening the version. */}
        <p className="line-clamp-2 text-[13.5px] text-ink">{version.description || '—'}</p>
        <p className="mt-0.5 truncate text-[12px] text-faint">
          {SOURCE_LABEL[version.source] ?? version.source} · created {timeAgo(version.createdAt)}
          {version.changelog ? ` · ${version.changelog}` : ''}
        </p>
      </div>

      <div className="flex flex-none flex-wrap items-center gap-1.5">
        {here.map((a) => (
          <Badge
            key={a.alias}
            tone={a.alias === 'production' ? 'prod' : a.alias === 'staging' ? 'staging' : 'default'}
            dot
          >
            {a.alias}
          </Badge>
        ))}

        {canWrite && elsewhere.length > 0 && allVersionNumbers.length > 1 && (
          <Select
            className="w-36"
            value={moving}
            disabled={promoting !== null}
            onChange={(e) => {
              const alias = e.target.value;
              setMoving('');
              if (alias) onPromote(alias, version.versionNumber);
            }}
          >
            <option value="">Point here…</option>
            {elsewhere.map((a) => (
              <option key={a.alias} value={a.alias}>
                {a.alias} (now v{a.versionNumber})
              </option>
            ))}
          </Select>
        )}
      </div>
    </li>
  );
}

/**
 * Tool detail: what the tool is, whether it can be called, its versions with the aliases
 * riding on them, and its audit trail.
 *
 * Each version shows where it came from (`code`, `dashboard`, or `api`). When the live
 * `production` version came from a decorated function, the header carries a "Defined in
 * code" badge and the New-version dialog warns that the next deploy will supersede
 * whatever is committed by hand.
 */
export function ToolDetailPage() {
  const { id = '' } = useParams();
  const { canWrite } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // `?tab=aliases` was a real tab until versions and aliases became one view. Old links
  // and bookmarks land on the merged list rather than on nothing.
  const tab = searchParams.get('tab') === 'audit' ? 'audit' : 'versions';
  const setTab = (value: string) => setSearchParams({ tab: value });

  const tool = useTool(id);
  const versions = useToolVersions(id);
  const promote = usePromoteToolAlias(id);

  const [commitOpen, setCommitOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [promotingAlias, setPromotingAlias] = useState<string | null>(null);
  const [newAliasName, setNewAliasName] = useState('');
  const [newAliasVersion, setNewAliasVersion] = useState('');

  const versionList = useMemo(() => versions.data ?? [], [versions.data]);
  // The readiness DTO already puts every alias on the tool resource `useTool` holds
  // (`{alias, versionNumber}`, `production` first) — a second `GET /tools/:id/aliases`
  // request for the same data used to fail independently and silently: its `isError`
  // was never rendered anywhere, so a failed fetch quietly emptied this to `[]` and the
  // whole page read as "this tool is released nowhere" (no badges, no "Defined in code",
  // no code-ownership warning) with nothing on screen saying why.
  const aliasList = useMemo(() => tool.data?.aliases ?? [], [tool.data]);
  const versionNumbers = useMemo(
    () => [...new Set(versionList.map((v) => v.versionNumber))].sort((a, b) => b - a),
    [versionList],
  );

  // Whatever `production` points at. Its `source` drives the "Defined in code" badge and
  // the New-version banner; its `description` decides which banner, because a code
  // definition with no docstring sends no description and so cannot supersede one written
  // here.
  const liveVersion = useMemo(() => {
    const production = aliasList.find((a) => a.alias === 'production');
    if (!production) return null;
    return versionList.find((v) => v.versionNumber === production.versionNumber) ?? null;
  }, [aliasList, versionList]);
  const liveVersionSource = liveVersion?.source ?? null;

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
    const n = parseAliasVersionInput(newAliasVersion);
    if (!name || n === null) return;
    await handlePromote(name, n);
    setNewAliasName('');
    setNewAliasVersion('');
  }

  if (tool.isLoading) return <PageSpinner />;
  if (tool.isError || !tool.data) {
    return (
      <div className="py-16 text-center">
        <p className="text-[15px] font-semibold text-ink">Tool not found</p>
        <Link to="/tools" className="mt-2 inline-block text-[13px] text-accent hover:underline">
          Back to tools
        </Link>
      </div>
    );
  }

  const t = tool.data;
  const status = toolStatus(t);

  return (
    <div className="flex flex-col gap-5">
      <div className="text-[12.5px] text-faint">
        <Link to="/tools" className="hover:text-ink">
          Tools
        </Link>
        <span className="px-1.5">/</span>
        <span className="font-mono text-muted">{t.name}</span>
      </div>

      <header className="flex flex-wrap items-start gap-4">
        <div className="min-w-0">
          <h1 className="font-mono text-[22px] font-semibold tracking-tight text-ink">{t.name}</h1>
          {t.description && <p className="mt-1 text-[13.5px] text-muted">{t.description}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge tone={status.tone === 'warn' ? 'warn' : 'muted'}>{status.label}</Badge>
            {liveVersionSource === 'code' && (
              <span data-testid="defined-in-code">
                <Badge tone="prod">Defined in code</Badge>
              </span>
            )}
          </div>
          {status.hint && <p className="mt-2 text-[12.5px] text-warn">{status.hint}</p>}
        </div>

        {canWrite && (
          <div className="ml-auto flex flex-none items-center gap-2">
            <Button size="sm" onClick={() => setSettingsOpen(true)}>
              Settings
            </Button>
            <Button variant="primary" size="sm" onClick={() => setCommitOpen(true)}>
              New version
            </Button>
          </div>
        )}
      </header>

      <Tabs items={TABS} value={tab} onChange={setTab} />

      {tab === 'versions' && (
        <div className="flex flex-col gap-4">
          {versions.isLoading ? (
            <PageSpinner />
          ) : versions.isError ? (
            <Empty title="Couldn't load versions" description="Please try again." />
          ) : versionList.length === 0 ? (
            <Empty
              title="No versions yet"
              description="Commit a version to define this tool's parameters and executor. Until then, nothing can call it."
              action={
                canWrite ? (
                  <Button variant="primary" onClick={() => setCommitOpen(true)}>
                    New version
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <>
              <p className="text-[12px] text-faint">
                Versions are immutable. An alias — <span className="font-mono">production</span>,{' '}
                <span className="font-mono">staging</span> — points at one of them, and moving it is
                how you release and roll back.
              </p>
              <ul className="overflow-hidden rounded-xl border border-line">
                {versionList.map((v) => (
                  <VersionRow
                    key={v.id}
                    version={v}
                    aliases={aliasList}
                    allVersionNumbers={versionNumbers}
                    canWrite={canWrite}
                    promoting={promotingAlias}
                    onPromote={handlePromote}
                  />
                ))}
              </ul>
            </>
          )}

          {canWrite && versionNumbers.length > 0 && (
            <div className="rounded-xl border border-line bg-surface p-4">
              <p className="text-[13px] font-medium text-ink">New alias</p>
              <p className="mt-0.5 text-[12px] text-faint">
                Another name a caller can point at, beside production and staging — a per-customer
                build, say. Promoting an unused name creates it.
              </p>
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <Field label="Alias name" htmlFor="new-alias-name" className="w-40">
                  <Input
                    id="new-alias-name"
                    value={newAliasName}
                    onChange={(e) => setNewAliasName(e.target.value)}
                    placeholder="canary"
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
                  Create
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
        liveVersionDescription={liveVersion?.description}
        open={commitOpen}
        onOpenChange={setCommitOpen}
      />

      <ToolSettingsDialog
        tool={t}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onDeleted={() => navigate('/tools')}
      />
    </div>
  );
}
