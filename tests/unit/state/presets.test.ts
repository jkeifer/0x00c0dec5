// @vitest-environment jsdom
//
// The `loadPreset` flow describes below render `AppStateProvider` via
// `renderHook` (same pattern as switchDataModel.test.tsx) — jsdom is needed
// for that, even though this file has no JSX of its own.
/**
 * Built-in FORMAT presets (reworked): each is now a full AppState snapshot
 * carrying a `dataset` ref (loading fetches real data) with seeded provenance
 * mirrored in customEntries, plus a codec/chunking/write config tuned to its
 * namesake format.
 *
 * Covers:
 *  - each preset's checked-in JSON validates cleanly through the same loader
 *    pipeline as any persisted state, zero fields defaulted away;
 *  - each preset declares its dataset ref (id + seededEntries mirrored in
 *    customEntries), so deselect-removal works after a load;
 *  - resolvePreset / PRESET_OPTIONS shape;
 *  - the preset-load flow (custom snapshot saved, other-model slot preserved)
 *    via `useAppState`'s `loadPreset`.
 *
 * NOTE: the in-browser codec round-trip (all four presets use a Pyodide-backed
 * codec — deflate/zstd — which throws in node) is pinned by
 * tests/ui/scenario-dataset-presets.mjs, not here.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { validateExternalState, loadState } from '../../../src/state/persistence.ts';
import {
  PRESET_OPTIONS,
  resolvePreset,
  saveCustomPreset,
  loadCustomPreset,
  hasCustomPreset,
  customPresetKey,
  LEGACY_CUSTOM_PRESET_KEY,
  type PresetKey,
} from '../../../src/state/presets.ts';
import { AppStateProvider, useAppState } from '../../../src/state/useAppState.ts';
import { DEFAULT_STATE } from '../../../src/types/state.ts';
import type { AppState } from '../../../src/types/state.ts';

import geotiffesqueRaw from '../../../src/presets/geotiffesque.json';
import zarrishRaw from '../../../src/presets/zarrish.json';
import parquetAdjacentRaw from '../../../src/presets/parquet-adjacent.json';
import avroesqueRaw from '../../../src/presets/avroesque.json';

/** Minimal Map-backed localStorage mock. */
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

const TABULAR_KEY = '0x00c0dec5-state-tabular';
const ARRAY_KEY = '0x00c0dec5-state-array';

const PRESET_RAW: Record<PresetKey, unknown> = {
  'geotiffesque': geotiffesqueRaw,
  'zarrish': zarrishRaw,
  'parquet-adjacent': parquetAdjacentRaw,
  'avroesque': avroesqueRaw,
};

const PRESET_MODEL: Record<PresetKey, AppState['dataModel']> = {
  'geotiffesque': 'array',
  'zarrish': 'array',
  'parquet-adjacent': 'tabular',
  'avroesque': 'tabular',
};

const PRESET_DATASET: Record<PresetKey, string> = {
  'geotiffesque': 'etopo-dem',
  'zarrish': 'sst-field',
  'parquet-adjacent': 'ghcn-daily',
  'avroesque': 'ghcn-daily',
};

// ─── Preset JSON validates cleanly (zero fields defaulted away) ─────────

describe('preset JSON — validates cleanly through the loader pipeline', () => {
  for (const key of Object.keys(PRESET_RAW) as PresetKey[]) {
    it(`${key}: validateExternalState round-trips deep-equal (nothing defaulted away)`, () => {
      const validated = validateExternalState(PRESET_RAW[key], PRESET_MODEL[key]);
      expect(validated).not.toBeNull();
      expect(validated).toEqual(PRESET_RAW[key]);
    });
  }
});

// ─── Each preset resolves non-null with its declared dataset ──────────────

