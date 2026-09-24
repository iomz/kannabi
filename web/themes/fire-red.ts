import type { ThemeDefinition } from './types';

export const fireRedTheme = {
  id: 'fire-red',
  label: 'Fire red',
  light: {
    canvas: '#f8f4f1', surface: '#fffdfb', surfaceMuted: '#f2e9e5', surfaceHover: '#f8efeb',
    border: '#e1d3cd', controlBorder: '#9c837b', text: '#3b2e2b', textMuted: '#6d5751',
    chrome: '#3b2422', chromeHover: '#59332e', chromeText: '#fff3ef', chromeMuted: '#d9b8ae', brandMark: '#ed6a54',
    brand: '#d85845', brandSoft: '#f6ddd7', brandText: '#843326',
    link: '#9b392c', linkHover: '#74291f', focus: '#a83d2f',
    action: '#ad3e30', actionHover: '#873025', actionText: '#ffffff',
    selectedSurface: '#f5d8d1', selectedText: '#772c22', selectedIndicator: '#d85845',
    successSurface: '#e4f0e6', successText: '#2f633e', warningSurface: '#fff4d6', warningText: '#6b4e00', warningBorder: '#b7791f',
    dangerSurface: '#f5d8d1', dangerText: '#7d2d23',
  },
  dark: {
    canvas: '#171211', surface: '#211918', surfaceMuted: '#2e2220', surfaceHover: '#382925',
    border: '#503a35', controlBorder: '#85665e', text: '#f7eeeb', textMuted: '#cbb9b3',
    chrome: '#100c0b', chromeHover: '#30201d', chromeText: '#fff3ef', chromeMuted: '#cfb1a8', brandMark: '#f17460',
    brand: '#f17460', brandSoft: '#4a241e', brandText: '#ffc6bc',
    link: '#ff9482', linkHover: '#ffb7aa', focus: '#ff8b77',
    action: '#b64031', actionHover: '#a6372a', actionText: '#ffffff',
    selectedSurface: '#522820', selectedText: '#ffd5cd', selectedIndicator: '#f17460',
    successSurface: '#203a29', successText: '#a8ddba', warningSurface: '#3d3215', warningText: '#f4d78c', warningBorder: '#d69e2e',
    dangerSurface: '#52251f', dangerText: '#ffc2b7',
  },
} satisfies ThemeDefinition;
