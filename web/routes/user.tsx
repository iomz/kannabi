import { Link, redirect } from 'react-router';
import { api, unwrap } from '../api';
import { Avatar } from '../avatar';
import type { Route } from './+types/user';

export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  const { user } = await unwrap(await api.me.$get());
  if (!user) throw redirect('/signin');
  const response = await api.users[':key'].$get({ param: { key: params.key } });
  if (response.status === 404) throw new Response('User not found', { status: 404 });
  return unwrap(response);
}

/** A deliberately sparse first User page.
 *
 * It shows what Kannabi already tells anybody who can see this person's work,
 * and one number that is counted through the viewer's own readability. There
 * is no biography, no address and no Group list, because Kannabi does not hold
 * the first and is not entitled to publish the others.
 */
export default function UserPage({ loaderData: { profile } }: Route.ComponentProps) {
  return <>
    <div className="page-heading"><div><p className="eyebrow">{profile.self ? 'Your account' : 'Member'}</p>
      <div className="user-heading">
        <Avatar name={profile.name} hash={profile.avatarHash} size={56} className="user-avatar" />
        <h1>{profile.name}</h1>
      </div>
    </div>
      {profile.self && <Link to="/settings" className="button">Settings</Link>}
    </div>
    <section className="panel">
      <dl>
        <dt>Assets reported</dt>
        <dd>{profile.reportedAssets}</dd>
      </dl>
      <p className="hint">{profile.self
        ? 'Counted across everything you can read.'
        : 'Counted across what you can read. Assets in Groups you do not belong to are not included.'}</p>
    </section>
  </>;
}
export { WorkspaceError as ErrorBoundary } from '../route-error';
