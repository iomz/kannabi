import { useSyncExternalStore } from 'react';
import { resolveAppearance, type AppearancePreference, type ColorScheme } from '../shared/appearance';
import { themeIds, type ThemeId } from '../shared/theme';

const systemQuery = '(prefers-color-scheme: dark)';
const themeHintKey = 'kannabi.instance-theme';
/** Navigation width is a per-device viewing preference, not account state, so
 * it lives beside the theme hint rather than becoming something the server
 * stores about a person. */
const sidebarHintKey = 'kannabi.sidebar-collapsed';
let mediaQuery: MediaQueryList | null = null;

function systemMediaQuery(): MediaQueryList | null {
  if (typeof window === 'undefined') return null;
  mediaQuery ??= window.matchMedia(systemQuery);
  return mediaQuery;
}

export function observeSystemColorScheme(query: Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>,
  listener: (scheme: ColorScheme) => void): () => void {
  const changed = () => listener(resolveAppearance('system', query.matches));
  query.addEventListener('change', changed);
  return () => query.removeEventListener('change', changed);
}

function subscribe(listener: () => void): () => void {
  const query = systemMediaQuery();
  return query ? observeSystemColorScheme(query, listener) : () => {};
}

function systemPrefersDark(): boolean { return systemMediaQuery()?.matches ?? false; }

export function useResolvedAppearance(preference: AppearancePreference): ColorScheme {
  const prefersDark = useSyncExternalStore(subscribe, systemPrefersDark, () => false);
  return resolveAppearance(preference, prefersDark);
}

export function cacheInstanceTheme(themeId: ThemeId): void {
  try { window.localStorage.setItem(themeHintKey, themeId); } catch { /* Rendering hint is optional. */ }
}

export function readSidebarCollapsed(): boolean {
  try { return window.localStorage.getItem(sidebarHintKey) === 'collapsed'; }
  catch { return false; }
}

export function cacheSidebarCollapsed(collapsed: boolean): void {
  try { window.localStorage.setItem(sidebarHintKey, collapsed ? 'collapsed' : 'expanded'); }
  catch { /* Layout preference is optional. */ }
}

export function applyDocumentTheme(themeId: ThemeId, scheme: ColorScheme): void {
  document.documentElement.dataset.theme = themeId;
  document.documentElement.dataset.colorScheme = scheme;
}

export function themeBootScript(): string {
  const ids = JSON.stringify(themeIds);
  // The sidebar width is applied here for the same reason the theme is: it
  // decides layout, so resolving it after hydration would show the wrong one
  // first.
  return `(()=>{let theme='default';try{const value=localStorage.getItem('${themeHintKey}');if(${ids}.includes(value))theme=value}catch{}const scheme=matchMedia('${systemQuery}').matches?'dark':'light';document.documentElement.dataset.theme=theme;document.documentElement.dataset.colorScheme=scheme;try{if(localStorage.getItem('${sidebarHintKey}')==='collapsed')document.documentElement.dataset.sidebar='collapsed'}catch{}})()`;
}
