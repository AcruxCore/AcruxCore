import { useState } from 'react';
import { Button } from '@/ui';
import { authClient, mapAuthError } from './authClient';
import { useAuthCapabilities } from './useAuthCapabilities';

/**
 * Google sign-in, including its "or" separator — or nothing at all on a
 * deployment with no Google credentials configured.
 *
 * The gate is the point: Google is optional, so most self-hosted installs have
 * no client ID. Rendering the button unconditionally gave every one of them a
 * control that fails the moment it is pressed. Asking the server which methods
 * exist keeps that decision in the one place that actually knows.
 *
 * The separator lives here rather than in each page so a page cannot show a
 * dangling "or" above a button that rendered nothing.
 *
 * @param mode - Affects only the label ("Sign in" vs "Sign up").
 * @param onError - Called with a user-facing message if the redirect can't start.
 * @param next - Where the user was headed before starting Google auth (e.g. an
 *   invite link). Threaded through as `?next=` on the callback URL so
 *   `AuthCallbackPage` can forward there instead of the default landing page.
 * @param disabled - Disables the button without hiding it, e.g. while a
 *   required consent checkbox is unchecked on signup.
 */
export function GoogleSignIn(props: {
  mode: 'signin' | 'signup';
  onError: (message: string) => void;
  next?: string;
  disabled?: boolean;
}) {
  const capabilities = useAuthCapabilities();
  if (!capabilities?.google) return null;
  return (
    <>
      <GoogleButton {...props} />
      <div className="flex items-center gap-3 text-[12px] text-muted">
        <span className="h-px flex-1 bg-line" />
        or
        <span className="h-px flex-1 bg-line" />
      </div>
    </>
  );
}

/**
 * The button itself. Starts Better Auth's OAuth redirect and comes back to
 * `/auth/callback` — a public page that waits for the session rather than
 * letting `ProtectedRoute` race it. Our API completes the code exchange and sets
 * the session cookie, and AuthContext then loads the local identity.
 *
 * `<APP_URL>/api/v1/auth/callback/google` must be registered as an authorised
 * redirect URI in the Google Cloud console for each deployed origin.
 */
function GoogleButton({
  mode,
  onError,
  next,
  disabled = false,
}: {
  mode: 'signin' | 'signup';
  onError: (message: string) => void;
  next?: string;
  disabled?: boolean;
}) {
  const [loading, setLoading] = useState(false);

  const start = async () => {
    setLoading(true);
    const callbackURL = next
      ? `/auth/callback?next=${encodeURIComponent(next)}`
      : '/auth/callback';
    const { error } = await authClient.signIn.social({ provider: 'google', callbackURL });
    if (error) {
      onError(mapAuthError(error));
      setLoading(false);
    }
    // On success the browser navigates away — no need to reset loading.
  };

  return (
    <Button
      type="button"
      variant="default"
      onClick={start}
      disabled={loading || disabled}
      className="w-full"
    >
      <GoogleGlyph />
      {loading
        ? 'Redirecting…'
        : mode === 'signin'
          ? 'Continue with Google'
          : 'Sign up with Google'}
    </Button>
  );
}

/** Google "G" mark, inline SVG so it needs no external asset. */
function GoogleGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}
