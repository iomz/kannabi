import { isRouteErrorResponse, Link, Outlet, redirect, useRouteError } from 'react-router';
import { api, unwrap } from '../api';
import { GroupNavigation, loadRelationship, Relationship, type GroupRelationship } from '../group-destination';
import { Eyebrow, PageHeading, Panel } from '../ui';
import type { Route } from './+types/group';

/** A Group's destination, addressed by its key and never by its name, so the
 * address survives a rename and two Groups with confusable names stay two
 * addresses — the same reason `users/:key` exists.
 *
 * Reachable by the Group's members — its Group Managers among them.
 * Everybody else, a system administrator included, gets the answer an unknown
 * Group gets. */
export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  if (!(await unwrap(await api.me.$get())).user) throw redirect('/signin');
  return loadRelationship(params.key);
}

export default function Group({ loaderData }: Route.ComponentProps) {
  const { group, viewer } = loaderData;
  return <>
    {/* A long name wraps rather than pushing the relationship off the line,
        and on a phone the relationship moves under it. */}
    <PageHeading eyebrow="Group" className="mb-5 max-sm:flex-col max-sm:items-start max-sm:gap-3"
      title={<span className="[overflow-wrap:anywhere]">{group.name}</span>}>
      <span className="shrink-0"><Relationship viewer={viewer} /></span>
    </PageHeading>
    <GroupNavigation />
    <Outlet context={loaderData satisfies GroupRelationship} />
  </>;
}

/** The single answer for a Group that does not exist and for one this viewer
 * cannot reach. It says both, because it cannot say which. */
export function ErrorBoundary() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : null;
  return <Panel><Eyebrow>{status ?? 'Connection error'}</Eyebrow>
    <h1>{status === 404 ? 'Group unavailable' : 'Unable to load this Group'}</h1>
    <p>{status === 404
      ? 'This Group does not exist, or you are not one of its members.'
      : 'Check your connection and try again.'}</p>
    <Link to="/groups">Back to Groups</Link>
  </Panel>;
}
