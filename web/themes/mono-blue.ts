import type { ThemeDefinition } from './types';

export const monoBlueTheme = {
  id: 'mono-blue',
  label: 'Mono blue',
  light: {
    canvas: '#f3f6fa', surface: '#ffffff', surfaceMuted: '#eaf0f6', surfaceHover: '#f5f8fb',
    border: '#d4dee8', controlBorder: '#8095aa', text: '#223343', textMuted: '#536779',
    chrome: '#17314f', chromeHover: '#244766', chromeText: '#f1f5f9', chromeMuted: '#b5c5d5', brandMark: '#54a8dd',
    brand: '#2f80c4', brandSoft: '#deebf6', brandText: '#245b88',
    link: '#245f95', linkHover: '#194a77', focus: '#245f95',
    action: '#244f7a', actionHover: '#193d61', actionText: '#ffffff',
    selectedSurface: '#deebf6', selectedText: '#204f77', selectedIndicator: '#2f80c4',
    successSurface: '#e3f1e8', successText: '#275f3f', warningSurface: '#fff4d6', warningText: '#6b4e00', warningBorder: '#b7791f',
    dangerSurface: '#f7e6e5', dangerText: '#872f2c',
  },
  dark: {
    canvas: '#101824', surface: '#172334', surfaceMuted: '#202f43', surfaceHover: '#273a51',
    border: '#354a63', controlBorder: '#667f9b', text: '#edf3f9', textMuted: '#b5c3d2',
    chrome: '#0a1422', chromeHover: '#1c3047', chromeText: '#f3f7fb', chromeMuted: '#adbed0', brandMark: '#5cb4ea',
    brand: '#5ca9e6', brandSoft: '#173753', brandText: '#b8ddf8',
    link: '#7fc2f0', linkHover: '#abdafa', focus: '#74bcec',
    action: '#326b9c', actionHover: '#2a5e8c', actionText: '#ffffff',
    selectedSurface: '#1d3c59', selectedText: '#d8edfc', selectedIndicator: '#63afe8',
    successSurface: '#1d3929', successText: '#a6dcbc', warningSurface: '#3d3215', warningText: '#f4d78c', warningBorder: '#d69e2e',
    dangerSurface: '#472422', dangerText: '#ffbeb8',
  },
} satisfies ThemeDefinition;
