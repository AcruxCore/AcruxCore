import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { acceptInvite, ApiError, keys } from '@/api';
import { useAuth } from '@/auth/AuthContext';
import { Button, Spinner } from '@/ui';
import { AuthLayout } from './AuthLayout';

/**
 * Accept-invite landing. If signed in, accepts the token immediately; otherwise
 * routes through login/signup, returning here to complete acceptance.
 */
export function AcceptInvitePage() {
  const { token = '' } = useParams();
  const { isAuthenticated, isLoading, refresh } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const attempted = useRef(false);

  useEffect(() => {
    if (isLoading || !isAuthenticated || attempted.current) return;
    attempted.current = true;
    (async () => {
      try {
        await acceptInvite(token);
        // Refresh both identity and the team-switcher list so the newly-joined
        // team appears immediately (the switcher lives in the always-mounted
        // TopBar and would otherwise show it only after a full page reload).
        await Promise.all([
          qc.invalidateQueries({ queryKey: keys.me }),
          qc.invalidateQueries({ queryKey: keys.myTeams }),
        ]);
        await refresh();
        navigate('/team', { replace: true });
      } catch (e) {
        setError(
          e instanceof ApiError
            ? e.message
            : 'This invite could not be accepted. It may have expired or been used.',
        );
      }
    })();
  }, [isAuthenticated, isLoading, token, navigate, qc, refresh]);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  if (!isAuthenticated) {
    const next = encodeURIComponent(`/invite/${token}`);
    return (
      <AuthLayout
        title="You've been invited"
        subtitle="Sign in or create an account to join the team."
        footer={
          <>
            New here?{' '}
            <Link to={`/signup?next=${next}`} className="text-accent hover:underline">
              Create an account
            </Link>
          </>
        }
      >
        <Button
          variant="primary"
          className="w-full"
          onClick={() => navigate(`/login?next=${next}`)}
        >
          Sign in to accept
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={error ? 'Invite problem' : 'Joining team…'}
      subtitle={error ?? 'Adding you to the team.'}
      footer={
        <Link to="/prompts" className="text-accent hover:underline">
          Go to prompts
        </Link>
      }
    >
      {!error ? (
        <div className="flex justify-center py-2">
          <Spinner className="h-6 w-6" />
        </div>
      ) : (
        <Button variant="primary" className="w-full" onClick={() => navigate('/prompts')}>
          Continue
        </Button>
      )}
    </AuthLayout>
  );
}
