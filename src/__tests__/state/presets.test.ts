// @vitest-environment jsdom
//
// The `loadPreset` flow describes below render `AppStateProvider` via
// `renderHook` (same pattern as switchDataModel.test.tsx) — jsdom is needed
// for that, even though this file has no JSX of its own.
/**
 * D10 (remediation-plan.md, Phase 6.2): built-in presets.
 *
 * Covers:
 *  - each preset's checked-in JSON validates cleanly through the same
 *    loader pipeline as any persisted state, with zero fields defaulted
 *    away (the JSON is already a complete, valid AppState — see
 *    scripts/gen-presets.ts);
 *  - each preset round-trips through `computePipelineStages` with
 *    `readResult.success === true`;
 *  - each preset's lossless variables reconstruct exact values, and lossy
 *    ones (float32-stored decimal/continuous) are both bounded-error AND
 *    truthfully flagged in `lossyVariables`;
 *  - the preset-load flow (custom snapshot saved, other-model slot
 *    preserved, data-model switch) via `useAppState`'s `loadPreset`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { computePipelineStages } from '../../hooks/usePipeline.ts';
import { generateValues } from '../../engine/generate.ts';
import { validateExternalState, loadState } from '../../state/persistence.ts';
import {
  PRESET_OPTIONS,
  resolvePreset,
  saveCustomPreset,
  loadCustomPreset,
  hasCustomPreset,
  CUSTOM_PRESET_KEY,
  type PresetKey,
} from '../../state/presets.ts';
import { AppStateProvider, useAppState } from '../../state/useAppState.ts';
import { DEFAULT_STATE } from '../../types/state.ts';
import type { AppState } from '../../types/state.ts';

import basicallyParquetRaw from '../../presets/basically-parquet.json';
import basicallyGeotiffRaw from '../../presets/basically-geotiff.json';
import basicallyZarrRaw from '../../presets/basically-zarr.json';

/** Minimal Map-backed localStorage mock (same pattern as persistence.test.ts /
 * switchDataModel.test.tsx) — the vitest environment has no persistent
 * localStorage across test files. */
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
  'basically-parquet': basicallyParquetRaw,
  'basically-geotiff': basicallyGeotiffRaw,
  'basically-zarr': basicallyZarrRaw,
};

const PRESET_MODEL: Record<PresetKey, AppState['dataModel']> = {
  'basically-parquet': 'tabular',
  'basically-geotiff': 'array',
  'basically-zarr': 'array',
};

// ─── Preset JSON validates cleanly (zero fields defaulted away) ─────────

describe('preset JSON — validates cleanly through the loader pipeline', () => {
  for (const key of Object.keys(PRESET_RAW) as PresetKey[]) {
    it(`${key}: validateExternalState round-trips deep-equal (nothing defaulted away)`, () => {
      const model = PRESET_MODEL[key];
      const validated = validateExternalState(PRESET_RAW[key], model);
      expect(validated).not.toBeNull();
      // The checked-in JSON is already a complete, valid AppState (built by
      // scripts/gen-presets.ts against the real AppState type) — validating
      // it should be a no-op. Deep-equality here is the "zero fields
      // defaulted away" assertion the task calls for.
      expect(validated).toEqual(PRESET_RAW[key]);
    });
  }
});

// ─── Preset contents sanity per D10 ──────────────────────────────────────

