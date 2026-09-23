import { Link } from 'react-router';
import { useState, type FormEvent } from 'react';
import { authClient } from '../api';
import { anonymousShellHandle } from '../anonymous-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Eyebrow, Field, Hint } from '../ui';

export const handle = anonymousShellHandle;

export default function ForgotPassword() {
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const email = String(new FormData(event.currentTarget).get('email') ?? '');
    try {
      const result = await authClient.requestPasswordReset({ email });
      if (result.error) throw result.error;
      setComplete(true);
    } catch {
      setError('Password recovery is temporarily unavailable. Try again later.');
    } finally { setBusy(false); }
  }

  return <div className="w-full [&>h1]:text-center">
    <Eyebrow className="text-center">Account recovery</Eyebrow><h1>Reset your password</h1>
    <p className="text-center text-[.9rem] text-muted-foreground">Enter your account email to request a reset link.</p>
    <section className="mt-8">
      {complete ? <>
        <h2>Check your email</h2>
        <p>If an eligible account exists for that email, a password-reset message has been sent.</p>
        <Hint>Delivery can take a few minutes. You can request another link if this one does not arrive.</Hint>
      </> : <>
        <h2>Request reset link</h2>
        {error && <p role="alert">{error}</p>}
        <form onSubmit={submit}><fieldset disabled={busy}>
          <Field label="Email"><Input name="email" type="email" required autoComplete="email" autoFocus /></Field>
          <Button type="submit">{busy ? 'Requesting…' : 'Send reset link'}</Button>
        </fieldset></form>
      </>}
      <Link className="mt-4 inline-block text-[.85rem]" to="/signin">Return to sign in</Link>
    </section>
  </div>;
}

export { WorkspaceError as ErrorBoundary } from '../route-error';
