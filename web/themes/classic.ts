import type { ThemeDefinition } from './types';

export const classicTheme = {
  id: 'classic',
  label: 'Classic',
  light: {
    canvas: '#f4f5f7', surface: '#ffffff', surfaceMuted: '#e9edf1', surfaceHover: '#f2f4f6',
    border: '#d3d9df', controlBorder: '#82909e', text: '#29343f', textMuted: '#596775',
    chrome: '#29384a', chromeHover: '#3c5066', chromeText: '#f2f5f8', chromeMuted: '#bbc6d1', brandMark: '#4f91c2',
    brand: '#3676a8', brandSoft: '#dce8f1', brandText: '#285779',
    link: '#285f8a', linkHover: '#1c486b', focus: '#285f8a',
    action: '#2f5f87', actionHover: '#244966', actionText: '#ffffff',
    selectedSurface: '#dce8f1', selectedText: '#244f70', selectedIndicator: '#3676a8',
    successSurface: '#e2eee5', successText: '#2d613d', warningSurface: '#fff4d6', warningText: '#6b4e00', warningBorder: '#b7791f',
    dangerSurface: '#f4e2e1', dangerText: '#84302d',
  },
  dark: {
    canvas: '#171b20', surface: '#20262d', surfaceMuted: '#2a323c', surfaceHover: '#333d48',
    border: '#424e5b', controlBorder: '#718091', text: '#edf1f5', textMuted: '#b7c1cc',
    chrome: '#111820', chromeHover: '#273544', chromeText: '#f3f6f9', chromeMuted: '#afbdca', brandMark: '#69a7d5',
    brand: '#69a7d5', brandSoft: '#213b51', brandText: '#badcf3',
    link: '#84bce2', linkHover: '#aed5ef', focus: '#7db7df',
    action: '#3c7098', actionHover: '#346588', actionText: '#ffffff',
    selectedSurface: '#28445a', selectedText: '#d6eaf7', selectedIndicator: '#69a7d5',
    successSurface: '#203a2a', successText: '#a8dcba', warningSurface: '#3d3215', warningText: '#f4d78c', warningBorder: '#d69e2e',
    dangerSurface: '#482422', dangerText: '#ffbfba',
  },
} satisfies ThemeDefinition;
