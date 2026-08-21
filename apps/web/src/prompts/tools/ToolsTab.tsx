import { useMemo, useState } from 'react';
import {
  useTools,
  useToolAliases,
  useToolVersions,
  usePromptToolBindings,
  useSetToolBinding,
  useRemoveToolBinding,
  useResetAliasBindings,
  ApiError,
  type BindingValue,
  type ToolBinding,
} from '@/api';
import { Badge, Button, Empty, PageSpinner, Select, useToast } from '@/ui';

/** Props for {@link ToolsTab}. */
export interface ToolsTabProps {
  promptId: string;
  /** Owner/admin/editor — gates every cell, matching the Editor tab's write gate. */
  canWrite: boolean;
}

/** `null` means the default column; a string means that alias's own column. */
type ColumnKey = string | null;

/** What one cell currently holds, before the user touches it. */
type CellState =
  | { kind: 'alias'; toolAlias: string; resolved: number | null }
  | { kind: 'pin'; version: number }
  | { kind: 'off' }
  | { kind: 'inherit' }
  | { kind: 'unbound' };

/** Reads a tool's row in one column, distinguishing "no row" from "row saying off". */
function cellState(bindings: ToolBinding[], toolId: string, isDefault: boolean): CellState {
  const b = bindings.find((x) => x.toolId === toolId);
  if (!b) return isDefault ? { kind: 'unbound' } : { kind: 'inherit' };
  if (b.off) return { kind: 'off' };
  if (b.pinnedVersionNumber !== null) return { kind: 'pin', version: b.pinnedVersionNumber };
  return { kind: 'alias', toolAlias: b.toolAlias ?? '', resolved: b.resolvedVersionNumber };
}

/**
 * One editable cell. Collapsed to its current value until clicked, then shows the
 * pickers — a grid of always-open dropdowns is unreadable past a couple of
 * columns, and most cells are never edited.
 */
