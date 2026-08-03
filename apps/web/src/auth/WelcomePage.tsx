import { useEffect } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import { Button } from '@/ui';
import { AuthLayout } from './AuthLayout';

/**
 * Landing page after email verification. The verification email links here via
 * the Better Auth `callbackURL` param — the server has already set the session
 * cookie before the redirect arrives, so this page only needs to confirm the
 * session and present a friendly welcome with a path into the dashboard.
 */
export function WelcomePage() {
  const { isAuthenticated, isLoading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (isAuthenticated) {
      // No-op — the user sees the welcome card; they navigate manually.
    }
  }, [isAuthenticated]);

  if (isLoading) {
    return (
      <AuthLayout title="Welcome to acruxcore" subtitle="Setting up your account…" footer={null}>
        <div className="flex justify-center py-4">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        </div>
      </AuthLayout>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return (
    <AuthLayout
      title="Welcome to acruxcore"
      subtitle="Your account is ready. Start building with AI."
      footer={
        <Link to="/login" className="text-accent hover:underline">
          Back to sign in
        </Link>
      }
    >
      <div className="flex flex-col items-center gap-4 text-center">
        <p className="text-[13px] text-muted">
          You're all set! Head to the dashboard to create your first prompt, connect a model, or
          explore the playground.
        </p>
        <Button variant="primary" className="w-full" onClick={() => navigate('/prompts')}>
          Go to Dashboard
        </Button>
      </div>
    </AuthLayout>
  );
}