describe('preset contents — D10 shape', () => {
  it('basically-parquet: tabular, 1-D [64], column interleaving, chunked [16], footer+trailer, chunk index, custom entry', () => {
    const s = basicallyParquetRaw as unknown as AppState;
    expect(s.dataModel).toBe('tabular');
    expect(s.shape).toEqual([64]);
    expect(s.chunkShape).toEqual([16]);
    expect(s.interleaving).toBe('column');
    expect(s.write.metadataPlacement).toBe('footer');
    expect(s.write.footerLocator).toBe('trailer');
    expect(s.write.includeMetadata).toBe(true);
    expect(s.metadata.includeChunkIndex).toBe(true);
    expect(s.metadata.customEntries).toContainEqual({ key: 'created_by', value: '0x00C0DEC5' });
    // A visibly-working codec pipeline on the stepped uint variable...
    expect(s.fieldPipelines.humidity.length).toBeGreaterThan(0);
    // ...and a codec-free float column as the contrast case.
    expect(s.fieldPipelines.temperature).toEqual([]);
  });

  it('basically-geotiff: array, 2-D [16,16], tiled chunks [8,8], header metadata, crs + transform entries', () => {
    const s = basicallyGeotiffRaw as unknown as AppState;
    expect(s.dataModel).toBe('array');
    expect(s.shape).toEqual([16, 16]);
    expect(s.chunkShape).toEqual([8, 8]);
    expect(s.write.metadataPlacement).toBe('header');
    expect(s.write.includeMetadata).toBe(true);
    const keys = s.metadata.customEntries.map((e) => e.key);
    expect(keys).toContain('crs');
    expect(keys).toContain('transform');
    expect(s.metadata.customEntries.find((e) => e.key === 'crs')?.value).toBe('EPSG:4326');
    const names = s.variables.map((v) => v.name);
    expect(names).toContain('elevation');
    expect(names).toContain('landcover');
  });

  it('basically-zarr: array, 2-D, per-chunk partitioning, sidecar metadata, chunked [8,8]', () => {
    const s = basicallyZarrRaw as unknown as AppState;
    expect(s.dataModel).toBe('array');
    expect(s.shape).toEqual([16, 16]);
    expect(s.chunkShape).toEqual([8, 8]);
    expect(s.write.partitioning).toBe('per-chunk');
    expect(s.write.metadataPlacement).toBe('sidecar');
    expect(s.write.includeMetadata).toBe(true);
  });
});

// ─── Round-trip through computePipelineStages ────────────────────────────

function expectedLogicalValues(state: AppState): Map<string, number[]> {
  const totalElements = state.shape.reduce((a, b) => a * b, 1);
  const expected = new Map<string, number[]>();
  for (const v of state.variables) {
    expected.set(v.name, generateValues(v.name, v.logicalType, totalElements));
  }
  return expected;
}

describe('preset round-trip — computePipelineStages', () => {
  for (const key of Object.keys(PRESET_RAW) as PresetKey[]) {
    it(`${key}: readResult.success === true`, () => {
      const state = validateExternalState(PRESET_RAW[key], PRESET_MODEL[key])!;
      const { readResult } = computePipelineStages(state);
      if (!readResult.success) {
        throw new Error(`${key} failed to read: ${readResult.reason} — ${readResult.message}`);
      }
      expect(readResult.success).toBe(true);
    });
  }

  it('basically-parquet: humidity (uint16 + delta+RLE) reconstructs exactly; temperature/pressure (float32) bounded-error and flagged lossy', () => {
    const state = validateExternalState(PRESET_RAW['basically-parquet'], 'tabular')!;
    const { readResult } = computePipelineStages(state);
    expect(readResult.success).toBe(true);
    if (!readResult.success) return;

    const expected = expectedLogicalValues(state);
    expect(readResult.reconstructedValues.get('humidity')).toEqual(expected.get('humidity'));
    expect(readResult.lossyVariables.has('humidity')).toBe(false);

    for (const name of ['temperature', 'pressure']) {
      const exp = expected.get(name)!;
      const act = readResult.reconstructedValues.get(name)!;
      expect(act.length).toBe(exp.length);
      for (let i = 0; i < exp.length; i++) {
        expect(Math.abs(act[i] - exp[i])).toBeLessThanOrEqual(0.01);
      }
      expect(readResult.lossyVariables.has(name)).toBe(true);
    }
  });

  it('basically-geotiff: landcover (uint8, codec-free) reconstructs exactly; elevation (float32) bounded-error and flagged lossy', () => {
    const state = validateExternalState(PRESET_RAW['basically-geotiff'], 'array')!;
    const { readResult } = computePipelineStages(state);
    expect(readResult.success).toBe(true);
    if (!readResult.success) return;

    const expected = expectedLogicalValues(state);
    expect(readResult.reconstructedValues.get('landcover')).toEqual(expected.get('landcover'));
    expect(readResult.lossyVariables.has('landcover')).toBe(false);

    const exp = expected.get('elevation')!;
    const act = readResult.reconstructedValues.get('elevation')!;
    expect(act.length).toBe(exp.length);
    // continuous/float32: bounded by float32 precision relative to a [0,3000] range.
    for (let i = 0; i < exp.length; i++) {
      expect(Math.abs(act[i] - exp[i])).toBeLessThanOrEqual(1);
    }
    expect(readResult.lossyVariables.has('elevation')).toBe(true);
  });

  it('basically-zarr: 9 files (8 chunks + sidecar), both float32 variables bounded-error and flagged lossy', () => {
    const state = validateExternalState(PRESET_RAW['basically-zarr'], 'array')!;
    const { readResult, files } = computePipelineStages(state);
    expect(readResult.success).toBe(true);
    if (!readResult.success) return;
    expect(files.length).toBe(9);

    const expected = expectedLogicalValues(state);
    for (const name of ['temperature', 'precipitation']) {
      const exp = expected.get(name)!;
      const act = readResult.reconstructedValues.get(name)!;
      expect(act.length).toBe(exp.length);
      for (let i = 0; i < exp.length; i++) {
        expect(Math.abs(act[i] - exp[i])).toBeLessThanOrEqual(0.01);
      }
      expect(readResult.lossyVariables.has(name)).toBe(true);
    }
  });
});

