import { useId } from 'react';
import type { ColorScheme } from '../shared/appearance';
import type { ThemeId } from '../shared/theme';
import { ThemePreview } from './theme-preview';
import { builtInThemes } from './themes';
import { Hint } from './ui';

/** A card whose selected state is carried by the radio inside it, so the
 * control and its presentation cannot disagree. */
const card = 'relative m-0 grid cursor-pointer gap-[.55rem] rounded-lg border bg-card p-[.6rem]'
  + ' hover:bg-accent has-[input:checked]:border-selected-indicator'
  + ' has-[input:checked]:shadow-[0_0_0_2px_var(--kannabi-selected-surface)]'
  + ' has-[input:focus-visible]:outline-3 has-[input:focus-visible]:outline-offset-2'
  + ' has-[input:focus-visible]:outline-focus';

export function ThemeSelector({ name, value, previewMode, disabled = false, onChange, onPreviewModeChange }: {
  name: string; value: ThemeId; previewMode: ColorScheme; disabled?: boolean;
  onChange?(value: ThemeId): void; onPreviewModeChange?(value: ColorScheme): void;
}) {
  const id = useId();
  return <fieldset className="mb-6">
    <legend className="mb-3 text-[.9rem] font-[550]">Theme</legend>
    <Hint className="mb-3 text-[.78rem]">Choose an instance-wide theme. Preview its Light and Dark
      variants without changing your Profile appearance.</Hint>
    <fieldset className="mb-[.8rem]"><legend className="sr-only">Preview mode</legend>
      <div className="flex items-center gap-[.65rem] text-[.72rem] font-semibold text-muted-foreground">
        <span aria-hidden="true">Preview mode</span>
        <div className="inline-flex rounded-lg border bg-muted p-[.2rem]">
          {(['light', 'dark'] as const).map((mode) => <label key={mode} className="relative m-0 block">
            <input type="radio" name={`${id}-preview-mode`} value={mode} checked={previewMode === mode}
              className="peer absolute size-px overflow-hidden opacity-0"
              onChange={() => onPreviewModeChange?.(mode)} />
            <span className="block cursor-pointer rounded px-[.65rem] py-[.35rem] text-[.75rem] font-semibold text-muted-foreground peer-checked:bg-selected-surface peer-checked:text-selected-text peer-focus-visible:outline-3 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus">
              {mode[0].toUpperCase() + mode.slice(1)}</span>
          </label>)}
        </div>
      </div>
    </fieldset>
    <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-3 max-sm:grid-cols-2">
      {builtInThemes.map((theme) => <label className={card} key={theme.id}>
        <input className="absolute size-px overflow-hidden opacity-0 [&:checked~[data-slot=selected]]:grid"
          type="radio" name={name} value={theme.id} checked={value === theme.id}
          disabled={disabled} onChange={() => onChange?.(theme.id)} required />
        <ThemePreview palette={theme[previewMode]} />
        <span className="text-[.78rem] font-semibold text-foreground">{theme.label}</span>
        <span data-slot="selected" aria-hidden="true"
          className="absolute top-[.35rem] right-[.35rem] hidden size-[1.15rem] place-items-center rounded-full bg-primary text-[.72rem] leading-none text-primary-foreground">✓</span>
      </label>)}
    </div>
  </fieldset>;
}
