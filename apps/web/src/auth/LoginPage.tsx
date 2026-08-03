import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
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
  email: z.string().email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
});
type Form = z.infer<typeof schema>;

/** Email/password + Google login. Redirects to the intended path (or /prompts). */
export function LoginPage() {
  const { isAuthenticated, refresh } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const [formError, setFormError] = useState<string | null>(null);
  // Query param wins (it survives full page loads, e.g. from the invite email
  // flow); fall back to router state for any in-app caller still using it.
  const stateFrom = (location.state as { from?: string } | null)?.from;
  const from = safeNext(searchParams.get('next') ?? stateFrom);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Form>({ resolver: zodResolver(schema) });

  if (isAuthenticated) return <Navigate to={from} replace />;

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    const { error } = await authClient.signIn.email({
      email: values.email,
      password: values.password,
    });
    if (error) {
      setFormError(mapAuthError(error));
      return;
    }
    // The session cookie is set by the response; load the local identity before
    // navigating so ProtectedRoute sees us as authenticated and doesn't bounce
    // back to /login.
    await refresh();
    navigate(from, { replace: true });
  });

  return (
    <AuthLayout
      title="Sign in"
      subtitle="Manage your prompts, versions, and team."
      footer={
        <>
          No account?{' '}
          <Link to="/signup" className="text-accent hover:underline">
            Create one
          </Link>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <GoogleSignIn mode="signin" onError={setFormError} next={from} />
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          <Field label="Email" htmlFor="email" error={errors.email?.message}>
            <Input id="email" type="email" autoComplete="email" {...register('email')} />
          </Field>
          <Field
            label="Password"
            htmlFor="password"
            error={errors.password?.message}
            hint={
              <Link to="/reset-password" className="text-accent hover:underline">
                Forgot password?
              </Link>
            }
          >
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              {...register('password')}
            />
          </Field>
          {formError && <p className="text-[13px] text-danger">{formError}</p>}
          <Button type="submit" variant="primary" disabled={isSubmitting} className="mt-1">
            {isSubmitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </div>
    </AuthLayout>
  );
}