// ─── resolvePreset / saveCustomPreset / loadCustomPreset ─────────────────

describe('resolvePreset', () => {
  it('resolves each preset key to a validated AppState with the correct dataModel', () => {
    for (const key of Object.keys(PRESET_RAW) as PresetKey[]) {
      const resolved = resolvePreset(key);
      expect(resolved).not.toBeNull();
      expect(resolved!.dataModel).toBe(PRESET_MODEL[key]);
    }
  });

  it('PRESET_OPTIONS lists exactly the three built-ins with the expected labels', () => {
    expect(PRESET_OPTIONS).toEqual([
      { key: 'basically-parquet', label: 'Basically Parquet' },
      { key: 'basically-geotiff', label: 'Basically GeoTIFF' },
      { key: 'basically-zarr', label: 'Basically Zarr' },
    ]);
  });
});

describe('custom preset slot', () => {
  it('hasCustomPreset is false until something is saved', () => {
    expect(hasCustomPreset()).toBe(false);
    saveCustomPreset(DEFAULT_STATE);
    expect(hasCustomPreset()).toBe(true);
  });

  it('saveCustomPreset writes to the dedicated custom-preset key, not either per-model key', () => {
    saveCustomPreset({ ...DEFAULT_STATE, shape: [42] });
    expect(localStorage.getItem(CUSTOM_PRESET_KEY)).not.toBeNull();
    expect(localStorage.getItem(TABULAR_KEY)).toBeNull();
    expect(localStorage.getItem(ARRAY_KEY)).toBeNull();
  });

  it('loadCustomPreset returns null when nothing has been saved', () => {
    expect(loadCustomPreset()).toBeNull();
  });

  it('loadCustomPreset round-trips a saved snapshot, preserving its dataModel', () => {
    const snapshot: AppState = { ...DEFAULT_STATE, dataModel: 'array', shape: [7, 7] };
    saveCustomPreset(snapshot);
    const loaded = loadCustomPreset();
    expect(loaded).not.toBeNull();
    expect(loaded!.dataModel).toBe('array');
    expect(loaded!.shape).toEqual([7, 7]);
  });
});

// ─── Preset-load flow via useAppState().loadPreset ───────────────────────

function renderApp() {
  return renderHook(() => useAppState(), { wrapper: AppStateProvider });
}

