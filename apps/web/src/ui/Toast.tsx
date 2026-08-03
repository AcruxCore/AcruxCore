import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/cn';

type Tone = 'success' | 'error' | 'info';
/** Optional extras for a toast beyond its title. */
interface ToastOptions {
  /** In-app route to navigate to when the toast is clicked. */
  href?: string;
}
interface ToastItem {
  id: number;
  title: string;
  tone: Tone;
  href?: string;
}

interface ToastApi {
  /** Show a toast. Defaults to the `info` tone. */
  toast: (title: string, tone?: Tone, options?: ToastOptions) => void;
  success: (title: string, options?: ToastOptions) => void;
  error: (title: string, options?: ToastOptions) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * Access the toast API. Must be used within {@link ToastProvider}.
 *
 * @returns Functions to raise success/error/info toasts.
 * @throws {Error} If used outside a ToastProvider.
 */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

const TONE_STYLES: Record<Tone, string> = {
  success: 'border-ok/50 text-ink',
  error: 'border-danger/50 text-ink',
  info: 'border-line text-ink',
};
const TONE_DOT: Record<Tone, string> = {
  success: 'bg-ok',
  error: 'bg-danger',
  info: 'bg-accent',
};

/** Provides the toast API and renders the toast stack (bottom-right). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);

  const remove = useCallback((id: number) => {
    setItems((cur) => cur.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (title: string, tone: Tone = 'info', options?: ToastOptions) => {
      const id = next.current++;
      setItems((cur) => [...cur, { id, title, tone, href: options?.href }]);
      window.setTimeout(() => remove(id), 4000);
    },
    [remove],
  );

  const api = useMemo<ToastApi>(
    () => ({
      toast,
      success: (t: string, options?: ToastOptions) => toast(t, 'success', options),
      error: (t: string, options?: ToastOptions) => toast(t, 'error', options),
    }),
    [toast],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
        {items.map((t) => {
          const itemClassName = cn(
            'pointer-events-auto flex items-center gap-3 rounded-lg border bg-surface px-3.5 py-3',
            'text-left text-[13px] shadow-xl',
            TONE_STYLES[t.tone],
          );
          const dot = <span className={cn('h-2 w-2 flex-none rounded-full', TONE_DOT[t.tone])} />;
          return t.href ? (
            <Link key={t.id} to={t.href} onClick={() => remove(t.id)} className={itemClassName}>
              {dot}
              {t.title}
            </Link>
          ) : (
            <button
              key={t.id}
              type="button"
              onClick={() => remove(t.id)}
              className={itemClassName}
            >
              {dot}
              {t.title}
            </button>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
