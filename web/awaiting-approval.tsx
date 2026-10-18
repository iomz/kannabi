import { useEffect, useRef } from 'react';
import { Form, Link, useRevalidator } from 'react-router';
import { Button } from '@/components/ui/button';

/** Whether to show the waiting screen instead of the route.
 *
 * A signed-in account that waits for approval reaches its own account
 * settings and public pages, as the server allows, and is told why everywhere
 * else rather than meeting a page of refusals. */
export function awaitsApproval({ signedIn, approved, publicContent, pathname }: {
  signedIn: boolean; approved: boolean; publicContent: boolean; pathname: string;
}): boolean {
  return signedIn && !approved && !publicContent && !pathname.startsWith('/settings');
}

/** How often a visible waiting screen asks again whether it was approved. */
export const approvalCheckSeconds = 30;

/** What a new account sees until an administrator approves it.
 *
 * Approval is read with the account on every load, so asking again is
 * re-running the root loader: when the tab comes back into view, every
 * `approvalCheckSeconds` while it is visible, and on request. The shell then
 * changes by itself, without a reload. */
export function AwaitingApproval({ name }: { name: string }) {
  const revalidator = useRevalidator();
  const latest = useRef(revalidator);
  latest.current = revalidator;
  useEffect(() => {
    const check = () => { if (!document.hidden && latest.current.state === 'idle') void latest.current.revalidate(); };
    const timer = window.setInterval(check, approvalCheckSeconds * 1000);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
    };
  }, []);
  return <section className="grid gap-4 rounded-xl border bg-card p-6">
    <h1 className="m-0 text-xl">Waiting for approval</h1>
    <p className="m-0">Thanks, {name}. An administrator of this Kannabi instance needs to approve your account before
      you can find people, join Groups or work with Assets. Public Assets stay readable in the meantime.</p>
    <p className="m-0 text-sm text-muted-foreground">You can still change your <Link to="/settings">account settings</Link>.</p>
    <div className="flex flex-wrap gap-2">
      <Button type="button" disabled={revalidator.state !== 'idle'} onClick={() => void revalidator.revalidate()}>
        Check again</Button>
      <Form method="post" action="/"><Button type="submit" variant="outline">Sign out</Button></Form>
    </div>
  </section>;
}
