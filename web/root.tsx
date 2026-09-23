import { Links, Meta, Outlet, Scripts, ScrollRestoration, redirect, useLocation, useMatches, useNavigation } from 'react-router';
import { useEffect, useLayoutEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { api, authClient, unwrap } from './api';
import type { Route } from './+types/root';
import './style.css';
import { builtInThemes, themeById } from './themes';
import { themeStylesheet } from './themes/variables';
import { applyDocumentTheme, cacheInstanceTheme, cacheSidebarCollapsed, readSidebarCollapsed,
  themeBootScript, useResolvedAppearance } from './appearance';
import { ThemeRuntimeContext } from './theme-runtime';
import { AnonymousShell, isPublicShellHandle, usesAnonymousShell, usesWorkspaceHeader } from './anonymous-shell';
import { AppSidebar } from './app-sidebar';
import { WorkspaceHeader } from './workspace-header';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { Toaster } from '@/components/ui/toast';

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
export function HydrateFallback() {
  return <main className="grid min-h-dvh place-items-center text-sm text-muted-foreground">Loading Kannabi…</main>;
}
export { WorkspaceError as ErrorBoundary } from './route-error';
export default function App({ loaderData, actionData }: Route.ComponentProps) {
  const { user, isAdmin } = loaderData;
  const location = useLocation();
  const matches = useMatches();
  const handles = matches.map((match) => match.handle);
  const publicContent = handles.some(isPublicShellHandle);
  const anonymousShell = usesAnonymousShell(handles, user !== null);
  const busy = useNavigation().state !== 'idle';
  // The navigation width is a per-device viewing preference, so it is read
  // from local storage rather than fetched; reading it in the initializer
  // means the first painted shell is already the right width.
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed);
  const [themeId, setThemeId] = useState(loaderData.themeId);
  const [appearance, setAppearance] = useState(loaderData.appearance);
  const [colorSchemePreview, setColorSchemePreview] = useState<'light' | 'dark' | null>(null);
  useEffect(() => { document.documentElement.dataset.sidebar = collapsed ? 'collapsed' : 'expanded'; }, [collapsed]);
  useEffect(() => setThemeId(loaderData.themeId), [loaderData.themeId]);
  useEffect(() => setAppearance(loaderData.appearance), [loaderData.appearance]);
  const workspaceHeader = usesWorkspaceHeader(location.pathname);
  const theme = themeById(themeId);
  const resolvedAppearance = useResolvedAppearance(appearance);
  const colorScheme = colorSchemePreview ?? resolvedAppearance;
  useLayoutEffect(() => applyDocumentTheme(theme.id, colorScheme), [theme.id, colorScheme]);
  useEffect(() => cacheInstanceTheme(theme.id), [theme.id]);
  // One viewport for the whole application, outside the shell branch, so a
  // message is not lost when the shell it was raised in is swapped out.
  return <ThemeRuntimeContext.Provider value={{ themeId, setThemeId, appearance, setAppearance,
    colorScheme, setColorSchemePreview }}>
    <Toaster timeout={5000}>
    {anonymousShell ? <AnonymousShell themeId={theme.id} colorScheme={colorScheme} busy={busy}
      error={actionData?.error} publicContent={publicContent} />
      : <SidebarProvider open={!collapsed}
        onOpenChange={(open) => { setCollapsed(!open); cacheSidebarCollapsed(!open); }}
        style={{ '--sidebar-width': '15rem', '--sidebar-width-icon': '3.25rem' } as CSSProperties}>
        <a href="#workspace" className="fixed left-4 top-[-5rem] z-30 rounded-md bg-card px-3 py-2 text-foreground shadow-md focus:top-4">Skip to content</a>
        <AppSidebar user={user} isAdmin={isAdmin} avatarHash={loaderData.avatarHash} busy={busy} />
        <SidebarInset className="min-w-0">
          <WorkspaceHeader enabled={user !== null} search={workspaceHeader} />
          <main id="workspace" tabIndex={-1} aria-busy={busy}
            className="mx-auto w-full max-w-[88rem] px-4 pt-8 pb-16 focus:outline-none sm:px-6 lg:px-10">
            {actionData?.error && <p role="alert">{actionData.error}</p>}<Outlet />
          </main>
        </SidebarInset>
    </SidebarProvider>}
    </Toaster>
  </ThemeRuntimeContext.Provider>;
}
