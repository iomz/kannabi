import { useEffect, useRef, useState } from 'react';
import { useFetcher } from 'react-router';
import { appearancePreferences, type AppearancePreference } from '../shared/appearance';
import { ThemePreview } from './theme-preview';
import type { ThemeDefinition } from './themes/types';
import { useResolvedAppearance } from './appearance';
import { useThemeRuntime } from './theme-runtime';

const descriptions: Record<AppearancePreference, string> = {
  system: 'Follow this device',
  light: 'Always use light',
  dark: 'Always use dark',
};

export function AppearanceSelector({ value, theme }: { value: AppearancePreference; theme: ThemeDefinition }) {
  const fetcher = useFetcher<{ saved: boolean; error: string | null; appearance?: AppearancePreference }>();
  const { setAppearance } = useThemeRuntime();
  const persisted = useRef(value);
  const previous = useRef(value);
  const [selected, setSelected] = useState(value);
  const systemScheme = useResolvedAppearance('system');
  useEffect(() => {
    if (fetcher.state !== 'idle') return;
    persisted.current = value;
    setSelected(value);
  }, [value, fetcher.state]);
  useEffect(() => {
    if (fetcher.state !== 'idle' || !fetcher.data) return;
    if (fetcher.data.saved && fetcher.data.appearance) {
      persisted.current = fetcher.data.appearance;
      setSelected(fetcher.data.appearance);
    }
    if (!fetcher.data.saved) {
      persisted.current = previous.current;
      setSelected(previous.current);
      setAppearance(previous.current);
    }
  }, [fetcher.data, fetcher.state, setAppearance]);

  function select(preference: AppearancePreference) {
    previous.current = persisted.current;
    setSelected(preference);
    setAppearance(preference);
    // The submission belongs to whichever route renders this selector, so it
    // names no route of its own. Naming one is how this came to post at a
    // route that no longer answers, and the local `setAppearance` above hid
    // the failure by applying the choice anyway.
    void fetcher.submit({ intent: 'appearance', appearance: preference }, { method: 'post' });
  }

  return <fetcher.Form method="post"><fieldset className="appearance-selector" disabled={fetcher.state !== 'idle'} aria-busy={fetcher.state !== 'idle'}>
    <input type="hidden" name="intent" value="appearance" />
    <legend>Appearance</legend>
    <p className="hint">Choose how {theme.label} appears for your account.</p>
    {fetcher.data?.error && <p role="alert">{fetcher.data.error}</p>}
    <div className="appearance-grid">
      {appearancePreferences.map((preference) => {
        const scheme = preference === 'system' ? systemScheme : preference;
        return <label className="appearance-choice" key={preference}>
          <input type="radio" name="appearance" value={preference} checked={selected === preference}
            onChange={() => select(preference)} required />
          <ThemePreview palette={theme[scheme]} />
          <span className="appearance-choice-copy">
            <strong>{preference[0].toUpperCase() + preference.slice(1)}</strong>
            <small>{descriptions[preference]}{preference === 'system' ? ` · currently ${systemScheme}` : ''}</small>
          </span>
          <span className="appearance-choice-selected" aria-hidden="true">✓</span>
        </label>;
      })}
    </div>
    {fetcher.state !== 'idle' && <p role="status" className="hint">Saving appearance…</p>}
  </fieldset></fetcher.Form>;
}
