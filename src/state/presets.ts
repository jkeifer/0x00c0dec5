import type { AppState } from '../types/state.ts';
import { validateExternalState } from './persistence.ts';
import basicallyParquetRaw from '../presets/basically-parquet.json';
import basicallyGeotiffRaw from '../presets/basically-geotiff.json';
import basicallyZarrRaw from '../presets/basically-zarr.json';

/**
 * D10 (remediation-plan.md, Phase 6.2): built-in presets are checked-in JSON
 * files conforming to the persisted `AppState` shape (see
 * `scripts/gen-presets.ts`, which generated them against the real `AppState`
 * type and validated each one reads back successfully). They are loaded
 * through the exact same `validateExternalState` -> migrate -> default-merge
 * -> validate pipeline as any other persisted state, so a future `AppState`
 * shape change that isn't reflected in these files fails the same way a
 * stale localStorage save would (default-merged, not silently broken) —
 * these files double as loader regression fixtures.
 */
export type PresetKey = 'basically-parquet' | 'basically-geotiff' | 'basically-zarr';

export const PRESET_OPTIONS: { key: PresetKey; label: string }[] = [
  { key: 'basically-parquet', label: 'Basically Parquet' },
  { key: 'basically-geotiff', label: 'Basically GeoTIFF' },
  { key: 'basically-zarr', label: 'Basically Zarr' },
];

const PRESET_RAW: Record<PresetKey, unknown> = {
  'basically-parquet': basicallyParquetRaw,
  'basically-geotiff': basicallyGeotiffRaw,
  'basically-zarr': basicallyZarrRaw,
};

/**
 * Custom slot (D10): where the state in play *before* a built-in preset was
 * loaded gets snapshotted, so the user can get back to what they had. A
 * single slot (not per-model) — loading a preset is a single "I'm about to
 * blow away what's on screen" action regardless of which model was active,
 * and the 'Custom (restore)' dropdown entry restores exactly that snapshot.
 */
export const CUSTOM_PRESET_KEY = '0x00c0dec5-preset-custom';

/** Resolve a preset's raw JSON through the validate/merge pipeline, forcing
 * `dataModel` to whatever the preset itself declares (presets intentionally
 * span both data models — loading "Basically GeoTIFF" while on the tabular
 * model switches to the array model). Returns `null` if the preset's own
 * checked-in JSON somehow fails validation (a bug in the preset file, not
 * user input — should not happen for the shipped presets). */
export function resolvePreset(key: PresetKey): AppState | null {
  const raw = PRESET_RAW[key];
  const model = (raw as { dataModel?: unknown })?.dataModel;
  const targetModel: AppState['dataModel'] = model === 'array' ? 'array' : 'tabular';
  return validateExternalState(raw, targetModel);
}

/** Snapshot `state` to the custom slot. Called before loading any built-in
 * preset (D10: "loading a built-in first snapshots current state to the
 * custom slot"), never by loading the custom slot itself. */
export function saveCustomPreset(state: AppState): void {
  try {
    localStorage.setItem(CUSTOM_PRESET_KEY, JSON.stringify(state));
  } catch {
    // silently fail on storage errors, consistent with saveState/saveActiveModel
  }
}

/** Load the custom slot, validated through the same pipeline. Returns `null`
 * if nothing has been snapshotted yet (nothing to restore) or the snapshot
 * fails validation. The snapshot's own `dataModel` is preserved (it is
 * exactly whatever the user had active before switching to a preset). */
export function loadCustomPreset(): AppState | null {
  try {
    const raw = localStorage.getItem(CUSTOM_PRESET_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { dataModel?: unknown };
    const model: AppState['dataModel'] = parsed.dataModel === 'array' ? 'array' : 'tabular';
    return validateExternalState(parsed, model);
  } catch {
    return null;
  }
}

/** Whether a custom snapshot currently exists (drives whether the 'Custom
 * (restore)' dropdown option should be selectable/shown as available). */
export function hasCustomPreset(): boolean {
  try {
    return localStorage.getItem(CUSTOM_PRESET_KEY) !== null;
  } catch {
    return false;
  }
}