describe('preset — dataset ref + seeded provenance mirrored in customEntries', () => {
  for (const key of Object.keys(PRESET_RAW) as PresetKey[]) {
    it(`${key}: resolves non-null, dataset id = ${PRESET_DATASET[key]}, seededEntries mirrored in customEntries`, () => {
      const s = resolvePreset(key);
      expect(s).not.toBeNull();
      expect(s!.dataset).not.toBeNull();
      expect(s!.dataset!.id).toBe(PRESET_DATASET[key]);
      expect(s!.dataset!.seededEntries.length).toBeGreaterThan(0);
      // Every seeded entry is present in customEntries — so SET_DATASET_CUSTOM
      // can remove exactly them after a preset load.
      for (const e of s!.dataset!.seededEntries) {
        expect(s!.metadata.customEntries).toContainEqual(e);
      }
    });
  }
});

// ─── Preset contents sanity per the format-fidelity brief ─────────────────

describe('preset contents — format fidelity', () => {
  it('geotiffesque: array, [1024,1024], tiles [256,256], header/BINARY, magic II*\\0, pixel-interleaved, elevation + 2 generated bands, chunk-level deflate', () => {
    const s = geotiffesqueRaw as unknown as AppState;
    expect(s.dataModel).toBe('array');
    expect(s.shape).toEqual([1024, 1024]);
    expect(s.chunkShape).toEqual([256, 256]);
    expect(s.interleaving).toBe('row');
    expect(s.linearization).toBe('c');
    expect(s.byteOrder).toBe('little');
    expect(s.write.partitioning).toBe('single');
    expect(s.write.metadataPlacement).toBe('header');
    expect(s.metadata.serialization).toBe('binary');
    expect(s.write.magicNumber).toBe('49492A00');

    expect(s.variables.map((v) => v.name).sort()).toEqual(['elevation', 'hillshade', 'slope']);
    const elev = s.variables.find((v) => v.name === 'elevation')!;
    expect(elev.id).toBe('etopo-dem-elevation');
    expect(elev.typeAssignment.storageDtype).toBe('int16');

    // The two generated bands must NOT carry the dataset-id prefix (so they
    // generate rather than bind to etopo-dem — Task 5's composition contract).
    const slope = s.variables.find((v) => v.name === 'slope')!;
    const hillshade = s.variables.find((v) => v.name === 'hillshade')!;
    expect(slope.id.startsWith('etopo-dem-')).toBe(false);
    expect(hillshade.id.startsWith('etopo-dem-')).toBe(false);
    expect(slope.logicalType.generation).toBe('smooth');
    expect(hillshade.logicalType.generation).toBe('smooth');
    expect(slope.color).not.toBe(elev.color);
    expect(hillshade.color).not.toBe(elev.color);
    expect(hillshade.color).not.toBe(slope.color);

    // Row mode: per-field pipelines inactive, chunk-level deflate carries it.
    for (const v of s.variables) expect(s.fieldPipelines[v.id]).toEqual([]);
    expect(s.chunkPipeline).toEqual([{ codec: 'deflate', params: {} }]);
  });

  it('zarrish: array, per-chunk partitioning, sidecar, EMPTY magic, sst float32 + byte-shuffle(4)+zstd, column interleaving', () => {
    const s = zarrishRaw as unknown as AppState;
    expect(s.dataModel).toBe('array');
    expect(s.chunkShape).toEqual([256, 256]);
    expect(s.interleaving).toBe('column');
    expect(s.write.partitioning).toBe('per-chunk');
    expect(s.write.metadataPlacement).toBe('sidecar');
    expect(s.write.magicNumber).toBe('');
    const sst = s.variables.find((v) => v.name === 'sst')!;
    expect(sst.typeAssignment.storageDtype).toBe('float32');
    expect(s.fieldPipelines[sst.id]).toEqual([
      { codec: 'byte-shuffle', params: { elementSize: 4 } },
      { codec: 'zstd', params: {} },
    ]);
  });

  it('parquet-adjacent: tabular, column interleaving, single file, footer+trailer, magic PAR1, BINARY, chunk [65536], authentic per-column encodings', () => {
    const s = parquetAdjacentRaw as unknown as AppState;
    expect(s.dataModel).toBe('tabular');
    expect(s.interleaving).toBe('column');
    expect(s.write.partitioning).toBe('single');
    expect(s.write.metadataPlacement).toBe('footer');
    expect(s.write.footerLocator).toBe('trailer');
    expect(s.write.magicNumber).toBe('50415231');
    expect(s.metadata.serialization).toBe('binary');
    expect(s.chunkShape).toEqual([65536]);
    const byName = Object.fromEntries(s.variables.map((v) => [v.name, v]));
    expect(s.fieldPipelines[byName.date.id]).toEqual([{ codec: 'delta', params: {} }, { codec: 'deflate', params: {} }]);
    expect(s.fieldPipelines[byName.tmax.id]).toEqual([{ codec: 'delta', params: {} }, { codec: 'zigzag', params: {} }, { codec: 'deflate', params: {} }]);
    expect(s.fieldPipelines[byName.prcp.id]).toEqual([{ codec: 'rle', params: {} }, { codec: 'deflate', params: {} }]);
    expect(s.fieldPipelines[byName.station.id]).toEqual([{ codec: 'dictionary', params: {} }, { codec: 'rle', params: {} }]);
  });

  it('avroesque: tabular, ROW interleaving, single file, header+JSON, magic Obj\\1, chunk [4096], shared chunkPipeline deflate (no per-field)', () => {
    const s = avroesqueRaw as unknown as AppState;
    expect(s.dataModel).toBe('tabular');
    expect(s.interleaving).toBe('row');
    expect(s.write.partitioning).toBe('single');
    expect(s.write.metadataPlacement).toBe('header');
    expect(s.metadata.serialization).toBe('json');
    expect(s.write.magicNumber).toBe('4F626A01');
    expect(s.chunkShape).toEqual([4096]);
    expect(s.chunkPipeline).toEqual([{ codec: 'deflate', params: {} }]);
    // Row mode: field pipelines all empty (inactive; the shared chunk pipeline runs).
    for (const v of s.variables) expect(s.fieldPipelines[v.id]).toEqual([]);
  });
});

