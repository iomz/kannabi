import { Form, Link, Links, Meta, NavLink, Outlet, Scripts, ScrollRestoration, redirect, useLocation, useMatches, useNavigation } from 'react-router';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { api, authClient, unwrap } from './api';
import type { Route } from './+types/root';
import './style.css';
import { Icon } from './icon';
import { builtInThemes, themeById } from './themes';
import { themeStylesheet } from './themes/variables';
import { applyDocumentTheme, cacheInstanceTheme, themeBootScript, useResolvedAppearance } from './appearance';
import { ThemeRuntimeContext } from './theme-runtime';
import { AnonymousShell, isPublicShellHandle, usesAnonymousShell } from './anonymous-shell';

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
  const [themeId, setThemeId] = useState(loaderData.themeId);
  const [appearance, setAppearance] = useState(loaderData.appearance);
  const [colorSchemePreview, setColorSchemePreview] = useState<'light' | 'dark' | null>(null);
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
  useEffect(() => setThemeId(loaderData.themeId), [loaderData.themeId]);
  useEffect(() => setAppearance(loaderData.appearance), [loaderData.appearance]);
  // The inventory owns Asset detail and reporting; Lookup is its own destination.
  const lookupActive = location.pathname === '/lookup';
  const inventoryActive = !lookupActive && (location.pathname === '/'
    || location.pathname.startsWith('/asset/') || location.pathname.startsWith('/assets/'));
  const theme = themeById(themeId);
  const resolvedAppearance = useResolvedAppearance(appearance);
  const colorScheme = colorSchemePreview ?? resolvedAppearance;
  useLayoutEffect(() => applyDocumentTheme(theme.id, colorScheme), [theme.id, colorScheme]);
  useEffect(() => cacheInstanceTheme(theme.id), [theme.id]);
  return <ThemeRuntimeContext.Provider value={{ themeId, setThemeId, appearance, setAppearance,
    colorScheme, setColorSchemePreview }}>
    {anonymousShell ? <AnonymousShell themeId={theme.id} colorScheme={colorScheme} busy={busy}
      error={actionData?.error} publicContent={publicContent} />
      : <div className="app-shell" data-theme={theme.id} data-color-scheme={colorScheme}>
    <a className="skip-link" href="#workspace">Skip to content</a>
    <aside className="sidebar">
      <Link to="/" className="brand" onClick={() => setMenuOpen(false)} aria-label="Kannabi home">
        <svg viewBox="0 0 32 32" width="32" height="32" aria-hidden="true"><path d="M5 27V9h6v18M21 27V9h6v18M11 5h10v6H11z" fill="currentColor" /></svg>
        <span>Kannabi<small>Identity & inventory</small></span>
      </Link>
      <button className="nav-toggle" aria-expanded={menuOpen} aria-controls="primary-navigation" onClick={() => setMenuOpen(!menuOpen)}>Navigation</button>
      <nav id="primary-navigation" aria-label="Primary" className={menuOpen ? 'expanded' : ''} onClick={() => setMenuOpen(false)}>
        <p className="nav-label">Workspace</p>
        {/* Assets groups its two discovery destinations: browsing the inventory
            and resolving a known identity. Reporting stays a page action. */}
        <p className="nav-group"><Icon name="assets" />Assets</p>
        <Link to="/" className={'nav-child' + (inventoryActive ? ' active' : '')}
          aria-current={inventoryActive ? 'page' : undefined}>Inventory</Link>
        <Link to="/lookup" className={'nav-child' + (lookupActive ? ' active' : '')}
          aria-current={lookupActive ? 'page' : undefined}>Lookup</Link>
        <NavLink to="/groups"><Icon name="groups" />Groups</NavLink>
        {isAdmin && <><p className="nav-label admin-label">Administration</p><NavLink to="/admin/members"><Icon name="members" />Members</NavLink><NavLink to="/admin/settings"><Icon name="settings" />Settings</NavLink></>}
      </nav>
      <p className="sidebar-note">A place for things.<br />Context that stays.</p>
    </aside>
    <div className="app-main">
      <header className="global-header">
        <Form action="/" method="get" role="search" className="global-search">
          <input type="hidden" name="scope" value={location.pathname === '/' ? new URLSearchParams(location.search).get('scope') ?? 'all' : 'all'} />
          <label className="sr-only" htmlFor="asset-search">Search Assets by name</label>
          <Icon name="search" /><input ref={search} key={q} id="asset-search" name="q" type="search" placeholder="Search assets by name…" defaultValue={q} maxLength={200} disabled={!user} />
          <button type="button" className="search-shortcut" aria-label="Focus Asset search" aria-keyshortcuts="Meta+K Control+K" disabled={!user} onClick={() => { search.current?.focus(); search.current?.select(); }}><kbd>⌘K</kbd></button>
        </Form>
        {user ? <details className="account-menu" key={location.pathname}>
          <summary aria-label="Account menu"><span className="avatar" aria-hidden="true">{user.name.slice(0, 1).toUpperCase()}</span><span className="account-name">{user.name}</span><span aria-hidden="true">⌄</span></summary>
          <div className="account-popover"><strong>{user.name}</strong><p>{isAdmin ? 'System administrator' : 'Signed in'}</p>
            <Link to="/profile" className="account-profile-link" aria-label="Profile"><span>Profile</span><span aria-hidden="true">›</span></Link>
            <Form method="post" action="/"><button aria-label="Sign out" disabled={busy}>Sign out</button></Form>
          </div>
        </details> : location.pathname !== '/signin' ? <Link to="/signin" className="account-signin">Sign in</Link> : null}
      </header>
      <main id="workspace" tabIndex={-1} className="workspace" aria-busy={busy}>
        {actionData?.error && <p role="alert">{actionData.error}</p>}<Outlet />
      </main>
    </div>
    </div>}
  </ThemeRuntimeContext.Provider>;
}
