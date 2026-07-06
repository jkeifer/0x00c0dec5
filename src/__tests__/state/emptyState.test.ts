// @vitest-environment jsdom
//
// The `clearConfig` flow tests below render `AppStateProvider` via
// `renderHook` (same pattern as presets.test.ts) — jsdom is needed for that,
// even though this file has no JSX of its own.
/**
 * Phase 3 (plan: clear-config button): `makeEmptyState` + `clearConfig`.
 *
 * Covers:
 *  - the empty state survives the validateExternalState round-trip with its
 *    zero variables preserved (validateState must not "helpfully" restore
 *    the starter variables);
 *  - `computePipelineStages` on the empty state does not throw, for both
 *    data models, and yields empty/near-empty outputs;
 *  - the `clearConfig` flow via `useAppState`: state becomes empty, only the
 *    active model's `0x00c0dec5-state-{model}` key is written, and the other
 *    model's key / checkpoint / custom-preset slots are untouched.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { computePipelineStages } from '../../hooks/usePipeline.ts';
import { validateExternalState } from '../../state/persistence.ts';
import { customPresetKey } from '../../state/presets.ts';
import { CHECKPOINT_KEY } from '../../state/share.ts';
import { AppStateProvider, useAppState } from '../../state/useAppState.ts';
import { DEFAULT_STATE, makeEmptyState } from '../../types/state.ts';
import type { AppState } from '../../types/state.ts';

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

const TABULAR_KEY = '0x00c0dec5-state-tabular';
const ARRAY_KEY = '0x00c0dec5-state-array';
const MODELS: AppState['dataModel'][] = ['tabular', 'array'];

// ─── makeEmptyState shape ─────────────────────────────────────────────────

describe('makeEmptyState', () => {
  for (const model of MODELS) {
    it(`${model}: blank variables/pipelines, defaults elsewhere, no aliasing of DEFAULT_STATE`, () => {
      const empty = makeEmptyState(model);
      expect(empty.dataModel).toBe(model);
      expect(empty.variables).toEqual([]);
      expect(empty.fieldPipelines).toEqual({});
      // shape/chunkShape stay at defaults (validateState hard-resets on
      // empty shape arrays; the degenerate state is zero VARIABLES).
      expect(empty.shape).toEqual(DEFAULT_STATE.shape);
      expect(empty.chunkShape).toEqual(DEFAULT_STATE.chunkShape);
      // Factory returns fresh mutable refs, never DEFAULT_STATE's own.
      expect(empty.shape).not.toBe(DEFAULT_STATE.shape);
      expect(empty.metadata).not.toBe(DEFAULT_STATE.metadata);
      empty.shape.push(99);
      expect(DEFAULT_STATE.shape).toEqual([32]);
    });
  }
});

// ─── Survives the loader/validator round-trip ─────────────────────────────

describe('makeEmptyState — validateExternalState round-trip', () => {
  for (const model of MODELS) {
    it(`${model}: round-trips deep-equal with zero variables preserved`, () => {
      const empty = makeEmptyState(model);
      const validated = validateExternalState(JSON.parse(JSON.stringify(empty)), model);
      expect(validated).not.toBeNull();
      expect(validated).toEqual(empty);
      expect(validated!.variables).toEqual([]);
      expect(validated!.fieldPipelines).toEqual({});
    });
  }
});

// ─── Pipeline computes without throwing ───────────────────────────────────

describe('makeEmptyState — computePipelineStages', () => {
  for (const model of MODELS) {
    it(`${model}: does not throw and yields empty/near-empty outputs`, () => {
      const result = computePipelineStages(makeEmptyState(model));
      expect(result.stages.length).toBeGreaterThan(0);
      // Every stage is empty of variable data.
      expect(result.variableStats.size).toBe(0);
      // The write step still assembles a file (magic number etc.), just one
      // with no chunk data — "empty but valid pipeline outputs".
      expect(result.files.length).toBeGreaterThanOrEqual(1);
      if (result.readResult.success) {
        expect(result.readResult.reconstructedValues.size).toBe(0);
      }
    });
  }
});

// ─── clearConfig flow via useAppState ─────────────────────────────────────

function renderApp() {
  return renderHook(() => useAppState(), { wrapper: AppStateProvider });
}

describe('clearConfig — flow', () => {
  it('replaces the active model\'s state with the empty state', () => {
    const { result } = renderApp();
    expect(result.current.state.variables.length).toBeGreaterThan(0);
    act(() => {
      result.current.clearConfig();
    });
    expect(result.current.state).toEqual(makeEmptyState('tabular'));
    expect(result.current.state.variables).toEqual([]);
    expect(result.current.state.fieldPipelines).toEqual({});
  });

  it('writes ONLY the active model\'s state key; other model / checkpoint / custom presets untouched', () => {
    // Pre-populate every key clearConfig must not touch.
    const arrayBefore = JSON.stringify({ ...DEFAULT_STATE, dataModel: 'array', shape: [9, 9] });
    const checkpointBefore = JSON.stringify(DEFAULT_STATE);
    const customTabBefore = JSON.stringify({ ...DEFAULT_STATE, shape: [7] });
    const customArrBefore = JSON.stringify({ ...DEFAULT_STATE, dataModel: 'array' });
    localStorage.setItem(ARRAY_KEY, arrayBefore);
    localStorage.setItem(CHECKPOINT_KEY, checkpointBefore);
    localStorage.setItem(customPresetKey('tabular'), customTabBefore);
    localStorage.setItem(customPresetKey('array'), customArrBefore);

    const { result } = renderApp();
    expect(result.current.state.dataModel).toBe('tabular');
    act(() => {
      result.current.clearConfig();
    });

    // Active model's key holds the empty state (saved synchronously, not
    // waiting on the 500ms debounce).
    const savedTabular = localStorage.getItem(TABULAR_KEY);
    expect(savedTabular).not.toBeNull();
    expect(JSON.parse(savedTabular!)).toEqual(makeEmptyState('tabular'));

    // Everything else is byte-identical.
    expect(localStorage.getItem(ARRAY_KEY)).toBe(arrayBefore);
    expect(localStorage.getItem(CHECKPOINT_KEY)).toBe(checkpointBefore);
    expect(localStorage.getItem(customPresetKey('tabular'))).toBe(customTabBefore);
    expect(localStorage.getItem(customPresetKey('array'))).toBe(customArrBefore);
  });

  it('clears the ARRAY model\'s key when array is active, leaving tabular alone', () => {
    const { result } = renderApp();
    act(() => {
      result.current.switchDataModel('array');
    });
    const tabularBefore = localStorage.getItem(TABULAR_KEY);
    act(() => {
      result.current.clearConfig();
    });
    expect(result.current.state).toEqual(makeEmptyState('array'));
    expect(JSON.parse(localStorage.getItem(ARRAY_KEY)!)).toEqual(makeEmptyState('array'));
    expect(localStorage.getItem(TABULAR_KEY)).toBe(tabularBefore);
  });
});