function BindingCell({
  promptId,
  toolId,
  column,
  state,
  canWrite,
  onError,
}: {
  promptId: string;
  toolId: string;
  column: ColumnKey;
  state: CellState;
  canWrite: boolean;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const setBinding = useSetToolBinding(promptId);
  const removeBinding = useRemoveToolBinding(promptId);
  const aliases = useToolAliases(open ? toolId : '');
  const versions = useToolVersions(open ? toolId : '');

  const aliasNames = (aliases.data?.data ?? []).map((a) => a.alias);
  const versionNumbers = [...new Set((versions.data?.data ?? []).map((v) => v.versionNumber))].sort(
    (a, b) => b - a,
  );
  const isDefault = column === null;

  async function apply(value: BindingValue | 'clear') {
    try {
      if (value === 'clear') {
        await removeBinding.mutateAsync({ alias: column, toolId });
      } else {
        await setBinding.mutateAsync({ alias: column, toolId, value });
      }
      setOpen(false);
    } catch (e) {
      onError(e instanceof ApiError ? e.message : 'Could not save that change.');
    }
  }

  if (!open) {
    const label =
      state.kind === 'alias' ? (
        <>
          <span className="font-mono text-ink">{state.toolAlias}</span>
          {state.resolved !== null && <span className="ml-1.5 text-faint">v{state.resolved}</span>}
        </>
      ) : state.kind === 'pin' ? (
        <span className="font-mono text-muted">pinned v{state.version}</span>
      ) : state.kind === 'off' ? (
        <span className="font-mono text-faint line-through">none</span>
      ) : state.kind === 'inherit' ? (
        <span className="font-mono text-faint">inherits</span>
      ) : (
        <span className="font-mono text-faint">not connected</span>
      );

    const solid = state.kind === 'alias' || state.kind === 'pin';

    return (
      <button
        type="button"
        disabled={!canWrite}
        onClick={() => setOpen(true)}
        title={canWrite ? 'Change' : 'Read-only role'}
        className={[
          'rounded-md px-2 py-1 text-[12.5px] text-left transition-colors',
          solid ? 'border border-line bg-elevated' : 'border border-dashed border-line',
          canWrite ? 'hover:border-accent' : 'cursor-not-allowed opacity-70',
        ].join(' ')}
      >
        {label}
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Select
        className="w-28"
        defaultValue=""
        onChange={(e) => {
          const v = e.target.value;
          if (!v) return;
          if (v === '__off') void apply({ off: true });
          else if (v === '__clear') void apply('clear');
          else if (v.startsWith('v:')) void apply({ pinned_version_number: Number(v.slice(2)) });
          else void apply({ tool_alias: v });
        }}
      >
        <option value="">Choose…</option>
        {aliasNames.length > 0 && (
          <optgroup label="Follow tool alias">
            {aliasNames.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </optgroup>
        )}
        {versionNumbers.length > 0 && (
          <optgroup label="Pin to version">
            {versionNumbers.map((n) => (
              <option key={n} value={`v:${n}`}>
                v{n}
              </option>
            ))}
          </optgroup>
        )}
        <optgroup label="Other">
          {/* "off" only means something as a contradiction of a default, so the
              default column does not offer it — the API rejects it there too. */}
          {!isDefault && <option value="__off">none (exclude here)</option>}
          {state.kind !== 'inherit' && state.kind !== 'unbound' && (
            <option value="__clear">{isDefault ? 'disconnect' : 'inherit default'}</option>
          )}
        </optgroup>
      </Select>
      <button
        type="button"
        className="text-[12px] text-faint hover:text-ink"
        onClick={() => setOpen(false)}
      >
        Cancel
      </button>
    </div>
  );
}

/**
 * Tools panel for a prompt's detail page.
 *
 * One grid: tools down the side, this prompt's aliases across the top. A binding
 * says "when this prompt is served through this alias, call this tool at this
 * tool alias" — it takes effect immediately, with no commit, because tools are
 * keyed by the prompt's alias rather than by a prompt version.
 *
 * A column appears only for an alias that has bindings of its own. A column per
 * alias reads fine at two and becomes unusable at five, most of them repeating
 * the same inherited value; aliases still following the default are named as
 * pills above the grid instead, so all of them stay visible at no width cost.
 */
export function ToolsTab({ promptId, canWrite }: ToolsTabProps) {
  const toast = useToast();
  const tools = useTools();
  const bindings = usePromptToolBindings(promptId);
  const setBinding = useSetToolBinding(promptId);
  const resetAlias = useResetAliasBindings(promptId);
  const [addingTool, setAddingTool] = useState<{ id: string; name: string } | null>(null);
  const [picking, setPicking] = useState(false);
  /**
   * Alias columns the user asked to see that own no rows yet. A column normally
   * appears once its alias has a binding, but you cannot click a cell that is not
   * rendered — so "customise" materialises the column locally and the first cell
   * edit is what actually writes. Nothing is persisted just to make a column
   * visible.
   */
  const [extraColumns, setExtraColumns] = useState<string[]>([]);

  const data = bindings.data?.data;
  const catalog = tools.data?.data ?? [];

  /** Tools worth a row: anything bound anywhere. Unbound catalog tools live behind "Add". */
  const rows = useMemo(() => {
    if (!data) return [];
    const ids = new Set<string>(data.default.map((b) => b.toolId));
    for (const a of data.aliases) for (const b of a.bindings) ids.add(b.toolId);
    return [...ids]
      .map((id) => ({ id, name: catalog.find((t) => t.id === id)?.name ?? '(deleted tool)' }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [data, catalog]);

  const customised = (data?.aliases ?? []).filter((a) => a.customised);
  const following = (data?.aliases ?? []).filter(
    (a) => !a.customised && !extraColumns.includes(a.alias),
  );
  const unbound = catalog.filter((t) => !rows.some((r) => r.id === t.id));

  if (tools.isLoading || bindings.isLoading) return <PageSpinner />;

  function onError(message: string) {
    toast.error(message);
  }

  /**
   * Drops an alias's column. A column with no server rows is only local, so
   * removing it must not call the API — which would 404, since there is nothing
   * to reset.
   */
  async function handleReset(alias: string) {
    setExtraColumns((c) => c.filter((x) => x !== alias));
    if (!customised.some((a) => a.alias === alias)) return;
    try {
      await resetAlias.mutateAsync({ alias });
      toast.success(`"${alias}" is back to the default tools.`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not reset that alias.');
    }
  }

  /** Binds a tool in one column. `alias: null` writes the inherited default. */
  function connect(alias: string | null, tool: { id: string; name: string }) {
    setAddingTool(null);
    setPicking(false);
    void setBinding
      .mutateAsync({ alias, toolId: tool.id, value: { tool_alias: 'production' } })
      .then(() => {
        if (alias) setExtraColumns((c) => (c.includes(alias) ? c : [...c, alias]));
        toast.success(
          alias
            ? `${tool.name} connected for "${alias}", following its production alias.`
            : `${tool.name} connected, following its production alias.`,
        );
      })
      .catch((e) => toast.error(e instanceof ApiError ? e.message : 'Could not connect that tool.'));
  }

  const shownAliases = [
    ...customised,
    ...(data?.aliases ?? []).filter((a) => !a.customised && extraColumns.includes(a.alias)),
  ];
  const columns: { key: ColumnKey; label: string; sub: string }[] = [
    {
      key: null,
      label: 'default',
      sub: following.length > 0 ? `${following.length} alias${following.length === 1 ? '' : 'es'} inheriting` : 'every alias',
    },
    ...shownAliases.map((a) => ({ key: a.alias as ColumnKey, label: a.alias, sub: `serving v${a.versionNumber}` })),
  ];

  function bindingsFor(key: ColumnKey): ToolBinding[] {
    if (key === null) return data?.default ?? [];
    return data?.aliases.find((a) => a.alias === key)?.bindings ?? [];
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-1">
        <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-faint">Tools</h3>
        <p className="text-[12px] text-faint">
          Set the tools once. Give an alias its own column only where it needs something different.
          Changes save straight away — no commit.
        </p>
      </section>

      {!canWrite && (
        <p className="rounded-md border border-line bg-elevated px-3 py-2 text-[12.5px] text-muted">
          Your role is read-only. You can see which tools this prompt calls, but not change them.
        </p>
      )}

      {following.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[12px] text-faint">Following the default:</span>
            {following.map((a) => {
              const badge = (
                <Badge
                  tone={a.alias === 'production' ? 'prod' : a.alias === 'staging' ? 'staging' : 'default'}
                  dot
                >
                  {a.alias}
                </Badge>
              );
              // The pill is the control. A separate "customise" button made this two
              // clicks and one more thing to read for an action the pill already names.
              return canWrite ? (
                <button
                  key={a.alias}
                  type="button"
                  title={`Give "${a.alias}" its own tools`}
                  onClick={() => setExtraColumns((c) => (c.includes(a.alias) ? c : [...c, a.alias]))}
                  className="rounded-full opacity-90 transition hover:opacity-100 hover:ring-1 hover:ring-[var(--accent)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
                >
                  {badge}
                </button>
              ) : (
                <span key={a.alias}>{badge}</span>
              );
            })}
          </div>
          {canWrite && (
            <p className="text-[11.5px] text-faint">
              Click an alias to give it its own column.
            </p>
          )}
        </div>
      )}

      {rows.length === 0 ? (
        <Empty
          title="This prompt calls no tools"
          description={
            catalog.length === 0
              ? 'Create a tool in the Tool Catalog, then connect it here.'
              : 'Connect a tool below to let the model call it.'
          }
        />
      ) : (
        <div className="w-fit max-w-full overflow-x-auto rounded-xl border border-line">
          <table className="min-w-[520px] border-collapse bg-surface">
            <thead>
              <tr>
                <th className="whitespace-nowrap border-b border-line px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-faint">
                  Tool
                </th>
                {columns.map((c) => (
                  <th key={c.label} className="whitespace-nowrap border-b border-line px-4 py-3 text-left">
                    <div className="flex flex-col gap-0.5">
                      <span className="flex items-center gap-1.5 font-mono text-[12px] font-medium text-ink">
                        {c.label}
                        {c.key !== null && canWrite && (
                          <button
                            type="button"
                            title={`Reset "${c.label}" to the default`}
                            className="text-faint hover:text-ink"
                            onClick={() => handleReset(c.key as string)}
                          >
                            ×
                          </button>
                        )}
                      </span>
                      <span className="text-[10.5px] text-faint">{c.sub}</span>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="border-b border-line-soft px-4 py-3 align-middle last:border-b-0">
                    <span className="whitespace-nowrap font-mono text-[13px] text-ink">{r.name}</span>
                  </td>
                  {columns.map((c) => (
                    <td
                      key={c.label}
                      className="border-b border-line-soft px-4 py-3 align-middle last:border-b-0"
                    >
                      <BindingCell
                        promptId={promptId}
                        toolId={r.id}
                        column={c.key}
                        state={cellState(bindingsFor(c.key), r.id, c.key === null)}
                        canWrite={canWrite}
                        onError={onError}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canWrite && unbound.length > 0 && (
        <div className="flex flex-col gap-2">
          {!picking && !addingTool ? (
            <button
              type="button"
              className="self-start text-[13px] font-medium text-accent hover:underline"
              onClick={() => setPicking(true)}
            >
              + Connect a tool from the catalog
            </button>
          ) : !addingTool ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface p-3">
              <span className="text-[12.5px] text-muted">Which tool?</span>
              {unbound.map((t) => (
                <Button
                  key={t.id}
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    // With no alias customised there is only one place it could go,
                    // so skip the second step rather than asking a question with one
                    // possible answer.
                    if (columns.length === 1) connect(null, { id: t.id, name: t.name });
                    else {
                      setPicking(false);
                      setAddingTool({ id: t.id, name: t.name });
                    }
                  }}
                >
                  <span className="font-mono">{t.name}</span>
                </Button>
              ))}
              <button
                type="button"
                className="text-[12px] text-faint hover:text-ink"
                onClick={() => setPicking(false)}
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface p-3">
              <span className="text-[12.5px] text-muted">
                Connect <span className="font-mono text-ink">{addingTool.name}</span> where?
              </span>
              <Button size="sm" variant="ghost" onClick={() => connect(null, addingTool)}>
                default <span className="text-faint">(every alias)</span>
              </Button>
              {/* Binding to one alias only is how a tool gets rolled out: it exists
                  for that alias and nowhere else, with no default row to exclude. */}
              {(data?.aliases ?? []).map((a) => (
                <Button key={a.alias} size="sm" variant="ghost" onClick={() => connect(a.alias, addingTool)}>
                  {a.alias} <span className="text-faint">only</span>
                </Button>
              ))}
              <button
                type="button"
                className="text-[12px] text-faint hover:text-ink"
                onClick={() => setAddingTool(null)}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      <p className="text-[12px] text-faint">
        A cell holds a tool alias, an exact pinned version, or nothing. An alias with no column of
        its own follows the default, so a newly promoted alias works without any setup.
      </p>
    </div>
  );
}
