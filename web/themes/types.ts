import type { ThemeId } from '../../shared/theme';

export type ThemePalette = {
  canvas: string;
  surface: string;
  surfaceMuted: string;
  surfaceHover: string;
  border: string;
  controlBorder: string;
  text: string;
  textMuted: string;
  chrome: string;
  chromeHover: string;
  chromeText: string;
  chromeMuted: string;
  brandMark: string;
  brand: string;
  brandSoft: string;
  brandText: string;
  link: string;
  linkHover: string;
  focus: string;
  action: string;
  actionHover: string;
  actionText: string;
  selectedSurface: string;
  selectedText: string;
  selectedIndicator: string;
  successSurface: string;
  successText: string;
  warningSurface: string;
  warningText: string;
  warningBorder: string;
  dangerSurface: string;
  dangerText: string;
};

export type ThemeDefinition = {
  id: ThemeId;
  label: string;
  light: ThemePalette;
  dark: ThemePalette;
};
