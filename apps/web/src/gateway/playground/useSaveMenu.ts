import { useEffect, useRef, useState } from 'react';
import { ApiError, useCommitVersion } from '@/api';
import { useToast } from '@/ui';
import type { DraftMessage } from './MessageListEditor';

interface UseSaveMenuParams {
  saveTargetPromptId: string | null;
  saveTargetPromptName: string | null;
  setSaveTargetPromptId: (id: string) => void;
  setSaveTargetPromptName: (name: string) => void;
  messagesToSave: DraftMessage[];
  model: string;
}

/**
 * Owns the "Save ▾" popover: open/close state (including outside-click and
 * Escape dismissal), the two save dialogs' open state, and the one-click
 * "save as new version of the current target" action.
 */
export function useSaveMenu({
  saveTargetPromptId,
  saveTargetPromptName,
  setSaveTargetPromptId,
  setSaveTargetPromptName,
  messagesToSave,
  model,
}: UseSaveMenuParams) {
  const toast = useToast();
  const commitVersion = useCommitVersion();
  const [saveMenuOpen, setSaveMenuOpen] = useState(false);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [saveVersionDialogOpen, setSaveVersionDialogOpen] = useState(false);
  const saveMenuRef = useRef<HTMLDivElement>(null);

  // Close the Save menu on outside click or Escape (matches TeamSwitcher's pattern).
  useEffect(() => {
    if (!saveMenuOpen) return;
    function handlePointerDown(e: MouseEvent) {
      if (saveMenuRef.current && !saveMenuRef.current.contains(e.target as Node)) {
        setSaveMenuOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setSaveMenuOpen(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [saveMenuOpen]);

  /** Commit the on-screen messages as a new version of the loaded prompt. */
  async function saveNewVersion() {
    if (!saveTargetPromptId) return;
    setSaveMenuOpen(false);
    try {
      const v = await commitVersion.mutateAsync({
        promptId: saveTargetPromptId,
        messages: messagesToSave,
        model: model.trim() || null,
      });
      const name = saveTargetPromptName ?? 'prompt';
      toast.success(`→ ${name} v${v.versionNumber}`, { href: `/prompts/${saveTargetPromptId}` });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not save version.');
    }
  }

  /** Retarget "New version" at a prompt just created/updated by a save dialog. */
  function retarget(promptId: string, name: string) {
    setSaveTargetPromptId(promptId);
    setSaveTargetPromptName(name);
  }

  return {
    commitVersion,
    saveMenuOpen,
    setSaveMenuOpen,
    saveDialogOpen,
    setSaveDialogOpen,
    saveVersionDialogOpen,
    setSaveVersionDialogOpen,
    saveMenuRef,
    saveNewVersion,
    retarget,
  };
}
