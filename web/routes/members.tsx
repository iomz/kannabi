import { Link, redirect } from 'react-router';
import { api, unwrap } from '../api';
import { Avatar } from '../avatar';
import { Badge } from '@/components/ui/badge';
import { EmptyState, Hint, PageHeading, Panel } from '../ui';
import type { Route } from './+types/members';

export async function clientLoader() {
  const { user } = await unwrap(await api.me.$get());
  if (!user) throw redirect('/signin');
  return unwrap(await api.members.$get());
}

/** Active Users who share at least one Group with this account.
 *
 * No address, role, or unrelated Group membership appears. Group badges are
 * only the intersection between this viewer and this person.
 */
export default function Members({ loaderData: { members } }: Route.ComponentProps) {
  return <>
    <PageHeading eyebrow="Workspace" title="Members"
      description="People you collaborate with through shared Groups." />
    {members.length === 0
      ? <Panel className="p-0"><EmptyState>
        <h2>Nobody to show yet</h2>
        <p>People appear here once you share a Group with them.</p>
      </EmptyState></Panel>
      : <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {members.map((person) => <li key={person.key}>
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
              {person.sharedGroups.length > 0 && <span className="flex flex-wrap gap-1">
                <span className="sr-only">Shared Groups: </span>
                {person.sharedGroups.map((group) =>
                  <Badge key={group.key} variant="secondary">{group.name}</Badge>)}
              </span>}
            </span>
          </Link>
        </li>)}
      </ul>}
  </>;
}

export { WorkspaceError as ErrorBoundary } from '../route-error';
