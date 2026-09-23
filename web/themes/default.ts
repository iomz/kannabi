import type { ThemeDefinition } from './types';

export const defaultTheme = {
  id: 'default',
  label: 'Default',
  light: {
    canvas: '#f5f6f2', surface: '#ffffff', surfaceMuted: '#eef2ef', surfaceHover: '#f6f8f5',
    border: '#d9e1dc', controlBorder: '#879b94', text: '#243833', textMuted: '#586b63',
    chrome: '#17353c', chromeHover: '#244b54', chromeText: '#f1f5f3', chromeMuted: '#b9c9c7', brandMark: '#35a9bf',
    brand: '#168ca4', brandSoft: '#dceef1', brandText: '#14576a',
    link: '#176c83', linkHover: '#105368', focus: '#176c83',
    action: '#245f6c', actionHover: '#194b57', actionText: '#ffffff',
    selectedSurface: '#dceef1', selectedText: '#134f60', selectedIndicator: '#168ca4',
    successSurface: '#e4f1e8', successText: '#25613e', warningSurface: '#fff4d6', warningText: '#6b4e00', warningBorder: '#b7791f',
    dangerSurface: '#f8e7e5', dangerText: '#8a2f2b',
  },
  dark: {
    canvas: '#151b1d', surface: '#1d2629', surfaceMuted: '#263236', surfaceHover: '#2b383c',
    border: '#3c4c50', controlBorder: '#6f8388', text: '#ecf2f0', textMuted: '#b7c4c1',
    chrome: '#101719', chromeHover: '#213036', chromeText: '#f2f6f5', chromeMuted: '#aebfbc', brandMark: '#53c3d7',
    brand: '#4dc3d7', brandSoft: '#193d45', brandText: '#a6eaf3',
    link: '#73d3e2', linkHover: '#a5e8f1', focus: '#62d5e7',
    action: '#347c89', actionHover: '#2f727e', actionText: '#ffffff',
    selectedSurface: '#25434a', selectedText: '#d6f4f8', selectedIndicator: '#57c9dc',
    successSurface: '#1e3b2b', successText: '#a9dfbd', warningSurface: '#3d3215', warningText: '#f4d78c', warningBorder: '#d69e2e',
    dangerSurface: '#482522', dangerText: '#ffc1ba',
  },
} satisfies ThemeDefinition;
