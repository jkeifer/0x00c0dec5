// Every value here (except `palette`, see below) is a CSS custom-property
// reference resolved per-theme in src/index.css (`:root` = dark,
// `[data-theme='light']` = light). Same keys as always, so the ~24 inline-style
// consumers restyle on theme change with zero React re-renders.
export const colors = {
  bg: 'var(--bg)',
  surface: 'var(--surface)',
  surfaceHover: 'var(--surface-hover)',
  surfaceInput: 'var(--surface-input)',
  border: 'var(--border)',
  borderSubtle: 'var(--border-subtle)',

  textPrimary: 'var(--text-primary)',
  textSecondary: 'var(--text-secondary)',
  textTertiary: 'var(--text-tertiary)',

  accent: 'var(--accent)',
  accentDim: 'var(--accent-dim)',

  // 10-color variable palette. MUST stay literal hex: Sidebar writes these
  // into persisted Variable.color, and GridView does parseInt() math on them.
  // For colored *text*, use displayColor() below so light mode can substitute
  // readable equivalents via --palette-{i}.
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

  paneAccentLeft: 'var(--pane-accent-left)',
  paneAccentRight: 'var(--pane-accent-right)',

  warning: 'var(--warning)',
  warningDim: 'var(--warning-dim)',

  // Task 3.10 (remediation-plan.md, UI-12): the single source for
  // success/error values that were previously hardcoded per call site
  // (PipelineStrip, ReadStatus, StagePane, TypeAssignConfig).
  success: 'var(--success)',
  error: 'var(--error)',
  errorDim: 'var(--error-dim)',
} as const;

/**
 * Map a persisted palette hex (Variable.color) to its theme-aware CSS var for
 * display as *text* (e.g. `#e06c75` → `var(--palette-0, #e06c75)`), so light
 * mode can substitute a darker, readable equivalent. Unknown colors pass
 * through unchanged. Do NOT use for values that undergo color math (GridView
 * heatmap, hex+alpha concatenation) or for swatch chips — those keep raw hex.
 */
export function displayColor(hex: string): string {
  const i = (colors.palette as readonly string[]).indexOf(hex);
  return i === -1 ? hex : `var(--palette-${i}, ${hex})`;
}

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

// Icon-button style shared by collapse/expand toggles throughout the app
// (Sidebar, StagePane). Matches GuidePanel.tsx's iconButtonStyle precedent.
export const collapseButtonStyle: React.CSSProperties = {
  background: 'transparent',
  color: colors.textSecondary,
  border: `1px solid ${colors.border}`,
  borderRadius: radii.sm,
  padding: `1px ${spacing.xs}px`,
  fontSize: fontSizes.sm,
  fontFamily: 'inherit',
  cursor: 'pointer',
  lineHeight: 1.4,
  flexShrink: 0,
};
