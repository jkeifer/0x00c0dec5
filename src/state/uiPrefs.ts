// UI preferences (theme, guide panel) persisted under a key deliberately
// separate from the config state keys: these survive Clear, preset loads, and
// data-model switches. index.html has an inline blocking <head> script that
// reads the same key pre-paint — keep its logic in sync with resolveTheme.

export const UI_PREFS_KEY = '0x00c0dec5-ui-prefs';

export type ThemePref = 'dark' | 'light' | 'system';

export interface UiPrefs {
  theme: ThemePref;
  // Guide panel state (Phase 5 consumes these; defined now so the stored
  // shape doesn't churn).
  guideOpen: boolean;
  guideCollapsed: boolean;
  guideStep: number;
}

export const DEFAULT_UI_PREFS: UiPrefs = {
  theme: 'system',
  guideOpen: false,
  guideCollapsed: false,
  guideStep: 0,
};

/** Load prefs, tolerating missing/garbage storage — any invalid field falls
 * back to its default individually. */
export function loadUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY);
    if (raw === null) return { ...DEFAULT_UI_PREFS };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_UI_PREFS };
    const p = parsed as Record<string, unknown>;
    return {
      theme: p.theme === 'dark' || p.theme === 'light' || p.theme === 'system'
        ? p.theme
        : DEFAULT_UI_PREFS.theme,
      guideOpen: typeof p.guideOpen === 'boolean' ? p.guideOpen : DEFAULT_UI_PREFS.guideOpen,
      guideCollapsed:
        typeof p.guideCollapsed === 'boolean' ? p.guideCollapsed : DEFAULT_UI_PREFS.guideCollapsed,
      guideStep:
        typeof p.guideStep === 'number' && Number.isInteger(p.guideStep) && p.guideStep >= 0
          ? p.guideStep
          : DEFAULT_UI_PREFS.guideStep,
    };
  } catch {
    return { ...DEFAULT_UI_PREFS };
  }
}

/** Read-merge-write (click-driven, no debounce needed). Returns the merged
 * prefs. Storage failures (quota, private mode) are swallowed — prefs are a
 * convenience, not data. */
export function saveUiPrefs(patch: Partial<UiPrefs>): UiPrefs {
  const next = { ...loadUiPrefs(), ...patch };
  try {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
  return next;
}

/** Resolve a preference to a concrete theme. 'system' consults matchMedia
 * (defaulting to dark where unavailable, e.g. jsdom). */
export function resolveTheme(pref: ThemePref): 'dark' | 'light' {
  if (pref === 'dark' || pref === 'light') return pref;
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/** Write the *resolved* theme to <html data-theme> — CSS only ever sees
 * 'dark' | 'light'; the 'system' indirection lives entirely in JS. */
export function applyTheme(pref: ThemePref): void {
  document.documentElement.dataset.theme = resolveTheme(pref);
}

/** Re-resolve on OS theme changes while the preference is 'system'. Call once
 * at startup. */
export function watchSystemTheme(): void {
  try {
    window
      .matchMedia('(prefers-color-scheme: light)')
      .addEventListener('change', () => {
        if (loadUiPrefs().theme === 'system') applyTheme('system');
      });
  } catch {
    // matchMedia unavailable — nothing to watch.
  }
}
