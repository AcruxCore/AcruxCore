import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Spinner } from '@/ui';
import { useAuth } from '@/auth/AuthContext';
import { AuthLayout } from './AuthLayout';
import { safeNext } from './next-param';

/**
 * Landing page for the email-confirmation link.
 *
 * The API verifies the token and redirects here, signing the user in on the way
 * (`autoSignInAfterVerification`), so this page's only job is to wait for
 * `/auth/me` and forward. A link that was expired or already used redirects with
 * `?error=`, which is the failure case shown below — previously that state was
 * indistinguishable from "still working" and could only be detected by timing
 * out.
 */
export function VerifyEmailPage() {
  const { isAuthenticated, isLoading } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // By the time this page runs the API has already verified the address and set
  // the session cookie — the only thing left for the URL to contribute is where
  // the user was headed before they left to confirm their email.
  const next = safeNext(searchParams.get('next'));
  const linkError = searchParams.get('error');
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (isAuthenticated) {
      navigate(next, { replace: true });
    }
  }, [isAuthenticated, navigate, next]);

  // Give the URL-code exchange a few seconds before declaring failure.
  useEffect(() => {
    const t = setTimeout(() => setTimedOut(true), 3000);
    return () => clearTimeout(t);
  }, []);

  if (isAuthenticated) return <Navigate to={next} replace />;

  if (!linkError && (isLoading || !timedOut)) {
    return (
      <AuthLayout title="Verifying…" subtitle="Confirming your email address." footer={null}>
        <div className="flex justify-center py-4">
          <Spinner className="h-6 w-6" />
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Link expired"
      subtitle="This verification link is no longer valid."
      footer={
        <Link to="/login" className="text-accent hover:underline">
          Back to sign in
        </Link>
      }
    >
      <p className="text-[13px] text-muted">
        The link may have expired or already been used. Try signing in — if your email still isn't
        confirmed, sign up again to get a fresh link.
      </p>
    </AuthLayout>
  );
}
