import { useEffect, useState } from 'react';
import type { ToolVersionSource } from '@/api';
import { ApiError, useCommitToolVersion, useToolVersion } from '@/api';
import { Button, Dialog, DialogFooter, useToast } from '@/ui';
import { codeOwnedBanner } from './code-ownership';
import { ToolVersionFields } from './ToolVersionFields';
import type { VersionFormField, VersionFormState } from './version-form';
import { canCommitVersionForm, emptyVersionForm, versionFormFromVersion, versionFormToCommit } from './version-form';

export interface CommitVersionDialogProps {
  /** The tool this version is committed to. */
  toolId: string;
  /**
   * Version number to prefill the form from (the tool's latest), so "New version" starts
   * from the current config instead of blank. Null/undefined (e.g. the first-ever
   * version) opens the form empty.
   */
  prefillVersion?: number | null;
  /**
   * `source` of the version the tool's `production` alias currently points at, used to
   * warn before editing a tool that a deploy owns. Null/undefined shows no warning.
   */
  liveVersionSource?: ToolVersionSource | null;
  /**
   * That live version's description. Only read when `liveVersionSource` is `code`, where
   * blank or absent means the decorated function has no docstring and so sends no
   * description — see {@link codeOwnedBanner}.
   */
  liveVersionDescription?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Commits a new immutable version onto an existing tool.
 *
 * The fields themselves live in {@link ToolVersionFields}, shared with the create-tool
 * dialog; this owns the prefill, the code-ownership warning, and the POST.
 *
 * When {@link liveVersionSource} is `code`, a banner says what the next deploy does to
 * the version committed here — and which of the two things it does depends on whether
 * the code sends a description at all. A code definition that carries one overwrites
 * this one on the next sync; one with no docstring sends no description, so the sync
 * carries this text forward and the edit is permanent. Showing the warning in both cases
 * talks people out of a supported workflow.
 *
 * @param toolId - The tool this version is committed to.
 * @param prefillVersion - Version number to prefill from, or null for a blank form.
 * @param liveVersionSource - Source of the version `production` points at, or null.
 * @param liveVersionDescription - That version's description, blank when the code sends none.
 * @param open - Whether the dialog is visible.
 * @param onOpenChange - Called to open/close the dialog.
 */
export function CommitVersionDialog({
  toolId,
  prefillVersion,
  liveVersionSource,
  liveVersionDescription,
  open,
  onOpenChange,
}: CommitVersionDialogProps) {
  const toast = useToast();
  const banner = codeOwnedBanner(liveVersionSource, liveVersionDescription);
  const commit = useCommitToolVersion(toolId);
  // Fetch the version to prefill from — only while the dialog is open.
  const prefill = useToolVersion(toolId, open ? (prefillVersion ?? null) : null);

  const [form, setForm] = useState<VersionFormState>(emptyVersionForm);
  const [error, setError] = useState<{ field: VersionFormField; message: string } | null>(null);
  // Guards one-time prefill hydration per open, so a background refetch can't clobber
  // edits the user has since made.
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!open) {
      setHydrated(false);
      return;
    }
    setForm(emptyVersionForm());
    setError(null);
  }, [open]);

  useEffect(() => {
    if (!open || hydrated) return;
    if (prefillVersion == null) {
      setHydrated(true);
      return;
    }
    if (!prefill.data) return;
    setForm(versionFormFromVersion(prefill.data));
    setHydrated(true);
  }, [open, hydrated, prefillVersion, prefill.data]);

  function patch(next: Partial<VersionFormState>) {
    setForm((f) => ({ ...f, ...next }));
    setError(null);
  }

  async function handleSubmit() {
    const result = versionFormToCommit(form);
    if (!result.ok) {
      setError({ field: result.field, message: result.message });
      return;
    }
    try {
      await commit.mutateAsync(result.body);
      toast.success('Version committed');
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not commit version');
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New version"
      description="Versions are immutable — commit a new one to change parameters or the executor."
      className="max-w-2xl"
    >
      <div className="flex max-h-[65vh] flex-col gap-3 overflow-y-auto pr-1">
        {banner === 'deploy-supersedes' && (
          <div
            className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2.5 text-[13px] text-ink"
            data-testid="code-owned-warning"
          >
            This tool is defined in code with <code className="font-mono">@acrux.tool</code>,
            description included. The next deploy will commit a version from the code definition
            and move <code className="font-mono">production</code> to it. Your change stays in the
            version history and can be promoted back, but it stops being live.
          </div>
        )}

        {banner === 'description-is-yours' && (
          <div
            className="rounded-lg border border-line bg-elevated px-3 py-2.5 text-[13px] text-muted"
            data-testid="code-owned-no-description-note"
          >
            This tool is defined in code with <code className="font-mono">@acrux.tool</code>, but
            the code sends no description — so the wording below is yours to own. A deploy carries
            it forward, and only commits a new version if the parameters or the executor change.
          </div>
        )}

        <ToolVersionFields form={form} onChange={patch} error={error} />
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={commit.isPending || !canCommitVersionForm(form)}
          onClick={handleSubmit}
        >
          {commit.isPending ? 'Committing…' : 'Commit version'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
