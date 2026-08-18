// Gate test for F17 (overhaul-plan.md): index.html's blocking pre-paint
// theme script duplicates uiPrefs.ts's storage key and resolution rule
// (dark/light pass through, anything else falls back to matchMedia
// 'prefers-color-scheme: light', defaulting to 'dark' on error). Nothing
// pins the two in sync; this reads index.html's script body and asserts it
// still uses the same key and the same fallback rule as resolveTheme.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { UI_PREFS_KEY } from '../../../src/state/uiPrefs.ts';

const indexHtml = readFileSync(
  fileURLToPath(new URL('../../../index.html', import.meta.url)),
  'utf-8',
);

describe('index.html blocking theme script stays in sync with uiPrefs.ts', () => {
  it('reads the same localStorage key as UI_PREFS_KEY', () => {
    expect(indexHtml).toContain(`localStorage.getItem('${UI_PREFS_KEY}'`);
  });

  it('falls back to prefers-color-scheme: light matchMedia, defaulting to dark', () => {
    expect(indexHtml).toContain("matchMedia('(prefers-color-scheme: light)')");
    expect(indexHtml).toContain("dataset.theme = 'dark'");
  });

  it('only treats theme values \'dark\' or \'light\' as valid stored prefs', () => {
    expect(indexHtml).toMatch(/t\.theme === 'dark' \|\| t\.theme === 'light'/);
  });
});
