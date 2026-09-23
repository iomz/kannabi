import { Link, useLocation, useSubmit } from 'react-router';
import { Icon, type IconName } from './icon';
import { Avatar } from './avatar';
import { displayVersion, kannabiVersion } from './version';
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubButton,
  SidebarMenuSubItem, SidebarRail, useSidebar,
} from '@/components/ui/sidebar';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
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

type Destination = { to: string; icon: IconName; label: string };

/** Inventory is the category; Assets is the surface it currently has.
 *
 * Keeping the two apart is what lets the next inventory surface — identifier
 * management, say — arrive underneath Inventory rather than forcing the
 * navigation to be reorganised around it. Inventory is therefore not a
 * destination of its own: there is nothing at the category, only inside it.
 */
const inventory: { label: string; icon: IconName; to: string; items: readonly Destination[] } = {
  // The category leads to its default surface. That is a convenience, not an
  // equivalence: Inventory is where the surfaces live, and Assets is the one
  // it opens today.
  label: 'Inventory', icon: 'assets', to: '/',
  items: [{ to: '/', icon: 'assets', label: 'Assets' }],
};

const workspace: readonly Destination[] = [
  { to: '/lookup', icon: 'search', label: 'Lookup' },
  { to: '/groups', icon: 'groups', label: 'Groups' },
];

const administration: readonly Destination[] = [
  { to: '/admin/members', icon: 'members', label: 'Members' },
  { to: '/admin/settings', icon: 'settings', label: 'Instance settings' },
];

/** Selection is a state of the navigation, not a link colour.
 *
 * A navigation item takes the chrome foreground like everything else in the
 * sidebar; what marks the current one is the selected surface and the rule
 * down its leading edge, which is how it read before this became a component.
 */
const selected = 'data-active:bg-sidebar-primary data-active:text-sidebar-primary-foreground'
  + ' data-active:font-[650] data-active:shadow-[inset_3px_0_var(--kannabi-selected-indicator)]';

function Destination({ item, active, close }: {
  item: Destination; active: string | null; close: () => void;
}) {
  // The label is also the collapsed tooltip, so nothing becomes unreachable or
  // unnameable when the navigation is narrowed.
  return <SidebarMenuItem>
    <SidebarMenuButton isActive={active === item.to} tooltip={item.label} className={selected}
      render={<Link to={item.to} aria-current={active === item.to ? 'page' : undefined}
        onClick={close} />}>
      <Icon name={item.icon} /><span>{item.label}</span>
    </SidebarMenuButton>
  </SidebarMenuItem>;
}

function Workspace({ active }: { active: string | null }) {
  const { setOpenMobile, state } = useSidebar();
  const close = () => setOpenMobile(false);
  // Narrowed to icons, the sidebar is a column of destinations and a category
  // has nothing to show in it. Its surfaces stand in its place rather than
  // going with it.
  const narrowed = state === 'collapsed';
  return <SidebarGroup>
    <SidebarGroupLabel>Workspace</SidebarGroupLabel>
    <SidebarMenu>
      {narrowed
        ? inventory.items.map((item) => <Destination key={item.to} item={item} active={active} close={close} />)
        : <SidebarMenuItem>
          {/* Selection stays on the surface rather than being shown twice, so
              arriving through the category still says which surface is open. */}
          <SidebarMenuButton render={<Link to={inventory.to} onClick={close} />}>
            <Icon name={inventory.icon} /><span>{inventory.label}</span>
          </SidebarMenuButton>
          <SidebarMenuSub>
            {inventory.items.map((item) => <SidebarMenuSubItem key={item.to}>
              <SidebarMenuSubButton isActive={active === item.to} className={selected}
                render={<Link to={item.to} aria-current={active === item.to ? 'page' : undefined}
                  onClick={close} />}>
                <span>{item.label}</span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>)}
          </SidebarMenuSub>
        </SidebarMenuItem>}
      {workspace.map((item) => <Destination key={item.to} item={item} active={active} close={close} />)}
    </SidebarMenu>
  </SidebarGroup>;
}

function Administration({ active }: { active: string | null }) {
  const { setOpenMobile } = useSidebar();
  const close = () => setOpenMobile(false);
  return <SidebarGroup>
    <SidebarGroupLabel>Administration</SidebarGroupLabel>
    <SidebarMenu>
      {administration.map((item) => <Destination key={item.to} item={item} active={active} close={close} />)}
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
function Account({ user, avatarHash, busy }: {
  user: ShellUser; avatarHash?: string | null; busy: boolean;
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
    <DropdownMenuContent side="top" align="start" sideOffset={8} className="min-w-52">
      {/* Straight into what can be done. The row that opened this menu is the
          account, still visible underneath it, so repeating the name, the
          address and the role here would say nothing the person did not just
          click on. */}
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
      <Workspace active={active} />
      {isAdmin && <Administration active={active} />}
    </SidebarContent>
    <SidebarFooter>
      <SidebarMenu>
        <SidebarMenuItem>
          {user
            ? <Account user={user} avatarHash={avatarHash} busy={busy} />
            : location.pathname !== '/signin'
              ? <SidebarMenuButton size="lg" tooltip="Sign in" render={<Link to="/signin" />}>
                <span>Sign in</span></SidebarMenuButton>
              : null}
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
    {/* The boundary affordance stays on the sidebar's own edge. Upstream
        straddles the border, which puts a full-height strip on top of the
        workspace — over the header's left edge and every row beneath it. */}
    <SidebarRail className="translate-x-0 group-data-[side=left]:right-0 after:start-auto after:end-0" />
  </Sidebar>;
}
