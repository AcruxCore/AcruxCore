import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button, Field, Input } from '@/ui';
import { useAuth } from '@/auth/AuthContext';
import { AuthLayout } from './AuthLayout';
import { authClient, mapAuthError } from './authClient';

const schema = z.object({ password: z.string().min(8, 'Use at least 8 characters.') });
type Form = z.infer<typeof schema>;

/**
 * Landing page for the password-reset link.
 *
 * The reset token arrives as `?token=` in the query, put there by Better Auth's
 * redirect. Notably this page is NOT signed in while it runs: the token alone
 * authorizes the change, and no session exists until the new password is set.
 * That is deliberate — a link that granted a session before the password changed
 * would be a way in, not just a way to reset.
 */
export function ResetPasswordUpdatePage() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  // Better Auth redirects here with `?error=INVALID_TOKEN` when the link is
  // already used or expired, rather than passing a token through.
  const linkError = searchParams.get('error');
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Form>({ resolver: zodResolver(schema) });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    if (!token) {
      setFormError('This reset link is incomplete. Request a new one from the sign-in page.');
      return;
    }
    const { error } = await authClient.resetPassword({ newPassword: values.password, token });
    if (error) {
      setFormError(mapAuthError(error));
      return;
    }
    // Resetting does not sign the user in, so send them to the sign-in page with
    // their new password rather than into the app.
    await refresh();
    navigate('/login', { replace: true });
  });

  return (
    <AuthLayout
      title="Set a new password"
      subtitle="Choose a password to finish resetting."
      footer={
        <Link to="/login" className="text-accent hover:underline">
          Back to sign in
        </Link>
      }
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <Field
          label="New password"
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
        {(formError ?? (linkError ? 'That link is no longer valid. Request a new one.' : null)) && (
          <p className="text-[13px] text-danger">
            {formError ?? 'That link is no longer valid. Request a new one.'}
          </p>
        )}
        <Button type="submit" variant="primary" disabled={isSubmitting} className="mt-1">
          {isSubmitting ? 'Updating…' : 'Update password'}
        </Button>
      </form>
    </AuthLayout>
  );
}
