import type { ThemePalette } from './themes/types';
import { paletteVariables } from './themes/variables';

/** A theme, shown rather than named.
 *
 * The palette is applied to this element as its own variables, so the preview
 * is drawn in the theme it depicts without that theme being applied to the
 * page. Every colour below therefore comes from the palette passed in, not
 * from whichever theme is currently in use.
 */
export function ThemePreview({ palette }: { palette: ThemePalette }) {
  return <span aria-hidden="true" style={paletteVariables(palette)}
    className="grid h-[4.8rem] grid-cols-[1.5rem_minmax(0,1fr)] overflow-hidden rounded border border-[var(--kannabi-border)] bg-[var(--kannabi-canvas)]">
    <span className="flex flex-col items-center gap-[.35rem] bg-[var(--kannabi-chrome)] px-1 py-[.55rem] [&>span]:h-[.12rem] [&>span]:w-[.7rem] [&>span]:rounded-full [&>span]:bg-[var(--kannabi-chrome-muted)]">
      <span className="mb-[.15rem] !size-[.55rem] !rounded-[.15rem] !bg-[var(--kannabi-brand-mark)]" /><span /><span />
    </span>
    <span className="bg-[var(--kannabi-canvas)] p-[.45rem]">
      <span className="block h-full rounded-sm border border-[var(--kannabi-border)] bg-[var(--kannabi-surface)] p-[.45rem]">
        <span className="mb-[.28rem] block h-[.13rem] w-[72%] rounded-full bg-[var(--kannabi-text-muted)]" />
        <span className="mb-[.28rem] block h-[.13rem] w-[48%] rounded-full bg-[var(--kannabi-text-muted)]" />
        <i className="mt-[.45rem] block h-1 w-[58%] rounded-full bg-[var(--kannabi-brand)]" />
        <b className="mt-[.4rem] block h-[.65rem] w-[42%] rounded-[.2rem] bg-[var(--kannabi-action)]" />
      </span>
    </span>
  </span>;
}
