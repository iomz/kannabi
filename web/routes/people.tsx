import { Form, Link, redirect, useNavigation } from 'react-router';
import { api, unwrap } from '../api';
import { Avatar } from '../avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState, Hint, PageHeading, Panel } from '../ui';
import type { Route } from './+types/people';

/** The People directory: who this viewer can find on the instance.
 *
 * Who appears, and whether their email address does, is the instance's People
 * directory setting, decided by the server. Group badges are only the Groups
 * this viewer shares with each person, never their full membership. The
 * search lives in the address, so a result can be linked and Back restores it.
 */
export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const { user } = await unwrap(await api.me.$get());
  if (!user) throw redirect('/signin');
  const q = new URL(request.url).searchParams.get('q')?.trim() ?? '';
  const [found, { settings }] = await Promise.all([
    api.people.$get({ query: { q: q || undefined } }).then(unwrap),
    api.settings.$get().then(unwrap),
  ]);
  return { ...found, q, directory: settings.peopleDirectory };
}

/** How many of somebody's reported Assets the viewer can read, said as the
 * viewer would say it of themself or of somebody else. */
export function reportedHint(count: number, self: boolean): string {
  const assets = count === 1 ? '1 Asset' : `${count} Assets`;
  return self ? `You reported ${assets} you can read` : `${assets} reported by this person that you can read`;
}

export default function People({ loaderData: { people, more, q, directory } }: Route.ComponentProps) {
  const busy = useNavigation().state !== 'idle';
  return <>
    <PageHeading eyebrow="Workspace" title="People" description={directory === 'shared'
      ? 'People you share a Group with.' : 'Everybody taking part in this instance.'} />
    <Form method="get" role="search" className="mb-4 flex max-w-xl gap-2">
      <Input type="search" name="q" defaultValue={q} aria-label="Search people"
        placeholder={directory === 'everyone' ? 'Name or email' : 'Name'} autoComplete="off" />
      <Button type="submit" variant="outline" disabled={busy}>Search</Button>
    </Form>
    {people.length === 0
      ? <Panel className="p-0"><EmptyState>
        <h2>{q ? 'Nobody matches' : 'Nobody to show yet'}</h2>
        <p>{q ? `Nobody you can find matches “${q}”.` : 'People appear here once you share a Group with them.'}</p>
      </EmptyState></Panel>
      : <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {people.map((person) => <li key={person.key}>
          <Link to={`/users/${person.key}`}
            className="flex h-full items-center gap-3 rounded-xl border bg-card p-4 text-inherit hover:bg-accent">
            <Avatar name={person.name} hash={person.avatarHash} size={40} />
            <span className="grid min-w-0 gap-1">
              <span className="flex min-w-0 items-center gap-2">
                <strong className="truncate font-[650]">{person.name}</strong>
                {person.self && <Badge variant="secondary">You</Badge>}
              </span>
              {/* Text, not a link: the whole card already leads to the profile,
                  where the address is a mail link. */}
              {person.email && <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{person.email}</span>}
              <Hint>{reportedHint(person.reportedAssets, person.self)}</Hint>
              {person.sharedGroups.length > 0 && <span className="flex flex-wrap gap-1">
                <span className="sr-only">Shared Groups: </span>
                {person.sharedGroups.map((group) =>
                  <Badge key={group.key} variant="secondary">{group.name}</Badge>)}
              </span>}
            </span>
          </Link>
        </li>)}
      </ul>}
    {more && <Hint className="mt-4">More people match than are shown. Search to narrow the list.</Hint>}
  </>;
}

export { WorkspaceError as ErrorBoundary } from '../route-error';
