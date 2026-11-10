/** Light/dark theme control. Light is the product default. */
export type Theme = 'dark' | 'light';

/**
 * Where a theme the user picked with the toggle is stored.
 *
 * A new key, not the old `acruxcore-theme`: the old boot code wrote the dark default
 * into that key on every visit, so it cannot tell a real choice from a default. Reading
 * it would keep every earlier visitor on dark after light became the default.
 */
const KEY = 'acruxcore-theme-choice';

/**
 * Read the active theme from the document root.
 *
 * @returns The current theme, defaulting to `'light'`.
 */
export function getTheme(): Theme {
  // Guarded for server-side prerendering (build-time `renderToString`), where
  // `document` is undefined; the SPA re-reads the real value on the client.
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

// Applies a theme to the document root without saving it.
function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

/**
 * Apply a theme to the document root and persist it as the user's choice.
 *
 * @param theme - The theme to activate.
 */
export function setTheme(theme: Theme): void {
  applyTheme(theme);
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // localStorage may be unavailable (private mode); theme still applies for the session.
  }
}

/**
 * Restore the user's saved choice on boot, else the light default.
 *
 * Nothing is saved here, so a visitor who never used the toggle follows the default
 * if it changes again.
 */
export function initTheme(): void {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    saved = null;
  }
  applyTheme(saved === 'dark' ? 'dark' : 'light');
}

/** Flip between dark and light, and save the result as the user's choice. */
export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}
