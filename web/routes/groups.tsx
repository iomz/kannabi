import { useState } from 'react';
import { Form, Link, redirect, useNavigation } from 'react-router';
import { api, unwrap } from '../api';
import { CopyField } from '../copy-field';
import { notify } from '../notify';
import type { Route } from './+types/groups';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { EmptyState, Field, Hint, PageHeading, Panel } from '../ui';

/** The viewer's Groups: what each is, their role in it, and how much is in it.
 *
 * Everything a Group holds — its people, its Assets, its GS1 Company
 * Prefixes — lives on its own page; this is the way there, and the place a
 * new Group starts. */
export async function clientLoader() {
  const { user } = await unwrap(await api.me.$get());
  if (!user) throw redirect('/signin');
  const [{ groups }, { settings }] = await Promise.all([api.groups.$get().then(unwrap), api.settings.$get().then(unwrap)]);
  return { user, groups, directory: settings.peopleDirectory };
}

export async function clientAction({ request }: Route.ClientActionArgs) {
  const data = await request.formData();
  try {
    const { group } = await unwrap(await api.groups.$post({ json: { name: String(data.get('name') ?? '') } }));
    notify(`Created ${group.name}`);
    // A new Group's next step is the people it is for.
    return redirect(`/groups/${group.key}/people`);
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'The Group could not be created' };
  }
}

const count = (n: number, one: string, many: string) => `${new Intl.NumberFormat().format(n)} ${n === 1 ? one : many}`;

export default function Groups({ loaderData: { user, groups, directory }, actionData }: Route.ComponentProps) {
  const [creating, setCreating] = useState(false);
  return <>
    <PageHeading eyebrow="Collaboration" title="Groups" className="max-sm:flex-col max-sm:items-start max-sm:gap-3"
      description="A Group shares Assets among its members. Open one to see its Assets and people.">
      <Button type="button" onClick={() => setCreating(true)}>New Group</Button>
    </PageHeading>

    {groups.length === 0 ? <Panel className="mt-0"><EmptyState>
      <h2>You are not in any Group yet</h2>
      <p>Create one to start sharing Assets, or ask a Group Manager to add you.{' '}
        {directory === 'shared' ? 'They can find you by name once you share a Group; until then, send them your member key.'
          : 'They can find you by name.'}</p>
      {directory === 'shared' && <CopyField id="member-key" className="mx-auto mb-5 max-w-md text-left"
        label="Your member key" value={user.key} copyLabel="Copy your member key" copiedLabel="Member key copied" />}
      <Button type="button" onClick={() => setCreating(true)}>New Group</Button>
    </EmptyState></Panel>

      // A table on a wide screen; on a phone each row becomes a card. One list
      // either way, so nothing is said twice to a screen reader.
      : <div className="rounded-lg border bg-card max-sm:rounded-none max-sm:border-0 max-sm:bg-transparent">
        <table className="w-full text-sm max-sm:block">
          <caption className="sr-only">Your Groups</caption>
          <thead className="max-sm:sr-only"><tr className="border-b text-left text-muted-foreground">
            <th scope="col" className="px-4 py-2 font-medium">Group</th>
            <th scope="col" className="px-4 py-2 font-medium">Your role</th>
            <th scope="col" className="px-4 py-2 font-medium">People</th>
            <th scope="col" className="px-4 py-2 font-medium">Assets</th>
          </tr></thead>
          <tbody className="max-sm:grid max-sm:gap-3">{groups.map((group) => <tr key={group.key}
            className="border-b last:border-b-0 max-sm:grid max-sm:gap-2 max-sm:rounded-lg max-sm:border max-sm:bg-card
              max-sm:p-4 max-sm:last:border-b">
            <td className="px-4 py-3 align-top max-sm:p-0">
              <Link to={`/groups/${group.key}`} className="font-semibold [overflow-wrap:anywhere]">{group.name}</Link>
            </td>
            <td className="px-4 py-3 align-top max-sm:p-0">{group.role === 'manager'
              ? <Badge variant="outline">Group Manager</Badge> : <Badge variant="secondary">Member</Badge>}</td>
            <td className="px-4 py-3 align-top max-sm:p-0 max-sm:text-muted-foreground">
              <span className="sm:hidden">{count(group.people, 'person', 'people')}</span>
              <span className="max-sm:hidden">{new Intl.NumberFormat().format(group.people)}</span></td>
            <td className="px-4 py-3 align-top max-sm:p-0 max-sm:text-muted-foreground">
              <span className="sm:hidden">{count(group.assets, 'Asset', 'Assets')}</span>
              <span className="max-sm:hidden">{new Intl.NumberFormat().format(group.assets)}</span></td>
          </tr>)}</tbody>
        </table>
      </div>}

    {groups.length > 0 && directory === 'shared' && <CopyField id="member-key" className="mt-6 max-w-xl"
      label="Your member key" value={user.key} copyLabel="Copy your member key" copiedLabel="Member key copied" />}

    {creating && <CreateGroup error={actionData && 'error' in actionData ? actionData.error : null}
      onClose={() => setCreating(false)} />}
  </>;
}

/** Creating a Group asks for its name, then goes where the next thing happens:
 * adding the people it is for. */
function CreateGroup({ error, onClose }: { error: string | null; onClose(): void }) {
  const busy = useNavigation().state !== 'idle';
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent>
      <Form method="post" className="grid gap-6">
        <DialogHeader>
          <DialogTitle>New Group</DialogTitle>
          <DialogDescription>You become its first member and its Group Manager. Next, add the people who
            should share its Assets.</DialogDescription>
        </DialogHeader>
        <Field className="mb-0" label="Name"><Input name="name" required autoComplete="off" /></Field>
        {error && <p role="alert" className="m-0 text-sm">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>Create Group</Button>
        </DialogFooter>
      </Form>
    </DialogContent>
  </Dialog>;
}

export { WorkspaceError as ErrorBoundary } from '../route-error';
