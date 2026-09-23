import { Form, Link, Links, Meta, NavLink, Outlet, Scripts, ScrollRestoration, redirect, useLocation, useMatches, useNavigation } from 'react-router';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { api, authClient, unwrap } from './api';
import type { Route } from './+types/root';
import './style.css';
import { Icon } from './icon';
import { builtInThemes, themeById } from './themes';
import { themeStylesheet } from './themes/variables';
import { applyDocumentTheme, cacheInstanceTheme, cacheSidebarCollapsed, readSidebarCollapsed,
  themeBootScript, useResolvedAppearance } from './appearance';
import { ThemeRuntimeContext } from './theme-runtime';
import { AnonymousShell, isPublicShellHandle, usesAnonymousShell, usesWorkspaceHeader } from './anonymous-shell';
import { isApplePlatform, platformHint, searchKeyShortcuts, searchShortcutHint } from './platform';
import { displayVersion, kannabiVersion } from './version';

export async function clientLoader() {
  const [account, { settings }] = await Promise.all([
    unwrap(await api.me.$get()), unwrap(await api.settings.$get()),
  ]);
  return { ...account, themeId: settings.themeId };
}
export async function clientAction() {
  const result = await authClient.signOut();
  if (result.error) return { error: result.error.message ?? 'Sign-out failed' };
  return redirect('/signin');
}
export function Layout({ children }: { children: ReactNode }) {
  return <html lang="en" suppressHydrationWarning><head>
    <meta charSet="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" href="data:," /><title>Kannabi</title><Meta />
    <style id="kannabi-theme-palettes">{themeStylesheet(builtInThemes)}</style>
    <script dangerouslySetInnerHTML={{ __html: themeBootScript() }} /><Links />
  </head><body>{children}<ScrollRestoration /><Scripts /></body></html>;
}
export function HydrateFallback() { return <main className="loading">Loading Kannabi…</main>; }
export { WorkspaceError as ErrorBoundary } from './route-error';
export default function App({ loaderData, actionData }: Route.ComponentProps) {
  const { user, isAdmin } = loaderData;
  const location = useLocation();
  const matches = useMatches();
  const handles = matches.map((match) => match.handle);
  const publicContent = handles.some(isPublicShellHandle);
  const anonymousShell = usesAnonymousShell(handles, user !== null);
  const busy = useNavigation().state !== 'idle';
  const [menuOpen, setMenuOpen] = useState(false);
  // Starts expanded so the first server-rendered markup is the full
  // navigation; the boot script has already set the document attribute, so the
  // visible width is correct before this ever runs.
  const [collapsed, setCollapsed] = useState(false);
  const [themeId, setThemeId] = useState(loaderData.themeId);
  const [appearance, setAppearance] = useState(loaderData.appearance);
  const [colorSchemePreview, setColorSchemePreview] = useState<'light' | 'dark' | null>(null);
  // Starts at the Apple form so the first paint matches the prerendered shell,
  // then corrects itself once there is a platform to read.
  const [applePlatform, setApplePlatform] = useState(true);
  const q = new URLSearchParams(location.search).get('q') ?? '';
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && user) {
        event.preventDefault(); search.current?.focus(); search.current?.select();
      }
      if (event.key === 'Escape' && document.activeElement === search.current) search.current?.blur();
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [user]);
  useEffect(() => setApplePlatform(isApplePlatform(platformHint())), []);
  useEffect(() => setCollapsed(readSidebarCollapsed()), []);
  useEffect(() => { document.documentElement.dataset.sidebar = collapsed ? 'collapsed' : 'expanded'; }, [collapsed]);
  useEffect(() => setThemeId(loaderData.themeId), [loaderData.themeId]);
  useEffect(() => setAppearance(loaderData.appearance), [loaderData.appearance]);
  // The inventory owns Asset detail and reporting; Lookup is its own destination.
  const lookupActive = location.pathname === '/lookup';
  const inventoryActive = !lookupActive && (location.pathname === '/'
    || location.pathname.startsWith('/asset/') || location.pathname.startsWith('/assets/'));
  const settingsActive = location.pathname.startsWith('/settings');
  const workspaceHeader = usesWorkspaceHeader(location.pathname);
  const theme = themeById(themeId);
  const resolvedAppearance = useResolvedAppearance(appearance);
  const colorScheme = colorSchemePreview ?? resolvedAppearance;
  useLayoutEffect(() => applyDocumentTheme(theme.id, colorScheme), [theme.id, colorScheme]);
  useEffect(() => cacheInstanceTheme(theme.id), [theme.id]);
  return <ThemeRuntimeContext.Provider value={{ themeId, setThemeId, appearance, setAppearance,
    colorScheme, setColorSchemePreview }}>
    {anonymousShell ? <AnonymousShell themeId={theme.id} colorScheme={colorScheme} busy={busy}
      error={actionData?.error} publicContent={publicContent} />
      : <div className={'app-shell' + (collapsed ? ' collapsed' : '')} data-theme={theme.id} data-color-scheme={colorScheme}>
    <a className="skip-link" href="#workspace">Skip to content</a>
    <aside className="sidebar">
      <div className="sidebar-head">
        {/* Mark, wordmark, what Kannabi is, and which Kannabi this is: one
            block with a single descending emphasis, rather than four objects
            of similar weight. */}
        <Link to="/" className="brand" onClick={() => setMenuOpen(false)} aria-label="Kannabi home">
          <svg viewBox="0 0 32 32" width="32" height="32" aria-hidden="true"><path d="M5 27V9h6v18M21 27V9h6v18M11 5h10v6H11z" fill="currentColor" /></svg>
          <span className="brand-text">
            <span className="brand-name">Kannabi</span>
            <small className="brand-tagline">Identity &amp; inventory</small>
            <small className="brand-version">{displayVersion(kannabiVersion)}</small>
          </span>
        </Link>
        {/* Width is a viewing preference, so the control sits with the thing it
            resizes rather than in the workspace header. */}
        <button type="button" className="sidebar-collapse" aria-expanded={!collapsed}
          aria-controls="primary-navigation" title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          onClick={() => { const next = !collapsed; setCollapsed(next); cacheSidebarCollapsed(next); }}>
          <Icon name="sidebar" />
        </button>
        <button className="nav-toggle" aria-expanded={menuOpen} aria-controls="primary-navigation" onClick={() => setMenuOpen(!menuOpen)}>Navigation</button>
      </div>
      <nav id="primary-navigation" aria-label="Primary" className={menuOpen ? 'expanded' : ''} onClick={() => setMenuOpen(false)}>
        <p className="nav-label">Workspace</p>
        {/* Assets groups its two discovery destinations: browsing the inventory
            and resolving a known identity. Reporting stays a page action. */}
        <p className="nav-group"><Icon name="assets" /><span>Assets</span></p>
        {/* The children carry their own icons so collapsing the sidebar keeps
            them reachable; the icons stay hidden while the words are visible. */}
        <Link to="/" className={'nav-child' + (inventoryActive ? ' active' : '')}
          aria-current={inventoryActive ? 'page' : undefined} title="Inventory">
          <Icon name="assets" /><span>Inventory</span></Link>
        <Link to="/lookup" className={'nav-child' + (lookupActive ? ' active' : '')}
          aria-current={lookupActive ? 'page' : undefined} title="Lookup">
          <Icon name="search" /><span>Lookup</span></Link>
        <NavLink to="/groups" title="Groups"><Icon name="groups" /><span>Groups</span></NavLink>
        {isAdmin && <><p className="nav-label admin-label">Administration</p>
          <NavLink to="/admin/members" title="Members"><Icon name="members" /><span>Members</span></NavLink>
          <NavLink to="/admin/settings" title="Instance settings"><Icon name="settings" /><span>Instance settings</span></NavLink></>}
      </nav>
      <p className="sidebar-note">A place for things.<br />Context that stays.</p>
      {user ? <details className="account-menu sidebar-account" key={location.pathname}>
        <summary aria-label="Account menu" title={user.name}>
          <span className="avatar" aria-hidden="true">{user.name.slice(0, 1).toUpperCase()}</span>
          <span className="account-name">{user.name}</span><span className="account-caret" aria-hidden="true">⌄</span>
        </summary>
        <div className="account-popover"><strong>{user.name}</strong>
          <p className="account-email">{user.email}</p>
          {isAdmin && <p className="account-role">System administrator</p>}
          <Link to="/settings" className={'account-profile-link' + (settingsActive ? ' active' : '')}
            aria-current={settingsActive ? 'page' : undefined} aria-label="Settings"><span>Settings</span><span aria-hidden="true">›</span></Link>
          <Form method="post" action="/"><button aria-label="Sign out" disabled={busy}>Sign out</button></Form>
        </div>
      </details> : location.pathname !== '/signin'
        ? <Link to="/signin" className="account-signin sidebar-account">Sign in</Link> : null}
    </aside>
    <div className="app-main">
      {workspaceHeader ? <header className="global-header">
        <Form action="/" method="get" role="search" className="global-search">
          <input type="hidden" name="scope" value={location.pathname === '/' ? new URLSearchParams(location.search).get('scope') ?? 'all' : 'all'} />
          <label className="sr-only" htmlFor="asset-search">Search Assets by name</label>
          <Icon name="search" /><input ref={search} key={q} id="asset-search" name="q" type="search" placeholder="Search assets by name…" defaultValue={q} maxLength={200} disabled={!user} />
          <button type="button" className="search-shortcut" aria-label="Focus Asset search" aria-keyshortcuts={searchKeyShortcuts} disabled={!user} onClick={() => { search.current?.focus(); search.current?.select(); }}><kbd>{searchShortcutHint(applePlatform)}</kbd></button>
        </Form>
      </header> : null}
      <main id="workspace" tabIndex={-1} className="workspace" aria-busy={busy}>
        {actionData?.error && <p role="alert">{actionData.error}</p>}<Outlet />
      </main>
    </div>
    </div>}
  </ThemeRuntimeContext.Provider>;
}
