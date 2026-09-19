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

export function usesAnonymousShell(handles: unknown[], authenticated: boolean): boolean {
  return handles.some(isAnonymousShellHandle)
    || (!authenticated && handles.some(isPublicShellHandle));
}

export function AnonymousShell({ themeId, colorScheme, busy, error, publicContent = false }: {
  themeId: ThemeId; colorScheme: ColorScheme; busy: boolean; error?: string; publicContent?: boolean;
}) {
  return <div className="auth-shell" data-theme={themeId} data-color-scheme={colorScheme}>
    <a className="skip-link" href="#workspace">Skip to content</a>
    <main id="workspace" tabIndex={-1} className="auth-main" aria-busy={busy}>
      <div className={'auth-composition' + (publicContent ? ' public-content' : '')}>
        <Link to="/signin" className="auth-brand" aria-label="Kannabi sign in">
          <svg viewBox="0 0 32 32" width="32" height="32" aria-hidden="true"><path d="M5 27V9h6v18M21 27V9h6v18M11 5h10v6H11z" fill="currentColor" /></svg>
          <span>Kannabi<small>Identity & inventory</small></span>
        </Link>
        {error && <p role="alert">{error}</p>}<Outlet />
      </div>
    </main>
  </div>;
}
