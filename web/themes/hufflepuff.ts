import type { ThemeDefinition } from './types';

export const hufflepuffTheme = {
  id: 'hufflepuff',
  label: 'Hufflepuff',
  light: {
    canvas: '#fbf7e8', surface: '#fffdf6', surfaceMuted: '#f4ecd2', surfaceHover: '#faf3dc',
    border: '#ded2ad', controlBorder: '#94845e', text: '#393329', textMuted: '#665c48',
    chrome: '#302d25', chromeHover: '#484236', chromeText: '#fff8df', chromeMuted: '#d3c69e', brandMark: '#efc84a',
    brand: '#c79516', brandSoft: '#f3e3ad', brandText: '#5c4300',
    link: '#765100', linkHover: '#563a00', focus: '#8a6200',
    action: '#3d382e', actionHover: '#27241e', actionText: '#fff9e5',
    selectedSurface: '#f1dfa6', selectedText: '#4a3710', selectedIndicator: '#a67400',
    successSurface: '#e8f0df', successText: '#3d5e2e', warningSurface: '#fff4d6', warningText: '#6b4e00', warningBorder: '#b7791f',
    dangerSurface: '#f5e4df', dangerText: '#81372d',
  },
  dark: {
    canvas: '#171612', surface: '#211f19', surfaceMuted: '#2c291f', surfaceHover: '#353126',
    border: '#4a4433', controlBorder: '#7b704e', text: '#f5efd9', textMuted: '#c9bea0',
    chrome: '#090909', chromeHover: '#24221b', chromeText: '#fff7da', chromeMuted: '#d0c291', brandMark: '#f1c84b',
    brand: '#f1c84b', brandSoft: '#443813', brandText: '#ffe79a',
    link: '#f3cf5a', linkHover: '#ffe38b', focus: '#f3cf5a',
    action: '#d6aa23', actionHover: '#efc13a', actionText: '#201900',
    selectedSurface: '#4a3c16', selectedText: '#ffedac', selectedIndicator: '#f1c84b',
    successSurface: '#283a21', successText: '#b9dda6', warningSurface: '#3d3215', warningText: '#f4d78c', warningBorder: '#d69e2e',
    dangerSurface: '#49241f', dangerText: '#ffc0b2',
  },
} satisfies ThemeDefinition;
