import { useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuth } from '@/auth/AuthContext';
import { Button, Field, Input } from '@/ui';
import { AuthLayout } from './AuthLayout';
import { authClient, mapAuthError } from './authClient';
import { GoogleSignIn } from './GoogleButton';
import { safeNext } from './next-param';

const schema = z.object({
  name: z.string().trim().min(1, 'Enter your full name.'),
  email: z.string().email('Enter a valid email address.'),
  password: z.string().min(8, 'Use at least 8 characters.'),
});
type Form = z.infer<typeof schema>;

/**
 * Sign up with email/password (or Google). Email verification is on, so on
 * success we show a "check your inbox" state instead of entering the app.
 */
export function SignupPage() {
  const { isAuthenticated } = useAuth();
  const [searchParams] = useSearchParams();
  const next = safeNext(searchParams.get('next'));
  const [formError, setFormError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [wantsProductUpdates, setWantsProductUpdates] = useState(false);
  const [agreedToTerms, setAgreedToTerms] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Form>({ resolver: zodResolver(schema) });

  if (isAuthenticated) return <Navigate to={next} replace />;

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    const { data, error } = await authClient.signUp.email({
      email: values.email,
      password: values.password,
      name: values.name,
      marketingConsent: wantsProductUpdates,
      callbackURL: `/welcome`,
    });
    if (error) {
      setFormError(mapAuthError(error));
      return;
    }
    // Whether a session comes back is decided by the SERVER, not this page: with
    // a mail transport configured the address must be verified first and no
    // session is issued, while a self-hosted install with EMAIL_TRANSPORT=none
    // signs the user straight in (no verification mail could ever arrive). So
    // branch on what actually came back rather than assuming either mode.
    if (data?.token) {
      window.location.assign(next);
      return;
    }
    setSentTo(values.email);
  });

  if (sentTo) {
    return (
      <AuthLayout
        title="Check your inbox"
        subtitle="One more step to activate your account."
        footer={
          <Link to="/login" className="text-accent hover:underline">
            Back to sign in
          </Link>
        }
      >
        <p className="text-[13px] text-muted">
          We sent a verification link to <span className="text-ink">{sentTo}</span>. Click it to
          finish creating your account, then sign in.
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Create your account"
      subtitle="You'll get a personal workspace to start."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="text-accent hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <GoogleSignIn
          mode="signup"
          onError={setFormError}
          next={next}
          disabled={!agreedToTerms}
        />
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          <Field label="Full name" htmlFor="name" error={errors.name?.message}>
            <Input id="name" type="text" autoComplete="name" {...register('name')} />
          </Field>
          <Field label="Email" htmlFor="email" error={errors.email?.message}>
            <Input id="email" type="email" autoComplete="email" {...register('email')} />
          </Field>
          <Field
            label="Password"
            htmlFor="password"
            error={errors.password?.message}
            hint="At least 8 characters"
          >
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              {...register('password')}
            />
          </Field>
          <label className="flex items-start gap-2 text-[12.5px] text-muted">
            <input
              type="checkbox"
              checked={wantsProductUpdates}
              onChange={(e) => setWantsProductUpdates(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 accent-[var(--accent)]"
            />
            Send me product updates and new features as they ship
          </label>
          <label className="flex items-start gap-2 text-[12.5px] text-muted">
            <input
              type="checkbox"
              checked={agreedToTerms}
              onChange={(e) => setAgreedToTerms(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 accent-[var(--accent)]"
            />
            <span>
              I agree to the{' '}
              <Link to="/terms" target="_blank" className="text-accent hover:underline">
                Terms of Service
              </Link>{' '}
              and{' '}
              <Link to="/privacy" target="_blank" className="text-accent hover:underline">
                Privacy Policy
              </Link>
            </span>
          </label>
          {formError && <p className="text-[13px] text-danger">{formError}</p>}
          <Button
            type="submit"
            variant="primary"
            disabled={isSubmitting || !agreedToTerms}
            className="mt-1"
          >
            {isSubmitting ? 'Creating…' : 'Create account'}
          </Button>
        </form>
      </div>
    </AuthLayout>
  );
}
