/** Light/dark theme control. Dark is the product default. */
export type Theme = 'dark' | 'light';

const KEY = 'acruxcore-theme';

/**
 * Read the active theme from the document root.
 *
 * @returns The current theme, defaulting to `'dark'`.
 */
export function getTheme(): Theme {
  // Guarded for server-side prerendering (build-time `renderToString`), where
  // `document` is undefined; the SPA re-reads the real value on the client.
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.getAttribute('data-theme') === 'light'
    ? 'light'
    : 'dark';
}

/**
 * Apply a theme to the document root and persist the choice.
 *
 * @param theme - The theme to activate.
 */
export function setTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // localStorage may be unavailable (private mode); theme still applies for the session.
  }
}

/** Restore the persisted theme on boot; falls back to the dark default. */
export function initTheme(): void {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    saved = null;
  }
  setTheme(saved === 'light' ? 'light' : 'dark');
}

/** Flip between dark and light. */
export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}
