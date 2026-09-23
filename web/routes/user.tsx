import { Link, redirect } from 'react-router';
import { api, unwrap } from '../api';
import { Avatar } from '../avatar';
import type { Route } from './+types/user';
import { Button } from '@/components/ui/button';
import { Eyebrow, Hint, Panel } from '../ui';

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
    <div className="mb-8 flex items-center justify-between gap-6">
      <div className="min-w-0">
        <Eyebrow>{profile.self ? 'Your account' : 'Member'}</Eyebrow>
        <div className="flex items-center gap-[.9rem]">
          <Avatar name={profile.name} hash={profile.avatarHash} size={56} />
          <h1>{profile.name}</h1>
        </div>
      </div>
      {profile.self && <Button render={<Link to="/settings" />}>Settings</Button>}
    </div>
    <Panel>
      <dl className="grid grid-cols-[11rem_1fr] gap-[.8rem] text-[.9rem] [&_dd]:m-0 [&_dt]:text-muted-foreground">
        <dt>Assets reported</dt>
        <dd>{profile.reportedAssets}</dd>
      </dl>
      <Hint className="mt-4">{profile.self
        ? 'Counted across everything you can read.'
        : 'Counted across what you can read. Assets in Groups you do not belong to are not included.'}</Hint>
    </Panel>
  </>;
}
export { WorkspaceError as ErrorBoundary } from '../route-error';
