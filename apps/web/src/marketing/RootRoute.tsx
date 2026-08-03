import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import { LandingPage } from './LandingPage';

/**
 * Entry route for `/`. Signed-out visitors see the public {@link LandingPage};
 * signed-in users are sent straight to the app dashboard — unless the visitor
 * arrived via a link that sets `location.state.fromLogo` to request the
 * marketing page explicitly. Set by the in-app logo link (see {@link Sidebar})
 * and by the marketing site's own header (logo + section links), so a
 * signed-in visitor browsing the public pages isn't bounced into the app.
 *
 * Renders the landing page *while* the auth check is still in flight rather than
 * a spinner. The session lives in an httpOnly cookie, so the only way to know
 * whether someone is signed in is to ask the API — and blocking on that would
 * mean every anonymous visitor, and every crawler that runs JavaScript, watches
 * the prerendered marketing HTML get replaced by a spinner until a 401 comes
 * back. Showing the public page immediately keeps the rendered DOM identical to
 * the prerendered one; a signed-in user who lands here instead sees it for the
 * length of one request before the redirect.
 *
 * @returns A redirect once the visitor is known to be signed in and didn't ask
 *   for the marketing page explicitly, the landing page otherwise.
 */
export function RootRoute() {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  const fromLogo = Boolean((location.state as { fromLogo?: boolean } | null)?.fromLogo);

  if (isAuthenticated && !fromLogo) {
    return <Navigate to="/prompts" replace />;
  }

  return <LandingPage />;
}
