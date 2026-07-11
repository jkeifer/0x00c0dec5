/**
 * Plan Phase 4: UI prefs (theme) + displayColor.
 *
 * Covers:
 *  - loadUiPrefs/saveUiPrefs round-trip and per-field garbage tolerance;
 *  - resolveTheme honoring explicit 'dark'/'light' (no matchMedia needed);
 *  - displayColor mapping every palette hex to its var(--palette-i, hex)
 *    reference and passing unknown colors through untouched.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  UI_PREFS_KEY,
  DEFAULT_UI_PREFS,
  loadUiPrefs,
  saveUiPrefs,
  resolveTheme,
} from '../../../src/state/uiPrefs.ts';
import { colors, displayColor } from '../../../src/theme.ts';

/** Minimal Map-backed localStorage mock (same pattern as presets.test.ts). */
class MockStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

beforeEach(() => {
  globalThis.localStorage = new MockStorage() as unknown as Storage;
});

describe('loadUiPrefs / saveUiPrefs', () => {
  it('returns defaults when nothing is stored', () => {
    expect(loadUiPrefs()).toEqual(DEFAULT_UI_PREFS);
  });

  it('round-trips a saved patch and merges with existing prefs', () => {
    saveUiPrefs({ theme: 'light' });
    expect(loadUiPrefs()).toEqual({ ...DEFAULT_UI_PREFS, theme: 'light' });

    saveUiPrefs({ guideOpen: true, guideStep: 3 });
    expect(loadUiPrefs()).toEqual({
      theme: 'light',
      guideOpen: true,
      guideCollapsed: false,
      guideStep: 3,
    });
  });

  it('saveUiPrefs returns the merged prefs', () => {
    const merged = saveUiPrefs({ theme: 'dark' });
    expect(merged).toEqual({ ...DEFAULT_UI_PREFS, theme: 'dark' });
  });

  it('tolerates non-JSON garbage', () => {
    localStorage.setItem(UI_PREFS_KEY, 'not json {{{');
    expect(loadUiPrefs()).toEqual(DEFAULT_UI_PREFS);
  });

  it('tolerates JSON of the wrong shape', () => {
    for (const garbage of ['null', '42', '"dark"', '[]']) {
      localStorage.setItem(UI_PREFS_KEY, garbage);
      expect(loadUiPrefs()).toEqual(DEFAULT_UI_PREFS);
    }
  });

  it('falls back per-field for invalid values while keeping valid ones', () => {
    localStorage.setItem(
      UI_PREFS_KEY,
      JSON.stringify({ theme: 'hotdog', guideOpen: true, guideCollapsed: 'yes', guideStep: -2.5 }),
    );
    expect(loadUiPrefs()).toEqual({
      theme: 'system',
      guideOpen: true,
      guideCollapsed: false,
      guideStep: 0,
    });
  });
});

describe('resolveTheme', () => {
  it('honors explicit dark/light without consulting the system', () => {
    expect(resolveTheme('dark')).toBe('dark');
    expect(resolveTheme('light')).toBe('light');
  });
});

describe('displayColor', () => {
  it('maps every palette hex to var(--palette-i, hex)', () => {
    colors.palette.forEach((hex, i) => {
      expect(displayColor(hex)).toBe(`var(--palette-${i}, ${hex})`);
    });
  });

  it('passes unknown colors through unchanged', () => {
    expect(displayColor('#123456')).toBe('#123456');
    expect(displayColor('rebeccapurple')).toBe('rebeccapurple');
  });
});
