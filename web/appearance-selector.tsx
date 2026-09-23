import { useEffect, useRef, useState } from 'react';
import { useFetcher } from 'react-router';
import { appearancePreferences, type AppearancePreference } from '../shared/appearance';
import { ThemePreview } from './theme-preview';
import type { ThemeDefinition } from './themes/types';
import { useResolvedAppearance } from './appearance';
import { useThemeRuntime } from './theme-runtime';
import { Hint } from './ui';

/** Same card as the theme grid: the radio inside carries the selected state,
 * so the control and its presentation cannot disagree. */
const choice = 'relative m-0 grid cursor-pointer gap-[.55rem] rounded-lg border bg-card p-[.7rem]'
  + ' hover:bg-accent has-[input:checked]:border-selected-indicator'
  + ' has-[input:checked]:shadow-[0_0_0_2px_var(--kannabi-selected-surface)]'
  + ' has-[input:focus-visible]:outline-3 has-[input:focus-visible]:outline-offset-2'
  + ' has-[input:focus-visible]:outline-focus';

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

  return <fetcher.Form method="post"><fieldset disabled={fetcher.state !== 'idle'} aria-busy={fetcher.state !== 'idle'}>
    <input type="hidden" name="intent" value="appearance" />
    <legend className="mb-[.45rem] text-[1.05rem] font-[650]">Appearance</legend>
    <Hint className="mb-4">Choose how {theme.label} appears for your account.</Hint>
    {fetcher.data?.error && <p role="alert">{fetcher.data.error}</p>}
    <div className="mb-4 grid grid-cols-3 gap-3 max-sm:grid-cols-1">
      {appearancePreferences.map((preference) => {
        const scheme = preference === 'system' ? systemScheme : preference;
        return <label className={choice} key={preference}>
          <input type="radio" name="appearance" value={preference} checked={selected === preference}
            className="absolute size-px overflow-hidden opacity-0 [&:checked~[data-slot=selected]]:grid"
            onChange={() => select(preference)} required />
          <ThemePreview palette={theme[scheme]} />
          <span className="grid gap-[.15rem]">
            <strong className="text-[.85rem] text-foreground">{preference[0].toUpperCase() + preference.slice(1)}</strong>
            <small className="text-[.72rem] font-normal text-muted-foreground">{descriptions[preference]}{preference === 'system' ? ` · currently ${systemScheme}` : ''}</small>
          </span>
          <span data-slot="selected" aria-hidden="true"
            className="absolute top-[.4rem] right-[.4rem] hidden size-[1.15rem] place-items-center rounded-full bg-primary text-[.72rem] leading-none text-primary-foreground">✓</span>
        </label>;
      })}
    </div>
    {fetcher.state !== 'idle' && <Hint role="status">Saving appearance…</Hint>}
  </fieldset></fetcher.Form>;
}
