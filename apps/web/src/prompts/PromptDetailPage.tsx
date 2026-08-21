import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { Message } from '@/api';
import {
  ApiError,
  downloadJson,
  exportVersion,
  useAliases,
  useCommitVersion,
  useModels,
  usePrompt,
  useVersion,
  useVersions,
} from '@/api';
import { useAuth } from '@/auth/AuthContext';
import { Badge, Button, PageSpinner, Tabs, useToast } from '@/ui';
import type { TabItem } from '@/ui';
import { EditorTab } from './EditorTab';
import { PreviewTab } from './PreviewTab';
import { PromptSettingsDialog } from './PromptSettingsDialog';
import { VersionsTab } from './versions/VersionsTab';
import { DiffTab } from './diff/DiffTab';
import { AuditTab } from './audit/AuditTab';
import { ToolsTab } from './tools/ToolsTab';

const TABS: TabItem[] = [
  { value: 'editor', label: 'Editor' },
  { value: 'preview', label: 'Preview' },
  { value: 'versions', label: 'Versions' },
  { value: 'diff', label: 'Diff' },
  { value: 'audit', label: 'Audit' },
  { value: 'tools', label: 'Tools' },
];

const EMPTY_DRAFT: Message[] = [{ role: 'system', content: '' }];

/** Prompt detail: header with alias badges + tabbed editor/preview/versions/diff/audit. */
export function PromptDetailPage() {
  const { id = '' } = useParams();
  const { canWrite } = useAuth();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') ?? 'editor';
  const setTab = (value: string) => setSearchParams({ tab: value });

  const prompt = usePrompt(id);
  const versions = useVersions(id);
  const aliases = useAliases(id);
  const models = useModels();
  const commit = useCommitVersion();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Determine the version to seed the editor draft from: production, else latest.
  const versionNums = useMemo(
    () => (versions.data?.data ?? []).map((v) => v.versionNumber),
    [versions.data],
  );
  const maxNum = versionNums.length ? Math.max(...versionNums) : null;
  const seedNum = aliases.data?.find((a) => a.alias === 'production')?.versionNumber ?? maxNum;

  const [draft, setDraft] = useState<Message[] | null>(null);
  const [baseline, setBaseline] = useState<string>('');
  // Default-model binding (#12): draft state, seeded from the version we open,
  // applied on the next commit — same lifecycle as the tool attachment above,
  // since binding lives on the immutable version, not the prompt.
  const [model, setModel] = useState<string | null>(null);
  const [modelBaseline, setModelBaseline] = useState<string | null>(null);
  const seedVersion = useVersion(id, draft === null ? seedNum : null);

  useEffect(() => {
    if (draft !== null) return;
    if (seedNum === null && versions.isSuccess) {
      setDraft(EMPTY_DRAFT);
      setBaseline(JSON.stringify(EMPTY_DRAFT));
      setModel(null);
      setModelBaseline(null);
    } else if (seedVersion.data) {
      setDraft(seedVersion.data.messages);
      setBaseline(JSON.stringify(seedVersion.data.messages));
      setModel(seedVersion.data.model);
      setModelBaseline(seedVersion.data.model);
    }
  }, [draft, seedNum, versions.isSuccess, seedVersion.data]);

  const dirty =
    draft !== null && (JSON.stringify(draft) !== baseline || model !== modelBaseline);

  async function commitDraft() {
    if (!draft) return;
    const messages = draft.filter((m) => m.content.trim() !== '');
    if (messages.length === 0) {
      toast.error('Add some content before committing.');
      return;
    }
    try {
      const v = await commit.mutateAsync({ promptId: id, messages, model });
      setDraft(v.messages);
      setBaseline(JSON.stringify(v.messages));
      setModel(v.model);
      setModelBaseline(v.model);
      toast.success(`Committed v${v.versionNumber}`);
      setTab('versions');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not commit version.');
    }
  }

  async function handleExport() {
    if (seedNum === null) return;
    try {
      const data = await exportVersion(id, seedNum);
      downloadJson(`${prompt.data?.name ?? 'prompt'}-v${seedNum}.json`, data);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not export version.');
    }
  }

  if (prompt.isLoading || draft === null) return <PageSpinner />;
  if (prompt.isError || !prompt.data) {
    return (
      <div className="py-16 text-center">
        <p className="text-[15px] font-semibold text-ink">Prompt not found</p>
        <Link to="/prompts" className="mt-2 inline-block text-[13px] text-accent hover:underline">
          Back to prompts
        </Link>
      </div>
    );
  }

  const p = prompt.data;

  return (
    <div className="flex flex-col gap-5">
      <div className="text-[12.5px] text-faint">
        <Link to="/prompts" className="hover:text-ink">
          Prompts
        </Link>
        <span className="px-1.5">/</span>
        <span className="font-mono text-muted">{p.name}</span>
      </div>

      <header className="flex flex-wrap items-start gap-4">
        <div className="min-w-0">
          <h1 className="font-mono text-[22px] font-semibold tracking-tight text-ink">{p.name}</h1>
          {p.description && <p className="mt-1 text-[13.5px] text-muted">{p.description}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            {aliases.data?.map((a) => (
              <Badge
                key={a.id}
                tone={a.alias === 'production' ? 'prod' : a.alias === 'staging' ? 'staging' : 'default'}
                dot
              >
                <span className="uppercase tracking-[0.05em]">{a.alias}</span>
                {a.versionNumber ? ` → v${a.versionNumber}` : ' — none'}
              </Badge>
            ))}
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" onClick={handleExport} disabled={seedNum === null}>
            Export
          </Button>
          {canWrite && (
            <Button size="sm" variant="ghost" onClick={() => setSettingsOpen(true)}>
              Settings
            </Button>
          )}
          {canWrite && (
            <Button
              size="sm"
              variant="primary"
              onClick={commitDraft}
              disabled={commit.isPending || !dirty}
            >
              {commit.isPending ? 'Committing…' : 'Commit new version'}
            </Button>
          )}
        </div>
      </header>

      <Tabs items={TABS} value={tab} onChange={setTab} />

      <div>
        {tab === 'editor' && (
          <EditorTab
            draft={draft}
            onChange={setDraft}
            canWrite={canWrite}
            onCommit={commitDraft}
            committing={commit.isPending}
            dirty={dirty}
            models={models.data ?? []}
            model={model}
            onModelChange={setModel}
          />
        )}
        {tab === 'preview' && <PreviewTab draft={draft} />}
        {tab === 'versions' && <VersionsTab promptId={id} canWrite={canWrite} />}
        {tab === 'diff' && <DiffTab promptId={id} />}
        {tab === 'audit' && <AuditTab promptId={id} />}
        {tab === 'tools' && (
          <ToolsTab promptId={id} canWrite={canWrite} />
        )}
      </div>

      {canWrite && (
        <PromptSettingsDialog prompt={p} open={settingsOpen} onOpenChange={setSettingsOpen} />
      )}
    </div>
  );
}
