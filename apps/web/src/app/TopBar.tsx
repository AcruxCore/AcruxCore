import { useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { useAuth } from '@/auth/AuthContext';
import { getTheme, toggleTheme, type Theme } from '@/lib/theme';
import { Button } from '@/ui';
import { TeamSwitcher } from './TeamSwitcher';

/** Top bar: team switcher, theme toggle, current user, sign out. */
export function TopBar() {
  const { me, signOut } = useAuth();
  const navigate = useNavigate();
  const [theme, setThemeState] = useState<Theme>(getTheme());

  return (
    <header className="flex h-[52px] flex-none items-center gap-4 border-b border-line bg-bg/80 px-5 backdrop-blur">
      <TeamSwitcher />

      <div className="ml-auto flex items-center gap-2">
        <a
          href="https://docs.acruxcore.com"
          target="_blank"
          rel="noreferrer"
          className="rounded-md border border-line px-2.5 py-1.5 text-[12px] text-muted transition-colors hover:border-faint hover:text-ink"
        >
          Docs
        </a>
        <button
          type="button"
          aria-label="Toggle theme"
          onClick={() => setThemeState(toggleTheme())}
          className="rounded-md border border-line px-2.5 py-1.5 font-mono text-[12px] text-muted transition-colors hover:border-faint hover:text-ink"
        >
          {theme === 'dark' ? '◐ dark' : '◑ light'}
        </button>
        <span className="hidden text-[13px] text-muted sm:inline">{me?.user.email}</span>
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            await signOut();
            navigate('/login', { replace: true });
          }}
        >
          Sign out
        </Button>
      </div>
    </header>
  );
}