// ─── resolvePreset / PRESET_OPTIONS ──────────────────────────────────────

describe('resolvePreset', () => {
  it('resolves each preset key to a validated AppState with the correct dataModel', () => {
    for (const key of Object.keys(PRESET_RAW) as PresetKey[]) {
      const resolved = resolvePreset(key);
      expect(resolved).not.toBeNull();
      expect(resolved!.dataModel).toBe(PRESET_MODEL[key]);
    }
  });

  it('PRESET_OPTIONS lists exactly the four format presets, model-scoped', () => {
    expect(PRESET_OPTIONS).toEqual([
      { key: 'parquet-adjacent', label: 'Parquet-adjacent', dataModel: 'tabular' },
      { key: 'avroesque', label: 'Avro-esque', dataModel: 'tabular' },
      { key: 'geotiffesque', label: 'GeoTIFFesque', dataModel: 'array' },
      { key: 'zarrish', label: 'Zarrish', dataModel: 'array' },
    ]);
  });

  it('each PRESET_OPTIONS dataModel matches the preset JSON\'s own declared model', () => {
    for (const opt of PRESET_OPTIONS) {
      expect(opt.dataModel).toBe(PRESET_MODEL[opt.key]);
    }
  });
});

// ─── Custom slot (unchanged mechanics) ───────────────────────────────────

