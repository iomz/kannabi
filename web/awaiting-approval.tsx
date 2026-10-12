import { Form, Link } from 'react-router';
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

/** What a new account sees until an administrator approves it. */
export function AwaitingApproval({ name }: { name: string }) {
  return <section className="grid gap-4 rounded-xl border bg-card p-6">
    <h1 className="m-0 text-xl">Waiting for approval</h1>
    <p className="m-0">Thanks, {name}. An administrator of this Kannabi instance needs to approve your account before
      you can find people, join Groups or work with Assets. Public Assets stay readable in the meantime.</p>
    <p className="m-0 text-sm text-muted-foreground">You can still change your <Link to="/settings">account settings</Link>.</p>
    <Form method="post" action="/"><Button type="submit" variant="outline">Sign out</Button></Form>
  </section>;
}
