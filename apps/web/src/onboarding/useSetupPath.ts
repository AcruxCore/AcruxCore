import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/auth/AuthContext';
import type { SetupPath } from './checklist';

/** Fired on `window` when the path changes, so every mounted reader updates together. */
const CHANGE_EVENT = 'acx:setup-path';

function storageKey(teamId: string): string {
  return `acx.setupPath.${teamId}`;
}

/** The path saved on this device for a team, or `null`. Storage may be blocked; that reads as none. */
function readStored(teamId: string | undefined): SetupPath | null {
  if (!teamId) return null;
  try {
    const v = localStorage.getItem(storageKey(teamId));
    return v === 'gateway' || v === 'direct' ? v : null;
  } catch {
    return null;
  }
}

/**
 * The setup path this viewer chose for the active team, kept on this device.
 *
 * It is a per-viewer view setting, not team data: the steps themselves are ticked from
 * the team's real data either way. So it lives in `localStorage`, keyed by team, and the
 * page still works when storage is unavailable (the choice then lasts for the session).
 *
 * @returns `[stored, setPath]`. `stored` is `null` until the viewer picks a path.
 */
export function useSetupPath(): [SetupPath | null, (path: SetupPath) => void] {
  const { me } = useAuth();
  const teamId = me?.team.id;
  const [stored, setStored] = useState<SetupPath | null>(() => readStored(teamId));

  useEffect(() => {
    setStored(readStored(teamId));
    const onChange = () => setStored(readStored(teamId));
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, [teamId]);

  const setPath = useCallback(
    (path: SetupPath) => {
      setStored(path);
      if (!teamId) return;
      try {
        localStorage.setItem(storageKey(teamId), path);
      } catch {
        // Storage blocked (private mode): the choice holds for this session only.
      }
      window.dispatchEvent(new Event(CHANGE_EVENT));
    },
    [teamId],
  );

  return [stored, setPath];
}