describe('custom preset slot (per-model)', () => {
  it('hasCustomPreset is false until something is saved for that model', () => {
    expect(hasCustomPreset('tabular')).toBe(false);
    saveCustomPreset(DEFAULT_STATE);
    expect(hasCustomPreset('tabular')).toBe(true);
  });

  it('saveCustomPreset writes to the state\'s own model slot only', () => {
    saveCustomPreset({ ...DEFAULT_STATE, shape: [42] });
    expect(localStorage.getItem(customPresetKey('tabular'))).not.toBeNull();
    expect(localStorage.getItem(customPresetKey('array'))).toBeNull();
    expect(localStorage.getItem(TABULAR_KEY)).toBeNull();
    expect(localStorage.getItem(ARRAY_KEY)).toBeNull();
  });

  it('loadCustomPreset round-trips a saved snapshot under its own model', () => {
    const snapshot: AppState = { ...DEFAULT_STATE, dataModel: 'array', shape: [7, 7] };
    saveCustomPreset(snapshot);
    const loaded = loadCustomPreset('array');
    expect(loaded).not.toBeNull();
    expect(loaded!.shape).toEqual([7, 7]);
    expect(loadCustomPreset('tabular')).toBeNull();
  });

  it('legacy single-slot key is honored when its declared model matches', () => {
    const legacy: AppState = { ...DEFAULT_STATE, dataModel: 'array', shape: [3, 3] };
    localStorage.setItem(LEGACY_CUSTOM_PRESET_KEY, JSON.stringify(legacy));
    expect(hasCustomPreset('array')).toBe(true);
    expect(hasCustomPreset('tabular')).toBe(false);
    expect(loadCustomPreset('array')!.shape).toEqual([3, 3]);
  });
});

// ─── Preset-load flow via useAppState().loadPreset ───────────────────────

function renderApp() {
  return renderHook(() => useAppState(), { wrapper: AppStateProvider });
}

describe('loadPreset — flow', () => {
  it('loading a built-in preset replaces state with the preset contents (incl. dataset ref)', () => {
    const { result } = renderApp();
    act(() => {
      result.current.loadPreset('parquet-adjacent');
    });
    expect(result.current.state.dataModel).toBe('tabular');
    expect(result.current.state.write.metadataPlacement).toBe('footer');
    expect(result.current.state.dataset!.id).toBe('ghcn-daily');
  });

  it('loading a preset snapshots the PRE-LOAD state to its model\'s custom slot first', () => {
    const { result } = renderApp();
    act(() => {
      result.current.dispatch({ type: 'SET_SHAPE', shape: [123] });
    });
    act(() => {
      result.current.loadPreset('parquet-adjacent');
    });
    const custom = loadCustomPreset('tabular');
    expect(custom).not.toBeNull();
    expect(custom!.shape).toEqual([123]);
    expect(hasCustomPreset('array')).toBe(false);
  });

  it('loading "custom" restores the most recent pre-preset snapshot', () => {
    const { result } = renderApp();
    act(() => {
      result.current.dispatch({ type: 'SET_SHAPE', shape: [55] });
    });
    act(() => {
      result.current.loadPreset('parquet-adjacent');
    });
    act(() => {
      result.current.loadPreset('custom');
    });
    expect(result.current.state.shape).toEqual([55]);
  });

  it('after loading a preset (dataset active), deselecting removes exactly the seeded entries', () => {
    const { result } = renderApp();
    act(() => {
      result.current.loadPreset('parquet-adjacent');
    });
    const seeded = result.current.state.dataset!.seededEntries;
    expect(seeded.length).toBeGreaterThan(0);
    act(() => {
      result.current.selectCustomDataset();
    });
    expect(result.current.state.dataset).toBeNull();
    for (const e of seeded) {
      expect(result.current.state.metadata.customEntries).not.toContainEqual(e);
    }
  });

  it('loading a preset does NOT touch either model\'s saved state slot', () => {
    const { result } = renderApp();
    act(() => {
      result.current.switchDataModel('array');
    });
    act(() => {
      result.current.dispatch({ type: 'SET_SHAPE', shape: [9, 9] });
    });
    act(() => {
      result.current.switchDataModel('tabular');
    });
    const savedArrayBefore = localStorage.getItem(ARRAY_KEY);
    act(() => {
      result.current.loadPreset('parquet-adjacent');
    });
    expect(localStorage.getItem(ARRAY_KEY)).toBe(savedArrayBefore);
    const reloadedArray = loadState('array');
    expect(reloadedArray!.shape).toEqual([9, 9]);
  });
});
