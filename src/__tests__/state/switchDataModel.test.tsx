// @vitest-environment jsdom
//
// Task 3.7 (remediation-plan.md, fixes SW-4/SW-5): SET_DATA_MODEL's old
// storage I/O (save the outgoing model, load-or-default the incoming model)
// moved out of the reducer into the `switchDataModel` wrapper exposed by
// `useAppState()`. This is the only place that dispatches REPLACE_STATE.
// These tests exercise the wrapper through the real AppStateProvider, hence
// the jsdom pragma (same pattern as usePipeline.memo.test.tsx) — the reducer
// itself is still tested in isolation (and for purity) in reducer.test.ts.
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { AppStateProvider, useAppState } from '../../state/useAppState.ts';
import { DEFAULT_STATE } from '../../types/state.ts';

/** Minimal Map-backed localStorage mock — the vitest node/jsdom environment
 * has no persistent localStorage by default across test files. */
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

const TABULAR_KEY = '0x00c0dec5-state-tabular';
const ARRAY_KEY = '0x00c0dec5-state-array';
const ACTIVE_MODEL_KEY = '0x00c0dec5-active-model';

beforeEach(() => {
  globalThis.localStorage = new MockStorage() as unknown as Storage;
});

function renderApp() {
  return renderHook(() => useAppState(), { wrapper: AppStateProvider });
}

describe('switchDataModel', () => {
  it('is a no-op when switching to the already-active model', () => {
    const { result } = renderApp();
    const before = result.current.state;
    act(() => {
      result.current.switchDataModel(before.dataModel);
    });
    expect(result.current.state).toBe(before);
  });

  it('saves the outgoing model state under its own key when switching', () => {
    const { result } = renderApp();
    act(() => {
      result.current.dispatch({ type: 'SET_SHAPE', shape: [99] });
    });
    expect(result.current.state.shape).toEqual([99]);

    act(() => {
      result.current.switchDataModel('array');
    });

    const saved = localStorage.getItem(TABULAR_KEY);
    expect(saved).not.toBeNull();
    expect(JSON.parse(saved!).shape).toEqual([99]);
  });

  it('switching to a model with no saved state yields defaults with the new dataModel', () => {
    const { result } = renderApp();
    act(() => {
      result.current.switchDataModel('array');
    });
    expect(result.current.state).toEqual({ ...DEFAULT_STATE, dataModel: 'array' });
  });

  it('switching back to a model restores its previously saved state', () => {
    const { result } = renderApp();
    act(() => {
      result.current.dispatch({ type: 'SET_SHAPE', shape: [77] });
    });
    act(() => {
      result.current.switchDataModel('array');
    });
    expect(result.current.state.dataModel).toBe('array');

    act(() => {
      result.current.dispatch({ type: 'SET_SHAPE', shape: [4, 4] });
    });
    act(() => {
      result.current.switchDataModel('tabular');
    });
    expect(result.current.state.dataModel).toBe('tabular');
    expect(result.current.state.shape).toEqual([77]);

    act(() => {
      result.current.switchDataModel('array');
    });
    expect(result.current.state.dataModel).toBe('array');
    expect(result.current.state.shape).toEqual([4, 4]);
  });

  it('records the newly-active model in the active-model storage key', () => {
    const { result } = renderApp();
    expect(localStorage.getItem(ACTIVE_MODEL_KEY)).toBeNull();
    act(() => {
      result.current.switchDataModel('array');
    });
    expect(localStorage.getItem(ACTIVE_MODEL_KEY)).toBe('array');

    act(() => {
      result.current.switchDataModel('tabular');
    });
    expect(localStorage.getItem(ACTIVE_MODEL_KEY)).toBe('tabular');
  });

  it('does not record the active model on a no-op switch', () => {
    const { result } = renderApp();
    act(() => {
      result.current.switchDataModel(result.current.state.dataModel);
    });
    expect(localStorage.getItem(ACTIVE_MODEL_KEY)).toBeNull();
  });

  it('forces dataModel on the resolved state even if persisted data disagrees', () => {
    // Simulate a stale/corrupted save under the array key with a mismatched
    // dataModel field — loadState always forces the requested model, and
    // switchDataModel forces it again defensively.
    localStorage.setItem(
      ARRAY_KEY,
      JSON.stringify({ ...DEFAULT_STATE, dataModel: 'tabular', shape: [5, 5] }),
    );
    const { result } = renderApp();
    act(() => {
      result.current.switchDataModel('array');
    });
    expect(result.current.state.dataModel).toBe('array');
    expect(result.current.state.shape).toEqual([5, 5]);
  });
});

describe('getInitialState — active-model restore (SW-5)', () => {
  it('boots into the last-active model recorded from a previous session', () => {
    localStorage.setItem(ACTIVE_MODEL_KEY, 'array');
    localStorage.setItem(
      ARRAY_KEY,
      JSON.stringify({ ...DEFAULT_STATE, dataModel: 'array', shape: [8, 8] }),
    );
    const { result } = renderApp();
    expect(result.current.state.dataModel).toBe('array');
    expect(result.current.state.shape).toEqual([8, 8]);
  });

  it('falls back to the default model when no active-model key is recorded', () => {
    const { result } = renderApp();
    expect(result.current.state.dataModel).toBe(DEFAULT_STATE.dataModel);
  });

  it('falls back to defaults (with the recorded dataModel) when the active model has no saved state', () => {
    localStorage.setItem(ACTIVE_MODEL_KEY, 'array');
    const { result } = renderApp();
    expect(result.current.state).toEqual({ ...DEFAULT_STATE, dataModel: 'array' });
  });

  it('ignores an unrecognized active-model value', () => {
    localStorage.setItem(ACTIVE_MODEL_KEY, 'not-a-real-model');
    const { result } = renderApp();
    expect(result.current.state.dataModel).toBe(DEFAULT_STATE.dataModel);
  });
});
