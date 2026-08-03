import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import * as Sentry from '@sentry/react';
import { queryClient } from '@/api';
import { AuthProvider } from '@/auth/AuthContext';
import { ToastProvider, CookieConsentBanner } from '@/ui';
import { initTheme } from '@/lib/theme';
import { initAnalytics } from '@/lib/analytics';
import { App } from '@/app/App';
import '@/styles/tokens.css';

// `VITE_SENTRY_DSN` is not set directly — vite.config.ts maps the repo's
// canonical `SENTRY_WEB_DSN` env var onto it at build time, so one variable
// name is used everywhere (local .env, docker-compose, this bundle). A no-op
// when unset, so local dev needs no Sentry project.
//
// `import.meta.env.PROD` is the browser-side counterpart of the API's
// `NODE_ENV === 'production'` check: it is false under the Vite dev server.
// Without it, a developer running `npm run dev` with the real DSN in the
// shared `.env` files every hot-reload error as a production issue, mixed in
// with real user errors and impossible to tell apart.
if (import.meta.env.VITE_SENTRY_DSN && import.meta.env.PROD) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: 'production',
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: 0.1,
  });
}

initTheme();
initAnalytics();

const root = document.getElementById('root');
if (!root) throw new Error('#root element not found');

createRoot(root).render(
  <StrictMode>
    <Sentry.ErrorBoundary fallback={<AppCrashFallback />}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthProvider>
            <ToastProvider>
              <App />
              <CookieConsentBanner />
            </ToastProvider>
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </Sentry.ErrorBoundary>
  </StrictMode>,
);

/** Fallback shown in place of the whole app when a render error escapes to the root boundary. */
function AppCrashFallback() {
  return (
    <div style={{ padding: '2rem', textAlign: 'center', fontFamily: 'sans-serif' }}>
      <h1>Something went wrong</h1>
      <p>The error has been reported. Please refresh the page.</p>
    </div>
  );
}
