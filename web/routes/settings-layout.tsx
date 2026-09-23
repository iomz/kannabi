import { NavLink, Outlet, redirect } from 'react-router';
import { api, unwrap } from '../api';
import { Icon } from '../icon';
import { PageHeading } from '../ui';

const section = 'inline-flex items-center gap-[.45rem] border-b-2 px-[.85rem] py-[.6rem] text-[.9rem]'
  + ' text-muted-foreground hover:text-foreground aria-[current=page]:border-selected-indicator'
  + ' aria-[current=page]:font-semibold aria-[current=page]:text-foreground [&_.icon]:size-4';

export async function clientLoader() {
  const { user } = await unwrap(await api.me.$get());
  if (!user) throw redirect('/signin');
  return { name: user.name };
}

/** User settings, separated by concern.
 *
 * Profile answers who the account is, Appearance how it looks, and Security
 * which credentials can act as it. They are distinct enough that a person
 * looking for one should not have to scroll past the others.
 */
export default function SettingsLayout() {
  return <>
    <PageHeading eyebrow="Account" title="Settings" />
    <nav aria-label="Settings sections" className="mb-7 flex flex-wrap gap-[.4rem] border-b">
      <NavLink to="/settings" end className={section}><Icon name="user" />Profile</NavLink>
      <NavLink to="/settings/appearance" className={section}><Icon name="photo" />Appearance</NavLink>
      <NavLink to="/settings/security" className={section}><Icon name="lock" />Security</NavLink>
    </nav>
    <Outlet />
  </>;
}
export { WorkspaceError as ErrorBoundary } from '../route-error';
