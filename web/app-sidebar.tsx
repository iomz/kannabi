import { Link, useLocation, useSubmit } from 'react-router';
import { Icon, type IconName } from './icon';
import { Avatar } from './avatar';
import { displayVersion, kannabiVersion } from './version';
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarRail, useSidebar,
} from '@/components/ui/sidebar';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export type ShellUser = { key: string; name: string; email: string };

/** Where a destination is considered current.
 *
 * Asset detail and reporting belong to the inventory rather than to Lookup,
 * which is its own destination, so the two are decided together rather than by
 * prefix matching each in isolation.
 */
export function activeDestination(pathname: string): string | null {
  if (pathname === '/lookup') return '/lookup';
  if (pathname === '/' || pathname.startsWith('/asset/') || pathname.startsWith('/assets/')) return '/';
  if (pathname.startsWith('/groups')) return '/groups';
  if (pathname.startsWith('/admin/members')) return '/admin/members';
  if (pathname.startsWith('/admin/settings')) return '/admin/settings';
  return null;
}

const workspace = [
  { to: '/', icon: 'assets', label: 'Inventory' },
  { to: '/lookup', icon: 'search', label: 'Lookup' },
  { to: '/groups', icon: 'groups', label: 'Groups' },
] as const;

const administration = [
  { to: '/admin/members', icon: 'members', label: 'Members' },
  { to: '/admin/settings', icon: 'settings', label: 'Instance settings' },
] as const;

function Destinations({ label, items, active }: {
  label: string;
  items: readonly { to: string; icon: IconName; label: string }[];
  active: string | null;
}) {
  const { setOpenMobile } = useSidebar();
  return <SidebarGroup>
    <SidebarGroupLabel>{label}</SidebarGroupLabel>
    <SidebarMenu>
      {items.map((item) => <SidebarMenuItem key={item.to}>
        {/* The label is also the collapsed tooltip, so nothing becomes
            unreachable or unnameable when the navigation is narrowed. */}
        <SidebarMenuButton isActive={active === item.to} tooltip={item.label}
          render={<Link to={item.to} aria-current={active === item.to ? 'page' : undefined}
            onClick={() => setOpenMobile(false)} />}>
          <Icon name={item.icon} /><span>{item.label}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>)}
    </SidebarMenu>
  </SidebarGroup>;
}

/** The brand, as one object rather than four of similar weight.
 *
 * Mark and wordmark share a baseline row; what Kannabi is and which Kannabi
 * this is sit beneath in descending emphasis. Nothing else competes for the
 * row, which is what previously squeezed the tagline into an ellipsis — the
 * control that narrows the navigation now lives at the boundary instead.
 */
function Brand() {
  const { setOpenMobile } = useSidebar();
  return <SidebarMenu>
    <SidebarMenuItem>
      <SidebarMenuButton size="lg" tooltip="Kannabi home"
        render={<Link to="/" aria-label="Kannabi home" onClick={() => setOpenMobile(false)} />}
        className="h-auto gap-3 py-2 hover:bg-transparent active:bg-transparent">
        <svg viewBox="0 0 32 32" className="size-8! shrink-0 text-brand-mark" aria-hidden="true">
          <path d="M5 27V9h6v18M21 27V9h6v18M11 5h10v6H11z" fill="currentColor" />
        </svg>
        <span className="grid min-w-0 leading-none">
          <span className="truncate text-[1.3rem] font-[650] tracking-[-.03em] leading-[1.1]">Kannabi</span>
          <span className="truncate text-[.67rem] tracking-[.035em] text-sidebar-foreground/60">Identity &amp; inventory</span>
          <span className="truncate text-[.67rem] tracking-[.035em] text-sidebar-foreground/60">{displayVersion(kannabiVersion)}</span>
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  </SidebarMenu>;
}

/** The account, opened over the shell rather than into it.
 *
 * A disclosure here grows the footer and pushes the avatar up the screen as it
 * opens. A menu is anchored instead, so the thing just clicked stays where it
 * was clicked.
 */
function Account({ user, isAdmin, avatarHash, busy }: {
  user: ShellUser; isAdmin: boolean; avatarHash?: string | null; busy: boolean;
}) {
  const { setOpenMobile } = useSidebar();
  const submit = useSubmit();
  const close = () => setOpenMobile(false);
  return <DropdownMenu>
    <DropdownMenuTrigger render={
      <SidebarMenuButton size="lg" aria-label="Account menu" title={user.name}
        className="data-open:bg-sidebar-accent">
        <Avatar name={user.name} hash={avatarHash} />
        <span className="truncate">{user.name}</span>
        <span aria-hidden="true" className="ml-auto text-sidebar-foreground/60">⌄</span>
      </SidebarMenuButton>} />
    <DropdownMenuContent side="top" align="start" sideOffset={8} className="min-w-56">
      <DropdownMenuLabel className="font-normal">
        <span className="block truncate font-medium">{user.name}</span>
        <span className="block truncate text-xs text-muted-foreground">{user.email}</span>
        {isAdmin && <span className="block truncate text-xs text-muted-foreground">System administrator</span>}
      </DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem render={<Link to={`/users/${user.key}`} onClick={close} />}>View profile</DropdownMenuItem>
      <DropdownMenuItem render={<Link to="/settings" onClick={close} />}>Settings</DropdownMenuItem>
      <DropdownMenuSeparator />
      {/* Sign-out is answered by the root route, which is where the session
          is held, rather than by whatever page happens to be open. */}
      <DropdownMenuItem disabled={busy}
        onClick={() => { close(); void submit(null, { method: 'post', action: '/' }); }}>
        Sign out
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}

export function AppSidebar({ user, isAdmin, avatarHash, busy }: {
  user: ShellUser | null; isAdmin: boolean; avatarHash?: string | null; busy: boolean;
}) {
  const location = useLocation();
  const active = activeDestination(location.pathname);
  return <Sidebar collapsible="icon">
    <SidebarHeader><Brand /></SidebarHeader>
    <SidebarContent>
      <Destinations label="Workspace" items={workspace} active={active} />
      {isAdmin && <Destinations label="Administration" items={administration} active={active} />}
    </SidebarContent>
    <SidebarFooter>
      <SidebarMenu>
        <SidebarMenuItem>
          {user
            ? <Account user={user} isAdmin={isAdmin} avatarHash={avatarHash} busy={busy} />
            : location.pathname !== '/signin'
              ? <SidebarMenuButton size="lg" tooltip="Sign in" render={<Link to="/signin" />}>
                <span>Sign in</span></SidebarMenuButton>
              : null}
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
    <SidebarRail />
  </Sidebar>;
}
