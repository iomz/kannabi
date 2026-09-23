import type { ThemeDefinition } from './types';

export const christmasTheme = {
  id: 'christmas',
  label: 'Christmas',
  light: {
    canvas: '#faf7ef', surface: '#fffdfa', surfaceMuted: '#f1ece1', surfaceHover: '#f8f3e9',
    border: '#ddd5c5', controlBorder: '#938675', text: '#34352f', textMuted: '#606459',
    chrome: '#17452f', chromeHover: '#246344', chromeText: '#f3faf5', chromeMuted: '#b6d2c0', brandMark: '#d6b85c',
    brand: '#bd3434', brandSoft: '#f3dede', brandText: '#7d2525',
    link: '#1e6541', linkHover: '#154b30', focus: '#9d2d2d',
    action: '#20643f', actionHover: '#174c30', actionText: '#ffffff',
    selectedSurface: '#f1dddd', selectedText: '#762424', selectedIndicator: '#bd3434',
    successSurface: '#e1eee4', successText: '#2b613c', warningSurface: '#fff4d6', warningText: '#6b4e00', warningBorder: '#b7791f',
    dangerSurface: '#f3dede', dangerText: '#7d2525',
  },
  dark: {
    canvas: '#121a15', surface: '#1a251e', surfaceMuted: '#243129', surfaceHover: '#2c3c32',
    border: '#3b5042', controlBorder: '#6b8875', text: '#eef5f0', textMuted: '#b7c8bc',
    chrome: '#0a2416', chromeHover: '#183b27', chromeText: '#f2faf4', chromeMuted: '#a9c8b3', brandMark: '#e1c365',
    brand: '#e15a5a', brandSoft: '#4a2426', brandText: '#ffc2c2',
    link: '#78d39b', linkHover: '#a4e4bc', focus: '#ef7373',
    action: '#287a4a', actionHover: '#226b41', actionText: '#ffffff',
    selectedSurface: '#51282a', selectedText: '#ffd1d1', selectedIndicator: '#e15a5a',
    successSurface: '#1d3d2a', successText: '#a5dfb8', warningSurface: '#3d3215', warningText: '#f4d78c', warningBorder: '#d69e2e',
    dangerSurface: '#4b2526', dangerText: '#ffc0c0',
  },
} satisfies ThemeDefinition;