describe('loadPreset — flow', () => {
  it('loading a built-in preset replaces state with the preset contents', () => {
    const { result } = renderApp();
    act(() => {
      result.current.loadPreset('basically-parquet');
    });
    expect(result.current.state.dataModel).toBe('tabular');
    expect(result.current.state.shape).toEqual([64]);
    expect(result.current.state.write.metadataPlacement).toBe('footer');
  });

  it('loading a built-in preset snapshots the PRE-LOAD state to the custom slot first', () => {
    const { result } = renderApp();
    act(() => {
      result.current.dispatch({ type: 'SET_SHAPE', shape: [123] });
    });
    expect(result.current.state.shape).toEqual([123]);

    act(() => {
      result.current.loadPreset('basically-geotiff');
    });

    // The preset is now active...
    expect(result.current.state.shape).toEqual([16, 16]);
    expect(result.current.state.dataModel).toBe('array');

    // ...and the custom slot holds exactly what was on screen right before
    // the preset load (shape [123], tabular), not the preset itself.
    const custom = loadCustomPreset();
    expect(custom).not.toBeNull();
    expect(custom!.shape).toEqual([123]);
    expect(custom!.dataModel).toBe('tabular');
  });

  it('loading "custom" restores the most recent pre-preset snapshot', () => {
    const { result } = renderApp();
    act(() => {
      result.current.dispatch({ type: 'SET_SHAPE', shape: [55] });
    });
    act(() => {
      result.current.loadPreset('basically-zarr');
    });
    expect(result.current.state.shape).toEqual([16, 16]);

    act(() => {
      result.current.loadPreset('custom');
    });
    expect(result.current.state.shape).toEqual([55]);
    expect(result.current.state.dataModel).toBe('tabular');
  });

  it('loading "custom" with nothing snapshotted yet is a no-op', () => {
    const { result } = renderApp();
    const before = result.current.state;
    act(() => {
      result.current.loadPreset('custom');
    });
    expect(result.current.state).toBe(before);
  });

  it('loading "custom" does not itself overwrite the custom slot (no re-snapshot)', () => {
    const { result } = renderApp();
    act(() => {
      result.current.dispatch({ type: 'SET_SHAPE', shape: [55] });
    });
    act(() => {
      result.current.loadPreset('basically-parquet');
    });
    act(() => {
      result.current.loadPreset('custom');
    });
    // Restoring 'custom' must not clobber the slot with the just-restored
    // (post-preset) state — a second restore should still yield [55].
    act(() => {
      result.current.dispatch({ type: 'SET_SHAPE', shape: [999] });
    });
    act(() => {
      result.current.loadPreset('custom');
    });
    expect(result.current.state.shape).toEqual([55]);
  });

  it('loading a preset that switches data models does NOT destroy the other model\'s saved slot', () => {
    const { result } = renderApp();
    // Put real, distinguishable content into the array model's own saved
    // slot via the normal switchDataModel path (as if the user had actually
    // been working in array mode before).
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
    expect(savedArrayBefore).not.toBeNull();
    expect(JSON.parse(savedArrayBefore!).shape).toEqual([9, 9]);

    // Now load an array-model preset (Basically GeoTIFF) from tabular. Per
    // D10, this must never touch `0x00c0dec5-state-array` — only the
    // dedicated custom-preset key.
    act(() => {
      result.current.loadPreset('basically-geotiff');
    });
    expect(result.current.state.dataModel).toBe('array');
    expect(result.current.state.shape).toEqual([16, 16]);

    const savedArrayAfter = localStorage.getItem(ARRAY_KEY);
    expect(savedArrayAfter).toBe(savedArrayBefore);
    expect(JSON.parse(savedArrayAfter!).shape).toEqual([9, 9]);

    // Restore via the custom slot (not switchDataModel, which would itself
    // persist whatever's currently on screen — the preset — under the array
    // key; that's switchDataModel's own long-standing "save the outgoing
    // model's live state" behavior, a separate concern from what loadPreset
    // must guarantee). loadPreset('custom') gets back to the pre-preset
    // tabular state without touching either per-model key.
    act(() => {
      result.current.loadPreset('custom');
    });
    expect(result.current.state.dataModel).toBe('tabular');

    // The array model's own persisted slot must still hold the real [9,9]
    // state saved before any preset was ever loaded — proof the preset
    // never overwrote it, read back independently via loadState.
    const reloadedArray = loadState('array');
    expect(reloadedArray).not.toBeNull();
    expect(reloadedArray!.shape).toEqual([9, 9]);
  });

  it('loading a built-in preset records the preset\'s data model as the active model', () => {
    const { result } = renderApp();
    act(() => {
      result.current.loadPreset('basically-zarr');
    });
    expect(localStorage.getItem('0x00c0dec5-active-model')).toBe('array');
  });
});
