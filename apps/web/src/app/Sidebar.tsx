import { Link, NavLink } from 'react-router-dom';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { BrandMark } from '@/marketing/brand';

function Item({ to, icon, children }: { to: string; icon: ReactNode; children: ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] font-medium transition-colors',
          isActive
            ? 'bg-elevated text-ink'
            : 'text-muted hover:bg-elevated hover:text-ink',
        )
      }
    >
      <span className="flex-none opacity-80">{icon}</span>
      {children}
    </NavLink>
  );
}

const ic = (path: ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {path}
  </svg>
);

/** Left navigation rail: brand + primary sections. */
export function Sidebar() {
  return (
    <aside className="flex w-[232px] flex-none flex-col border-r border-line bg-surface p-3">
      <Link
        to="/"
        state={{ fromLogo: true }}
        aria-label="acruxcore home"
        className="flex flex-none items-center gap-2.5 rounded-md px-2 pb-4 pt-1.5 transition-opacity hover:opacity-80"
      >
        <span className="text-accent"><BrandMark size={20} /></span>
        <span className="text-[15px] font-semibold tracking-tight">acruxcore</span>
        <span className="ml-0.5 rounded-full border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-accent">
          Beta
        </span>
      </Link>

      <nav className="scroll-slim flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-1">
      <div className="px-2 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-faint">
        Workspace
      </div>
      <Item to="/prompts" icon={ic(<><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h10" /></>)}>
        Prompts
      </Item>
      <Item to="/team" icon={ic(<><circle cx="9" cy="8" r="3" /><path d="M2 20a7 7 0 0 1 14 0" /><path d="M17 5a3 3 0 0 1 0 6" /><path d="M22 20a6 6 0 0 0-4-5.6" /></>)}>
        Team
      </Item>
      <Item to="/account" icon={ic(<><circle cx="12" cy="12" r="9" /><path d="m21 7-8 8-4-4" /></>)}>
        Account &amp; keys
      </Item>

      <div className="mt-4 px-2 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-faint">
        Gateway
      </div>
      <Item to="/gateway/playground" icon={ic(<><path d="M12 2v4" /><path d="m4.9 4.9 2.8 2.8" /><path d="M2 12h4" /><path d="M18 12h4" /><path d="m16.3 7.7 2.8-2.8" /><circle cx="12" cy="14" r="4" /></>)}>
        Playground
      </Item>
      <Item to="/gateway/usage" icon={ic(<><path d="M3 3v18h18" /><path d="m7 15 3-4 3 2 4-6" /></>)}>
        Usage
      </Item>
      <Item to="/gateway/connections" icon={ic(<><rect x="2" y="7" width="20" height="10" rx="2" /><path d="M6 12h.01M12 12h.01" /></>)}>
        Credentials
      </Item>
      <Item to="/gateway/secrets" icon={ic(<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>)}>
        Secrets
      </Item>
      <Item to="/gateway/models" icon={ic(<><path d="M12 2 2 7l10 5 10-5-10-5Z" /><path d="m2 17 10 5 10-5" /><path d="m2 12 10 5 10-5" /></>)}>
        Models
      </Item>
      <Item to="/gateway/keys" icon={ic(<><circle cx="7.5" cy="15.5" r="3.5" /><path d="m10 13 8-8" /><path d="m14 5 3 3" /><path d="m18 9 2-2" /></>)}>
        Virtual keys
      </Item>
      <Item to="/gateway/budgets" icon={ic(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>)}>
        Budgets
      </Item>
      <Item to="/gateway/tools" icon={ic(<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.4 2.4-2-2 2.4-2.4Z" />)}>
        Tools
      </Item>
      <Item to="/gateway/tools/analytics" icon={ic(<><rect x="4" y="12" width="4" height="8" rx="1" /><rect x="10" y="7" width="4" height="13" rx="1" /><rect x="16" y="3" width="4" height="17" rx="1" /></>)}>
        Tool analytics
      </Item>

      <div className="mt-4 px-2 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-faint">
        Observability
      </div>
      <Item to="/traces" icon={ic(<path d="M4 6h16M4 12h10M4 18h7" />)}>
        Traces
      </Item>
      <Item to="/sessions" icon={ic(<path d="M4 6h16v12H4z" />)}>
        Sessions
      </Item>
      <Item to="/observability" icon={ic(<path d="M4 18V8M10 18V4M16 18v-6" />)}>
        Dashboards
      </Item>
      <Item to="/observability/feedback" icon={ic(<><path d="M20 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" /></>)}>
        Feedback
      </Item>
      <Item to="/observability/settings" icon={ic(<circle cx="12" cy="12" r="3" />)}>
        Settings
      </Item>

      <div className="mt-4 px-2 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-faint">
        Evaluations
      </div>
      <Item to="/evaluations" icon={ic(<><path d="M9 11V7a3 3 0 0 1 6 0v4" /><rect x="5" y="11" width="14" height="10" rx="2" /></>)}>
        Datasets
      </Item>
      <Item to="/evaluations/rules" icon={ic(<><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></>)}>
        Rules
      </Item>
      </nav>
    </aside>
  );
}
