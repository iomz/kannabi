import type { ThemeDefinition } from './types';

export const jadeGreenTheme = {
  id: 'jade-green',
  label: 'Jade green',
  light: {
    canvas: '#f2f8f5', surface: '#ffffff', surfaceMuted: '#e5f1eb', surfaceHover: '#eff7f3',
    border: '#cee1d7', controlBorder: '#789a8a', text: '#263a32', textMuted: '#526b61',
    chrome: '#153d34', chromeHover: '#23574a', chromeText: '#effaf5', chromeMuted: '#afd0c1', brandMark: '#45c59b',
    brand: '#26a77f', brandSoft: '#d7f0e6', brandText: '#17644e',
    link: '#167158', linkHover: '#0f5542', focus: '#167158',
    action: '#1e7159', actionHover: '#155743', actionText: '#ffffff',
    selectedSurface: '#d7f0e6', selectedText: '#145c47', selectedIndicator: '#26a77f',
    successSurface: '#dff1e6', successText: '#28613e', warningSurface: '#fff4d6', warningText: '#6b4e00', warningBorder: '#b7791f',
    dangerSurface: '#f6e3e1', dangerText: '#852f2b',
  },
  dark: {
    canvas: '#111b17', surface: '#182720', surfaceMuted: '#21352b', surfaceHover: '#294035',
    border: '#355345', controlBorder: '#648775', text: '#edf6f1', textMuted: '#b3c9be',
    chrome: '#0b1712', chromeHover: '#1e382e', chromeText: '#f0faf5', chromeMuted: '#a9c7b8', brandMark: '#4fd3a7',
    brand: '#4fd3a7', brandSoft: '#174536', brandText: '#acf0d6',
    link: '#70dfba', linkHover: '#a0ebd2', focus: '#64dbb4',
    action: '#28785e', actionHover: '#226b53', actionText: '#ffffff',
    selectedSurface: '#1c4a3a', selectedText: '#cef5e7', selectedIndicator: '#4fd3a7',
    successSurface: '#1d3d2b', successText: '#a5dfba', warningSurface: '#3d3215', warningText: '#f4d78c', warningBorder: '#d69e2e',
    dangerSurface: '#492522', dangerText: '#ffc0b9',
  },
} satisfies ThemeDefinition;
