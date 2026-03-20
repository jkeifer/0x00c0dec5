export const colors = {
  bg: '#0d1117',
  surface: '#161b22',
  surfaceHover: '#1c2129',
  surfaceInput: '#0d1117',
  border: '#30363d',
  borderSubtle: '#21262d',

  textPrimary: '#e6edf3',
  textSecondary: '#8b949e',
  textTertiary: '#484f58',

  accent: '#58a6ff',
  accentDim: 'rgba(88, 166, 255, 0.15)',

  // 10-color variable palette
  palette: [
    '#e06c75', // red
    '#61afef', // blue
    '#98c379', // green
    '#e5c07b', // yellow
    '#c678dd', // purple
    '#56b6c2', // cyan
    '#d19a66', // orange
    '#be5046', // dark red
    '#7ec8e3', // light blue
    '#b8bb26', // lime
  ],

  paneAccentLeft: '#58a6ff',
  paneAccentRight: '#d19a66',
} as const;

export const fonts = {
  sans: "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  mono: "'JetBrains Mono', 'Fira Code', ui-monospace, Consolas, monospace",
} as const;

export const fontSizes = {
  xs: 10,
  sm: 11,
  md: 12,
  lg: 15,
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

export const radii = {
  sm: 3,
  md: 6,
  lg: 8,
  pill: 9999,
} as const;
