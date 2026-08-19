import type { AppState } from '../types/state.ts';
import { validateExternalState } from './persistence.ts';
import geotiffesqueRaw from '../presets/geotiffesque.json';
import cogEsqueRaw from '../presets/cog-esque.json';
import zarrishRaw from '../presets/zarrish.json';
import parquetAdjacentRaw from '../presets/parquet-adjacent.json';
import avroesqueRaw from '../presets/avroesque.json';

/**
 * Built-in FORMAT presets: checked-in JSON files conforming to the persisted
 * `AppState` shape (see `scripts/gen-presets.ts`, which builds them against
 * the real `AppState` type). Each is a full state snapshot with a curated
 * pipeline/chunking/write config tuned to its namesake real-world format.
 * Preset variables carry per-variable `source` refs (curated variables fetch
 * real data), and provenance is baked directly into `metadata.customEntries`.
 * They load through the exact same `validateExternalState` -> migrate ->
 * default-merge -> validate pipeline as any persisted state, so an `AppState`
 * shape change not reflected in these files fails the same way a stale save
 * would — these files double as loader regression fixtures.
 */
export type PresetKey = 'geotiffesque' | 'cog-esque' | 'zarrish' | 'parquet-adjacent' | 'avroesque';

/** `dataModel` mirrors each preset JSON's own declared model so the Header
 * can offer only the presets that belong to the active data model (loading a
 * preset never switches models). */
export const PRESET_OPTIONS: { key: PresetKey; label: string; dataModel: AppState['dataModel'] }[] = [
  { key: 'parquet-adjacent', label: 'Parquet-adjacent', dataModel: 'tabular' },
  { key: 'avroesque', label: 'Avro-esque', dataModel: 'tabular' },
  { key: 'geotiffesque', label: 'GeoTIFFesque', dataModel: 'array' },
  { key: 'cog-esque', label: 'COG-esque', dataModel: 'array' },
  { key: 'zarrish', label: 'Zarrish', dataModel: 'array' },
];

const PRESET_RAW: Record<PresetKey, unknown> = {
  'geotiffesque': geotiffesqueRaw,
  'cog-esque': cogEsqueRaw,
  'zarrish': zarrishRaw,
  'parquet-adjacent': parquetAdjacentRaw,
  'avroesque': avroesqueRaw,
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
