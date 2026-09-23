import { NavLink, Outlet, redirect } from 'react-router';
import { api, unwrap } from '../api';
import { Icon } from '../icon';

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
    <div className="page-heading"><div><p className="eyebrow">Account</p><h1>Settings</h1></div></div>
    <nav className="settings-nav" aria-label="Settings sections">
      <NavLink to="/settings" end><Icon name="user" />Profile</NavLink>
      <NavLink to="/settings/appearance"><Icon name="photo" />Appearance</NavLink>
      <NavLink to="/settings/security"><Icon name="lock" />Security</NavLink>
    </nav>
    <Outlet />
  </>;
}
export { WorkspaceError as ErrorBoundary } from '../route-error';
