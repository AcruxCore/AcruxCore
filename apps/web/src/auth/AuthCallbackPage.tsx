import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Spinner } from '@/ui';
import { useAuth } from '@/auth/AuthContext';
import { AuthLayout } from './AuthLayout';
import { safeNext } from './next-param';

/**
 * Public landing for the OAuth (Google) redirect.
 *
 * By the time the browser arrives the session cookie is already set: our API
 * performed the code exchange and redirected here, so this page only has to wait
 * for `/auth/me` to come back. (Under Supabase the exchange happened *in the
 * browser* from a `?code=` in this URL, which is why this page used to wait
 * several seconds for something to happen client-side.) It stays a public route
 * so there is no ProtectedRoute race and no `/login` flash.
 *
 * `next` (set by `GoogleButton` when it started the redirect on behalf of an
 * invite or other deep link) is read through `safeNext` — never trusted raw —
 * so an invited person who signed in with Google lands back on the invite
 * instead of an empty personal workspace.
 */
export function AuthCallbackPage() {
  const { isAuthenticated, isLoading } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const next = safeNext(searchParams.get('next'));
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (isAuthenticated) navigate(next, { replace: true });
  }, [isAuthenticated, navigate, next]);

  useEffect(() => {
    const t = setTimeout(() => setTimedOut(true), 3000);
    return () => clearTimeout(t);
  }, []);

  if (isAuthenticated) return <Navigate to={next} replace />;

  if (isLoading || !timedOut) {
    return (
      <AuthLayout title="Signing you in…" subtitle="Finishing authentication." footer={null}>
        <div className="flex justify-center py-4">
          <Spinner className="h-6 w-6" />
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Sign-in didn't complete"
      subtitle="We couldn't finish authenticating you."
      footer={
        <Link to="/login" className="text-accent hover:underline">
          Back to sign in
        </Link>
      }
    >
      <p className="text-[13px] text-muted">
        The sign-in link may have expired. Please try again from the sign-in page.
      </p>
    </AuthLayout>
  );
}
