import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

/** Authenticated app frame: fixed sidebar + top bar, scrollable content. */
export function AppShell() {
  return (
    <div className="flex h-screen w-full overflow-hidden">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1120px] px-7 py-6">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
