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

/** `dataModel` mirrors each preset JSON's own declared model so the Header
 * can offer only the presets that belong to the active data model (loading a
 * preset never switches models anymore). */
export const PRESET_OPTIONS: { key: PresetKey; label: string; dataModel: AppState['dataModel'] }[] = [
  { key: 'basically-parquet', label: 'Basically Parquet', dataModel: 'tabular' },
  { key: 'basically-geotiff', label: 'Basically GeoTIFF', dataModel: 'array' },
  { key: 'basically-zarr', label: 'Basically Zarr', dataModel: 'array' },
];

const PRESET_RAW: Record<PresetKey, unknown> = {
  'basically-parquet': basicallyParquetRaw,
  'basically-geotiff': basicallyGeotiffRaw,
  'basically-zarr': basicallyZarrRaw,
};

/**
 * Custom slot (D10, revised): where the state in play *before* a built-in
 * preset was loaded gets snapshotted, so the user can get back to what they
 * had. One slot PER data model — now that presets themselves are
 * model-scoped, a single shared slot would let a preset load on one model
 * silently destroy the other model's "get back to what I had" snapshot.
 * The pre-revision single-slot key is kept as a read-only legacy fallback.
 */
export const LEGACY_CUSTOM_PRESET_KEY = '0x00c0dec5-preset-custom';

export function customPresetKey(model: AppState['dataModel']): string {
  return `${LEGACY_CUSTOM_PRESET_KEY}-${model}`;
}

/** Resolve a preset's raw JSON through the validate/merge pipeline, forcing
 * `dataModel` to whatever the preset itself declares. The Header only offers
 * presets whose declared model matches the active one, so this no longer
 * switches models in practice. Returns `null` if the preset's own
 * checked-in JSON somehow fails validation (a bug in the preset file, not
 * user input — should not happen for the shipped presets). */
export function resolvePreset(key: PresetKey): AppState | null {
  const raw = PRESET_RAW[key];
  const model = (raw as { dataModel?: unknown })?.dataModel;
  const targetModel: AppState['dataModel'] = model === 'array' ? 'array' : 'tabular';
  return validateExternalState(raw, targetModel);
}

/** Snapshot `state` to its model's custom slot. Called before loading any
 * built-in preset (D10: "loading a built-in first snapshots current state to
 * the custom slot"), never by loading the custom slot itself. */
export function saveCustomPreset(state: AppState): void {
  try {
    localStorage.setItem(customPresetKey(state.dataModel), JSON.stringify(state));
  } catch {
    // silently fail on storage errors, consistent with saveState/saveActiveModel
  }
}

/** Read the raw snapshot for `model`: the per-model key, falling back to the
 * pre-revision single-slot key when the per-model key is absent AND the
 * legacy snapshot's own declared model matches. */
function readCustomPresetRaw(model: AppState['dataModel']): string | null {
  const raw = localStorage.getItem(customPresetKey(model));
  if (raw !== null) return raw;
  const legacy = localStorage.getItem(LEGACY_CUSTOM_PRESET_KEY);
  if (legacy === null) return null;
  try {
    const parsed = JSON.parse(legacy) as { dataModel?: unknown };
    const legacyModel = parsed.dataModel === 'array' ? 'array' : 'tabular';
    return legacyModel === model ? legacy : null;
  } catch {
    return null;
  }
}

/** Load `model`'s custom slot, validated through the same pipeline. Returns
 * `null` if nothing has been snapshotted for that model (nothing to restore)
 * or the snapshot fails validation. */
export function loadCustomPreset(model: AppState['dataModel']): AppState | null {
  try {
    const raw = readCustomPresetRaw(model);
    if (!raw) return null;
    return validateExternalState(JSON.parse(raw), model);
  } catch {
    return null;
  }
}

/** Whether a custom snapshot currently exists for `model` (drives whether
 * the 'Custom (restore)' dropdown option is offered at all). */
export function hasCustomPreset(model: AppState['dataModel']): boolean {
  try {
    return readCustomPresetRaw(model) !== null;
  } catch {
    return false;
  }
}
