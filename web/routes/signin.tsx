import { Form, Link, redirect, useLocation, useNavigation } from 'react-router';
import { api, authClient, unwrap } from '../api';
import { PasswordField } from '../password-field';
import type { Route } from './+types/signin';
import { anonymousShellHandle } from '../anonymous-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, Hint } from '../ui';

export const handle = anonymousShellHandle;

export async function clientLoader() {
  if ((await unwrap(await api.me.$get())).user) throw redirect('/');
  return null;
}
export async function clientAction({ request }: Route.ClientActionArgs) {
  const data = await request.formData();
  const text = (key: string) => String(data.get(key) ?? '');
  try {
    const body = { email: text('email'), password: text('password'), name: text('name') };
    const result = text('intent') === 'signup' ? await authClient.signUp.email(body) : await authClient.signIn.email(body);
    if (result.error) throw new Error(result.error.message ?? 'Sign-in failed');
    return redirect('/');
  } catch (error) { return { error: error instanceof Error ? error.message : 'Sign-in failed' }; }
}
export default function SignIn({ actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== 'idle';
  const signup = useLocation().pathname === '/signup';
  return <div className="w-full">
    <p className="m-0 text-center text-[.9rem] text-muted-foreground">{signup ? 'Create your identity and begin building context.' : 'Your physical world, in context.'}</p>
    {actionData?.error && <p role="alert">{actionData.error}</p>}
    <section className="mt-8">
      <Form method="post"><fieldset disabled={busy}>
        <input type="hidden" name="intent" value={signup ? 'signup' : 'signin'} />
        {signup && <Field label="Name"><Input name="name" required autoComplete="name" /></Field>}
        <Field label="Email"><Input name="email" type="email" required autoComplete="email" /></Field>
        <PasswordField id="auth-password" label="Password" name="password" required minLength={signup ? 12 : undefined}
          autoComplete={signup ? 'new-password' : 'current-password'}
          aside={!signup && <Link className="text-sm" to="/forgot-password">Forgot password?</Link>} />
        {signup && <Hint className="mb-4">Use at least 12 characters.</Hint>}
        <Button type="submit" className="w-full">{signup ? 'Create account' : 'Sign in'}</Button>
      </fieldset></Form>
      {!signup && <>
        <div aria-hidden="true" className="my-6 flex items-center gap-3 text-xs text-muted-foreground before:h-px before:flex-1 before:bg-border before:content-[''] after:h-px after:flex-1 after:bg-border after:content-['']"><span>or</span></div>
        <Button type="button" variant="outline" className="w-full" disabled aria-describedby="passkey-availability">Continue with passkey</Button>
        <p id="passkey-availability" className="mt-[.45rem] text-center text-[.72rem] text-muted-foreground">Coming soon</p>
      </>}
      <p className="mt-6 text-center text-[.85rem] text-muted-foreground">
        {signup ? 'Already have an account? ' : 'New to Kannabi? '}
        <Link to={signup ? '/signin' : '/signup'} className="font-[550]">{signup ? 'Sign in' : 'Create an account'}</Link>
      </p>
    </section>
  </div>;
}

export { WorkspaceError as ErrorBoundary } from '../route-error';
