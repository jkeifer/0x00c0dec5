import { useState } from 'react';
import { colors, fonts, fontSizes, spacing } from '../../theme.ts';
import { Radio } from '../shared/Radio.tsx';
import { useAppState } from '../../state/useAppState.ts';
import { PRESET_OPTIONS, hasCustomPreset, type PresetKey } from '../../state/presets.ts';
import { saveCheckpoint, hasCheckpoint, buildShareUrl } from '../../state/share.ts';
import { loadUiPrefs, saveUiPrefs, applyTheme, type ThemePref } from '../../state/uiPrefs.ts';

const THEME_CYCLE: Record<ThemePref, ThemePref> = { dark: 'light', light: 'system', system: 'dark' };
const THEME_LABEL: Record<ThemePref, string> = { dark: 'Dark', light: 'Light', system: 'System' };

const MODEL_OPTIONS = [
  { value: 'tabular', label: 'Tabular' },
  { value: 'array', label: 'N-d Array' },
];

/** Sentinel placeholder value for the preset `<select>` — never a real
 * option, so the select always shows 'Presets…' after firing a load (D10:
 * "it's an action menu, not persistent state," not a control bound to any
 * piece of AppState). */
const PRESET_PLACEHOLDER = '';

/** Compact header-button style shared by the checkpoint/restore/share
 * controls — matches the preset `<select>`'s sizing/border/font so the three
 * new controls read as one cohesive group. */
const headerButtonStyle: React.CSSProperties = {
  background: colors.surfaceInput,
  color: colors.textPrimary,
  border: `1px solid ${colors.border}`,
  borderRadius: 3,
  padding: `${spacing.xs - 1}px ${spacing.xs}px`,
  fontSize: fontSizes.sm,
  fontFamily: 'inherit',
  cursor: 'pointer',
};

/** Copy `text` to the clipboard, preferring the async Clipboard API and
 * falling back to a hidden-textarea + `execCommand('copy')` for contexts
 * where `navigator.clipboard` is unavailable (e.g. insecure/non-HTTPS
 * origins, some embedded browsers, or when clipboard-write permission is
 * denied but a synchronous user-gesture copy is still allowed). */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the execCommand fallback below
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export function Header() {
  const { state, switchDataModel, loadPreset, restoreCheckpoint, clearConfig } = useAppState();
  const [checkpointLabel, setCheckpointLabel] = useState('Save checkpoint');
  const [canRestore, setCanRestore] = useState(() => hasCheckpoint());
  const [shareLabel, setShareLabel] = useState('Share');
  // Local label state only — the theme itself lives in CSS vars keyed off
  // <html data-theme>, so no React re-render is needed to restyle.
  const [themePref, setThemePref] = useState<ThemePref>(() => loadUiPrefs().theme);

  function handleThemeToggle() {
    const next = THEME_CYCLE[themePref];
    saveUiPrefs({ theme: next });
    applyTheme(next);
    setThemePref(next);
  }

  function handleSaveCheckpoint() {
    saveCheckpoint(state);
    setCanRestore(true);
    setCheckpointLabel('Saved ✓');
    setTimeout(() => setCheckpointLabel('Save checkpoint'), 1200);
  }

  function handleRestoreCheckpoint() {
    restoreCheckpoint();
  }

  function handleClearConfig() {
    const modelLabel = state.dataModel === 'tabular' ? 'Tabular' : 'N-d Array';
    // window.confirm: no dialog infrastructure exists in the app, and a
    // destructive one-shot action doesn't warrant building one.
    if (
      window.confirm(
        `Clear the current ${modelLabel} configuration? The other data model, checkpoint, and presets are not affected.`,
      )
    ) {
      clearConfig();
    }
  }

  async function handleShare() {
    const url = buildShareUrl(state);
    const copied = await copyToClipboard(url);
    setShareLabel(copied ? 'Copied ✓' : 'Copy failed');
    setTimeout(() => setShareLabel('Share'), 1200);
  }

  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: 40,
        padding: `0 ${spacing.md}px`,
        background: colors.surface,
        borderBottom: `1px solid ${colors.border}`,
        flexShrink: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: spacing.md }}>
        <span
          style={{
            fontFamily: fonts.mono,
            fontSize: fontSizes.lg,
            color: colors.textPrimary,
            fontWeight: 600,
            letterSpacing: '0.5px',
          }}
        >
          0x00C0DEC5
        </span>
        <Radio
          options={MODEL_OPTIONS}
          value={state.dataModel}
          onChange={(model) => switchDataModel(model as 'tabular' | 'array')}
          size="sm"
          testIdPrefix="model-toggle"
        />
        <select
          value={PRESET_PLACEHOLDER}
          onChange={(e) => {
            const value = e.target.value;
            if (value === PRESET_PLACEHOLDER) return;
            loadPreset(value as PresetKey | 'custom');
            // Action menu, not persistent state (D10) — the select always
            // shows the placeholder again after firing a load, achieved here
            // by controlling `value` to the placeholder unconditionally
            // rather than tracking the selection in component state.
            e.target.blur();
          }}
          data-testid="preset-select"
          style={{
            background: colors.surfaceInput,
            color: colors.textPrimary,
            border: `1px solid ${colors.border}`,
            borderRadius: 3,
            padding: `${spacing.xs - 1}px ${spacing.xs}px`,
            fontSize: fontSizes.sm,
            fontFamily: 'inherit',
            cursor: 'pointer',
            outline: 'none',
          }}
        >
          <option value={PRESET_PLACEHOLDER} disabled hidden>
            Presets…
          </option>
          {PRESET_OPTIONS.filter((opt) => opt.dataModel === state.dataModel).map((opt) => (
            <option key={opt.key} value={opt.key}>
              {opt.label}
            </option>
          ))}
          {hasCustomPreset(state.dataModel) && <option value="custom">Custom (restore)</option>}
        </select>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: spacing.md }}>
        <button
          type="button"
          onClick={handleSaveCheckpoint}
          data-testid="save-checkpoint"
          style={headerButtonStyle}
        >
          {checkpointLabel}
        </button>
        <button
          type="button"
          onClick={handleRestoreCheckpoint}
          disabled={!canRestore}
          data-testid="restore-checkpoint"
          style={{
            ...headerButtonStyle,
            opacity: canRestore ? 1 : 0.4,
            cursor: canRestore ? 'pointer' : 'default',
          }}
        >
          Restore
        </button>
        <button
          type="button"
          onClick={handleClearConfig}
          data-testid="clear-config"
          style={headerButtonStyle}
        >
          Clear
        </button>
        <button
          type="button"
          onClick={handleShare}
          data-testid="share-state"
          style={headerButtonStyle}
        >
          {shareLabel}
        </button>
        <button
          type="button"
          onClick={handleThemeToggle}
          data-testid="theme-toggle"
          aria-label={`Theme: ${THEME_LABEL[themePref]}. Click to switch to ${THEME_LABEL[THEME_CYCLE[themePref]]}.`}
          style={headerButtonStyle}
        >
          Theme: {THEME_LABEL[themePref]}
        </button>
      </div>
    </header>
  );
}
