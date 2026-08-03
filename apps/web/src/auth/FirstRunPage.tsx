import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button, Field, Input } from '@/ui';
import { ApiError, api } from '@/api';
import { AuthLayout } from './AuthLayout';

const schema = z.object({
  name: z.string().min(1, 'Enter your name.'),
  email: z.string().email('Enter a valid email address.'),
  password: z.string().min(8, 'Use at least 8 characters.'),
});
type Form = z.infer<typeof schema>;

/**
 * Claim screen for a fresh self-hosted install.
 *
 * Reached only from the one-time URL the API prints to its own log at boot, when
 * no accounts exist. Whoever opens it chooses their own credentials and becomes
 * owner — which is why nothing here is prefilled and no password is ever
 * transmitted to the operator: the log line carries a token, not a secret.
 *
 * The claim signs the new owner in directly (the response sets the session
 * cookie), so a full page load into the app is enough — there is no separate
 * sign-in step to get wrong on a brand-new instance.
 */
export function FirstRunPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Form>({ resolver: zodResolver(schema) });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    if (!token) {
      setFormError('This setup link is incomplete. Restart the server to print a new one.');
      return;
    }
    try {
      await api('/auth/first-run/claim', {
        method: 'POST',
        body: { token, email: values.email, password: values.password, name: values.name },
      });
      // Full load rather than a router navigate: the session cookie arrived with
      // this response, and a reload is the simplest way to have every provider
      // pick it up.
      window.location.assign('/prompts');
    } catch (err) {
      setFormError(
        err instanceof ApiError && err.status === 403
          ? 'This setup link is no longer valid — it may already have been used. Restart the server to print a new one.'
          : err instanceof ApiError
            ? err.message
            : 'Could not create the account. Please try again.',
      );
    }
  });

  return (
    <AuthLayout
      title="Set up acruxcore"
      subtitle="Create the first account. You'll be the owner."
      footer={null}
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <Field label="Your name" htmlFor="name" error={errors.name?.message}>
          <Input id="name" autoComplete="name" {...register('name')} />
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
        {formError && <p className="text-[13px] text-danger">{formError}</p>}
        <Button type="submit" variant="primary" disabled={isSubmitting} className="mt-1">
          {isSubmitting ? 'Creating…' : 'Create owner account'}
        </Button>
      </form>
    </AuthLayout>
  );
}
