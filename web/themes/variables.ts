import type { CSSProperties } from 'react';
import type { ThemeDefinition, ThemePalette } from './types';

export function paletteVariableEntries(palette: ThemePalette): [string, string][] {
  return Object.entries({
    '--kannabi-canvas': palette.canvas,
    '--kannabi-surface': palette.surface,
    '--kannabi-surface-muted': palette.surfaceMuted,
    '--kannabi-surface-hover': palette.surfaceHover,
    '--kannabi-border': palette.border,
    '--kannabi-control-border': palette.controlBorder,
    '--kannabi-text': palette.text,
    '--kannabi-text-muted': palette.textMuted,
    '--kannabi-chrome': palette.chrome,
    '--kannabi-chrome-hover': palette.chromeHover,
    '--kannabi-chrome-text': palette.chromeText,
    '--kannabi-chrome-muted': palette.chromeMuted,
    '--kannabi-brand-mark': palette.brandMark,
    '--kannabi-brand': palette.brand,
    '--kannabi-brand-soft': palette.brandSoft,
    '--kannabi-brand-text': palette.brandText,
    '--kannabi-link': palette.link,
    '--kannabi-link-hover': palette.linkHover,
    '--kannabi-focus': palette.focus,
    '--kannabi-action': palette.action,
    '--kannabi-action-hover': palette.actionHover,
    '--kannabi-action-text': palette.actionText,
    '--kannabi-selected-surface': palette.selectedSurface,
    '--kannabi-selected-text': palette.selectedText,
    '--kannabi-selected-indicator': palette.selectedIndicator,
    '--kannabi-success-surface': palette.successSurface,
    '--kannabi-success-text': palette.successText,
    '--kannabi-warning-surface': palette.warningSurface,
    '--kannabi-warning-text': palette.warningText,
    '--kannabi-warning-border': palette.warningBorder,
    '--kannabi-danger-surface': palette.dangerSurface,
    '--kannabi-danger-text': palette.dangerText,
  });
}

export function paletteVariables(palette: ThemePalette): CSSProperties {
  return Object.fromEntries(paletteVariableEntries(palette)) as CSSProperties;
}

/** The palette, as CSS, for every theme and both colour schemes at once.
 *
 * The whole set ships in one stylesheet so switching theme or colour scheme is
 * a change of attribute rather than a fetch, and so the choice survives the
 * first paint. `.app-shell` carries the attributes during server rendering,
 * before the boot script has set them on the document.
 */
export function themeStylesheet(themes: readonly ThemeDefinition[]): string {
  return themes.flatMap((theme) => (['light', 'dark'] as const).map((mode) => {
    const declarations = paletteVariableEntries(theme[mode]).map(([name, value]) => `${name}:${value}`).join(';');
    const selector = `[data-theme="${theme.id}"][data-color-scheme="${mode}"]`;
    return `:root${selector},.app-shell${selector},.auth-shell${selector}{color-scheme:${mode};${declarations}}`;
  })).join('');
}
