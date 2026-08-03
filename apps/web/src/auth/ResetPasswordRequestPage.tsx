import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button, Field, Input } from '@/ui';
import { AuthLayout } from './AuthLayout';
import { authClient, mapAuthError } from './authClient';

const schema = z.object({ email: z.string().email('Enter a valid email address.') });
type Form = z.infer<typeof schema>;

/**
 * "Forgot password" screen: emails a reset link that lands on
 * `/reset-password/update`. Always shows the same confirmation regardless of
 * whether the address exists, so it can't be used to probe for accounts.
 */
export function ResetPasswordRequestPage() {
  const [formError, setFormError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Form>({ resolver: zodResolver(schema) });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    const { error } = await authClient.requestPasswordReset({
      email: values.email,
      redirectTo: '/reset-password/update',
    });
    if (error) {
      setFormError(mapAuthError(error));
      return;
    }
    // Shown for an unknown address too — the API answers identically either way,
    // and a different screen here would undo that and leak which addresses are
    // registered.
    setSentTo(values.email);
  });

  if (sentTo) {
    return (
      <AuthLayout
        title="Check your inbox"
        subtitle="A reset link is on its way."
        footer={
          <Link to="/login" className="text-accent hover:underline">
            Back to sign in
          </Link>
        }
      >
        <p className="text-[13px] text-muted">
          If an account exists for <span className="text-ink">{sentTo}</span>, we've sent a link to
          reset your password.
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Reset your password"
      subtitle="We'll email you a link to set a new one."
      footer={
        <Link to="/login" className="text-accent hover:underline">
          Back to sign in
        </Link>
      }
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <Field label="Email" htmlFor="email" error={errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" {...register('email')} />
        </Field>
        {formError && <p className="text-[13px] text-danger">{formError}</p>}
        <Button type="submit" variant="primary" disabled={isSubmitting} className="mt-1">
          {isSubmitting ? 'Sending…' : 'Send reset link'}
        </Button>
      </form>
    </AuthLayout>
  );
}
