import { Link, redirect } from 'react-router';
import { api, unwrap } from '../api';
import { Avatar } from '../avatar';
import { Badge } from '@/components/ui/badge';
import { EmptyState, Hint, PageHeading, Panel } from '../ui';
import type { Route } from './+types/users';

export async function clientLoader() {
  const { user } = await unwrap(await api.me.$get());
  if (!user) throw redirect('/signin');
  return unwrap(await api.users.$get());
}

/** The people this account may know exist, and nothing more about them.
 *
 * Deliberately modest. A name, the picture they chose to have, and how much of
 * their work this viewer can already read — which is the one number that says
 * whether opening them is worth it. No address, no Group list, no roles: this
 * is discovery, and everything it does not show is something Kannabi has no
 * reason to publish here.
 */
export default function Users({ loaderData: { users } }: Route.ComponentProps) {
  return <>
    <PageHeading eyebrow="Workspace" title="Users"
      description="People you share a Group with, and people whose work you can already read." />
    {users.length === 0
      ? <Panel className="p-0"><EmptyState>
        <h2>Nobody to show yet</h2>
        <p>People appear here once you share a Group with them, or once you can read something
          they reported.</p>
      </EmptyState></Panel>
      : <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {users.map((person) => <li key={person.key}>
          <Link to={`/users/${person.key}`}
            className="flex h-full items-center gap-3 rounded-xl border bg-card p-4 text-inherit hover:bg-accent">
            <Avatar name={person.name} hash={person.avatarHash} size={40} />
            <span className="grid min-w-0 gap-1">
              <span className="flex min-w-0 items-center gap-2">
                <strong className="truncate font-[650]">{person.name}</strong>
                {person.self && <Badge variant="secondary">You</Badge>}
              </span>
              <Hint>{person.reportedAssets === 1
                ? '1 Asset you can read'
                : `${person.reportedAssets} Assets you can read`}</Hint>
            </span>
          </Link>
        </li>)}
      </ul>}
  </>;
}

export { WorkspaceError as ErrorBoundary } from '../route-error';
