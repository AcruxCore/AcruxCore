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
import { readRuntimeConfig } from '@/lib/runtime-config';
import { App } from '@/app/App';
import '@/styles/tokens.css';

// The DSN comes from /runtime-config.js, which the web container writes at
// start-up (see src/lib/runtime-config.ts), so one published image serves
// every install. A no-op when unset, so local dev needs no Sentry project.
//
// `import.meta.env.PROD` is the browser-side counterpart of the API's
// `NODE_ENV === 'production'` check: it is false under the Vite dev server.
// Without it, a developer running `npm run dev` against a configured
// runtime-config.js would file every hot-reload error as a production issue.
const { sentryWebDsn } = readRuntimeConfig();
if (sentryWebDsn && import.meta.env.PROD) {
  Sentry.init({
    dsn: sentryWebDsn,
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
