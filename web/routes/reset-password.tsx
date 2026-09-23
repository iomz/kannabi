import { Link, useRevalidator } from 'react-router';
import { useLayoutEffect, useState, type FormEvent } from 'react';
import { authClient } from '../api';
import { isInvalidResetError, resetTokenFromHash } from '../password-recovery';
import { PasswordField } from '../password-field';
import { anonymousShellHandle } from '../anonymous-shell';
import { Button } from '@/components/ui/button';
import { Eyebrow, Hint } from '../ui';

export const handle = anonymousShellHandle;

type ResetState = 'loading' | 'form' | 'invalid' | 'success';

export default function ResetPassword() {
  const [token, setToken] = useState<string | null>(null);
  const [state, setState] = useState<ResetState>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revalidator = useRevalidator();

  useLayoutEffect(() => {
    const value = resetTokenFromHash(window.location.hash);
    setToken(value);
    setState(value ? 'form' : 'invalid');
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return setState('invalid');
    const data = new FormData(event.currentTarget);
    const newPassword = String(data.get('newPassword') ?? '');
    const confirmation = String(data.get('confirmation') ?? '');
    if (newPassword !== confirmation) return setError('Passwords do not match.');
    setBusy(true);
    setError(null);
    try {
      const result = await authClient.resetPassword({ newPassword, token });
      if (result.error) {
        if (isInvalidResetError(result.error)) return setState('invalid');
        throw result.error;
      }
      setToken(null);
      setState('success');
      void revalidator.revalidate();
    } catch {
      setError('Password could not be set. Try again or request a new link.');
    } finally { setBusy(false); }
  }

  return <div className="w-full [&>h1]:text-center">
    <Eyebrow className="text-center">Account access</Eyebrow><h1>Choose a new password</h1>
    <section className="mt-8">
      {state === 'loading' && <p>Checking reset link…</p>}
      {state === 'invalid' && <>
        <h2>Link unavailable</h2>
        <p>This password link is invalid, expired, or has already been used.</p>
        <Link className="mt-4 inline-block text-[.85rem]" to="/forgot-password">Request another password link</Link>
      </>}
      {state === 'success' && <>
        <h2>Password set</h2>
        <p>Your password has been set. Sign in with your new password.</p>
        <Button className="mt-3" render={<Link to="/signin" />}>Return to sign in</Button>
      </>}
      {state === 'form' && <>
        {error && <p role="alert">{error}</p>}
        <form onSubmit={submit}><fieldset disabled={busy}>
          <PasswordField label="New password" name="newPassword" required minLength={12} maxLength={128}
            autoComplete="new-password" autoFocus />
          <PasswordField label="Confirm new password" name="confirmation" required minLength={12} maxLength={128}
            autoComplete="new-password" />
          <Hint className="mb-4">Use at least 12 characters.</Hint>
          <Button type="submit">{busy ? 'Setting…' : 'Set password'}</Button>
        </fieldset></form>
        <Link className="mt-4 inline-block text-[.85rem]" to="/signin">Return to sign in</Link>
      </>}
    </section>
  </div>;
}

export { WorkspaceError as ErrorBoundary } from '../route-error';
