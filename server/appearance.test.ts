import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appearancePreferences, isAppearancePreference, resolveAppearance } from '../shared/appearance.js';
import { cacheSidebarCollapsed, observeSystemColorScheme, readSidebarCollapsed,
  themeBootScript } from '../web/appearance.js';

test('appearance values and explicit resolution stay narrow', () => {
  assert.deepEqual(appearancePreferences, ['system', 'light', 'dark']);
  for (const value of appearancePreferences) assert.equal(isAppearancePreference(value), true);
  for (const value of ['', 'auto', 'default', null]) assert.equal(isAppearancePreference(value), false);
  assert.equal(resolveAppearance('light', true), 'light');
  assert.equal(resolveAppearance('dark', false), 'dark');
  assert.equal(resolveAppearance('system', false), 'light');
  assert.equal(resolveAppearance('system', true), 'dark');
});

test('System follows live media-query changes', () => {
  let changed: (() => void) | null = null;
  const query = {
    matches: false,
    addEventListener: (_type: string, listener: () => void) => { changed = listener; },
    removeEventListener: (_type: string, listener: () => void) => { if (changed === listener) changed = null; },
  };
  const schemes: string[] = [];
  const stop = observeSystemColorScheme(query as unknown as Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>,
    (scheme) => schemes.push(scheme));
  query.matches = true;
  changed!();
  query.matches = false;
  changed!();
  assert.deepEqual(schemes, ['dark', 'light']);
  stop();
  assert.equal(changed, null);
});

test('pre-hydration bootstrap never consumes a cached User appearance', () => {
  const script = themeBootScript();
  assert.doesNotMatch(script, /appearance|user/i);
  assert.match(script, /prefers-color-scheme: dark/);
  assert.match(script, /kannabi\.instance-theme/);
  // Navigation width decides layout, so it is resolved with the theme rather
  // than after hydration, and it fails open to the expanded navigation.
  assert.match(script, /kannabi\.sidebar-collapsed/);
  assert.match(script, /dataset\.sidebar='collapsed'/);
});

test('sidebar width is a per-device preference and never account state', () => {
  const store = new Map<string, string>();
  const original = globalThis.window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    } },
  });
  try {
    // Absent means expanded: a person who has never chosen sees full navigation.
    assert.equal(readSidebarCollapsed(), false);
    cacheSidebarCollapsed(true);
    assert.equal(readSidebarCollapsed(), true);
    cacheSidebarCollapsed(false);
    assert.equal(readSidebarCollapsed(), false);
    // Only the layout hint is stored, and nothing identifying.
    assert.deepEqual([...store.keys()], ['kannabi.sidebar-collapsed']);
  } finally {
    if (original === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: original });
  }
});

test('unavailable storage leaves navigation expanded rather than failing', () => {
  const original = globalThis.window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { get localStorage(): Storage { throw new Error('blocked'); } },
  });
  try {
    assert.equal(readSidebarCollapsed(), false);
    assert.doesNotThrow(() => cacheSidebarCollapsed(true));
  } finally {
    if (original === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: original });
  }
});
