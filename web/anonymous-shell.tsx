import { Link, Outlet } from 'react-router';
import type { ColorScheme } from '../shared/appearance';
import type { ThemeId } from '../shared/theme';

export const anonymousShellHandle = { shell: 'anonymous' } as const;
export const publicShellHandle = { shell: 'public' } as const;

export function isAnonymousShellHandle(handle: unknown): boolean {
  return typeof handle === 'object' && handle !== null && 'shell' in handle
    && handle.shell === anonymousShellHandle.shell;
}

export function isPublicShellHandle(handle: unknown): boolean {
  return typeof handle === 'object' && handle !== null && 'shell' in handle
    && handle.shell === publicShellHandle.shell;
}

/** Whether a route is a workspace page, and therefore whether the Asset-search
 * bar belongs above it.
 *
 * Settings and Administration are management contexts: looking an Asset up is
 * not what somebody is there to do, and a search toolbar over them reads as
 * leftover workspace chrome. The shortcut follows the field rather than being
 * duplicated into a hidden input, so it simply has nothing to focus here.
 */
export function usesWorkspaceHeader(pathname: string): boolean {
  return !(pathname === '/settings' || pathname.startsWith('/settings/')
    || pathname === '/admin' || pathname.startsWith('/admin/'));
}

export function usesAnonymousShell(handles: unknown[], authenticated: boolean): boolean {
  return handles.some(isAnonymousShellHandle)
    || (!authenticated && handles.some(isPublicShellHandle));
}

export function AnonymousShell({ themeId, colorScheme, busy, error, publicContent = false }: {
  themeId: ThemeId; colorScheme: ColorScheme; busy: boolean; error?: string; publicContent?: boolean;
}) {
  return <div className="auth-shell min-h-dvh bg-background text-foreground"
    data-theme={themeId} data-color-scheme={colorScheme}>
    <a href="#workspace" className="fixed left-4 top-[-5rem] z-30 rounded-md bg-card px-3 py-2 text-foreground shadow-md focus:top-4">Skip to content</a>
    <main id="workspace" tabIndex={-1} aria-busy={busy}
      className="grid min-h-dvh w-full place-items-center px-6 py-12 focus:outline-none max-sm:place-items-start max-sm:px-4 max-sm:pt-8 max-sm:pb-12">
      <div className={publicContent ? 'w-[min(100%,64rem)]' : 'w-[min(100%,27rem)]'}>
        <Link to="/signin" aria-label="Kannabi sign in"
          className="mb-10 flex items-center justify-center gap-3 text-[1.3rem] font-[650] tracking-[-.03em] text-foreground max-sm:mb-8 max-sm:text-[1.1rem]">
          <svg viewBox="0 0 32 32" width="32" height="32" aria-hidden="true" className="shrink-0 text-brand max-sm:w-7"><path d="M5 27V9h6v18M21 27V9h6v18M11 5h10v6H11z" fill="currentColor" /></svg>
          <span>Kannabi<small className="mt-[.2rem] block text-[.67rem] font-normal tracking-[.035em] text-muted-foreground">Identity &amp; inventory</small></span>
        </Link>
        {error && <p role="alert">{error}</p>}<Outlet />
      </div>
    </main>
  </div>;
}
