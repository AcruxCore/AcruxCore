import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchMyTeams, keys } from '@/api';
import { useAuth } from '@/auth/AuthContext';

/**
 * Team-switcher dropdown for the top bar.
 *
 * Renders a plain non-interactive label when the user belongs to a single
 * team (or the membership list hasn't loaded yet). With more than one team,
 * renders a button that opens a menu of every team the user belongs to;
 * picking a different team switches the session, resets the query cache, and
 * navigates to the team-neutral `/prompts` route.
 */
export function TeamSwitcher() {
  const { me, switchTeam } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const teamsQuery = useQuery({
    queryKey: keys.myTeams,
    queryFn: fetchMyTeams,
    enabled: !!me,
  });

  const teams = teamsQuery.data?.teams ?? [];
  const currentTeamName = me?.team.name ?? 'Workspace';
  const canSwitch = teams.length > 1;

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  if (!canSwitch) {
    return (
      <div className="text-[13px] text-muted" data-testid="team-switcher">
        <span className="font-medium text-ink">{currentTeamName}</span>
      </div>
    );
  }

  async function handleSelect(teamId: string) {
    if (teamId === me?.team.id) {
      setOpen(false);
      return;
    }
    setSwitching(true);
    try {
      await switchTeam(teamId);
      setOpen(false);
      navigate('/prompts', { replace: true });
    } finally {
      setSwitching(false);
    }
  }

  return (
    <div ref={containerRef} className="relative text-[13px]">
      <button
        type="button"
        data-testid="team-switcher"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={switching}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-md border border-transparent px-1.5 py-1 font-medium text-ink transition-colors hover:border-faint disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span>{currentTeamName}</span>
        <svg
          aria-hidden="true"
          className={`text-faint transition-transform ${open ? 'rotate-180' : ''}`}
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-20 mt-1 min-w-[180px] rounded-md border border-line bg-surface py-1 shadow-lg"
        >
          {teams.map((team) => {
            const isCurrent = team.id === me?.team.id;
            return (
              <button
                key={team.id}
                type="button"
                role="menuitem"
                data-testid="team-switcher-option"
                onClick={() => handleSelect(team.id)}
                className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-ink transition-colors hover:bg-elevated"
              >
                <span className="truncate">{team.name}</span>
                {isCurrent && <span className="text-accent">✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
