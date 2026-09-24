import type { ThemeDefinition } from './types';

export const raycastTheme = {
  id: 'raycast',
  label: 'Raycast',
  light: {
    canvas: '#f7f7f7', surface: '#ffffff', surfaceMuted: '#ededed', surfaceHover: '#f3f3f3',
    border: '#d5d5d5', controlBorder: '#858585', text: '#242424', textMuted: '#5f5f5f',
    chrome: '#181818', chromeHover: '#303030', chromeText: '#ffffff', chromeMuted: '#c2c2c2', brandMark: '#ff5a5f',
    brand: '#df4147', brandSoft: '#f9dfe0', brandText: '#91282c',
    link: '#a52d32', linkHover: '#7d2024', focus: '#b93338',
    action: '#272727', actionHover: '#111111', actionText: '#ffffff',
    selectedSurface: '#f7dcdc', selectedText: '#86262a', selectedIndicator: '#df4147',
    successSurface: '#e3eee6', successText: '#2d613d', warningSurface: '#fff4d6', warningText: '#6b4e00', warningBorder: '#b7791f',
    dangerSurface: '#f7dcdc', dangerText: '#86262a',
  },
  dark: {
    canvas: '#111111', surface: '#1c1c1c', surfaceMuted: '#272727', surfaceHover: '#303030',
    border: '#3e3e3e', controlBorder: '#737373', text: '#f4f4f4', textMuted: '#bdbdbd',
    chrome: '#080808', chromeHover: '#242424', chromeText: '#ffffff', chromeMuted: '#b7b7b7', brandMark: '#ff6368',
    brand: '#ff6368', brandSoft: '#4a2225', brandText: '#ffc5c7',
    link: '#ff8589', linkHover: '#ffb0b3', focus: '#ff787d',
    action: '#b62f35', actionHover: '#d13b42', actionText: '#ffffff',
    selectedSurface: '#502529', selectedText: '#ffd2d4', selectedIndicator: '#ff6368',
    successSurface: '#213a29', successText: '#a9ddb8', warningSurface: '#3d3215', warningText: '#f4d78c', warningBorder: '#d69e2e',
    dangerSurface: '#4c2326', dangerText: '#ffc2c5',
  },
} satisfies ThemeDefinition;
