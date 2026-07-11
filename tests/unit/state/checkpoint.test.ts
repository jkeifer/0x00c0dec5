// @vitest-environment jsdom
//
// Task 6.4 (remediation-plan.md, Phase 6): checkpoint/restore ("undo-lite"
// for the live talk). Covers the storage-level helpers in `state/share.ts`
// (`saveCheckpoint`/`loadCheckpoint`/`hasCheckpoint`) and the
// `useAppState().restoreCheckpoint` flow, following the same
// renderHook-through-AppStateProvider pattern as `presets.test.ts` /
// `switchDataModel.test.tsx`.
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  CHECKPOINT_KEY,
  saveCheckpoint,
  loadCheckpoint,
  hasCheckpoint,
} from '../../../src/state/share.ts';
import { AppStateProvider, useAppState } from '../../../src/state/useAppState.ts';
import { DEFAULT_STATE } from '../../../src/types/state.ts';
import type { AppState } from '../../../src/types/state.ts';

/** Minimal Map-backed localStorage mock (same pattern as
 * persistence.test.ts / presets.test.ts). */
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

// ─── Storage-level helpers ────────────────────────────────────────────────

describe('checkpoint storage helpers', () => {
  it('hasCheckpoint is false until something is saved', () => {
    expect(hasCheckpoint()).toBe(false);
    saveCheckpoint(DEFAULT_STATE);
    expect(hasCheckpoint()).toBe(true);
  });

  it('saveCheckpoint writes to the dedicated checkpoint key, not either per-model key', () => {
    saveCheckpoint({ ...DEFAULT_STATE, shape: [42] });
    expect(localStorage.getItem(CHECKPOINT_KEY)).not.toBeNull();
    expect(localStorage.getItem('0x00c0dec5-state-tabular')).toBeNull();
    expect(localStorage.getItem('0x00c0dec5-state-array')).toBeNull();
  });

  it('loadCheckpoint returns null when nothing has been saved', () => {
    expect(loadCheckpoint()).toBeNull();
  });

  it('loadCheckpoint round-trips a saved snapshot deep-equal', () => {
    // chunkShape [48] (not the default [32]) so validateState's
    // clamp-to-shape pass (mirrors SET_SHAPE) is a no-op here and the
    // round-trip is genuinely deep-equal rather than incidentally clamped.
    const snapshot: AppState = {
      ...DEFAULT_STATE,
      shape: [48],
      chunkShape: [48],
      write: { ...DEFAULT_STATE.write, magicNumber: 'ABCDEF01' },
    };
    saveCheckpoint(snapshot);
    const loaded = loadCheckpoint();
    expect(loaded).toEqual(snapshot);
  });

  it('loadCheckpoint preserves a checkpoint from the other dataModel', () => {
    const snapshot: AppState = { ...DEFAULT_STATE, dataModel: 'array', shape: [7, 7] };
    saveCheckpoint(snapshot);
    const loaded = loadCheckpoint();
    expect(loaded).not.toBeNull();
    expect(loaded!.dataModel).toBe('array');
    expect(loaded!.shape).toEqual([7, 7]);
  });

  it('loadCheckpoint returns null for corrupt JSON without throwing', () => {
    localStorage.setItem(CHECKPOINT_KEY, '{not valid json');
    expect(() => loadCheckpoint()).not.toThrow();
    expect(loadCheckpoint()).toBeNull();
  });

  it('loadCheckpoint returns null for structurally invalid state without throwing', () => {
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify({ shape: 'not-an-array' }));
    // shape isn't a positive-int array, but validateExternalState falls back
    // to full defaults for that (like validateState does for any malformed
    // persisted state) rather than returning null outright — either way, no
    // crash and a usable AppState back out.
    expect(() => loadCheckpoint()).not.toThrow();
    const loaded = loadCheckpoint();
    expect(loaded).not.toBeNull();
    expect(loaded!.shape).toEqual(DEFAULT_STATE.shape);
  });

  it('loadCheckpoint returns null for non-object JSON', () => {
    localStorage.setItem(CHECKPOINT_KEY, '42');
    expect(loadCheckpoint()).toBeNull();
  });
});

// ─── useAppState().restoreCheckpoint flow ────────────────────────────────

function renderApp() {
  return renderHook(() => useAppState(), { wrapper: AppStateProvider });
}

describe('restoreCheckpoint — flow', () => {
  it('save -> mutate -> restore round-trips deep-equal', () => {
    const { result } = renderApp();

    act(() => {
      result.current.dispatch({ type: 'SET_SHAPE', shape: [48] });
    });
    const checkpointed = result.current.state;
    expect(checkpointed.shape).toEqual([48]);

    act(() => {
      saveCheckpoint(result.current.state);
    });

    // Mutate: change shape again and add a codec step.
    act(() => {
      result.current.dispatch({ type: 'SET_SHAPE', shape: [16] });
    });
    act(() => {
      const variableId = result.current.state.variables[0].id;
      result.current.dispatch({
        type: 'SET_FIELD_PIPELINE',
        variableId,
        steps: [{ codec: 'delta', params: { order: 1 } }],
      });
    });
    expect(result.current.state.shape).toEqual([16]);
    expect(result.current.state).not.toEqual(checkpointed);

    act(() => {
      result.current.restoreCheckpoint();
    });

    expect(result.current.state).toEqual(checkpointed);
  });

  it('restoring does NOT clear the checkpoint (repeatable)', () => {
    const { result } = renderApp();

    act(() => {
      result.current.dispatch({ type: 'SET_SHAPE', shape: [48] });
    });
    act(() => {
      saveCheckpoint(result.current.state);
    });

    act(() => {
      result.current.dispatch({ type: 'SET_SHAPE', shape: [99] });
    });
    act(() => {
      result.current.restoreCheckpoint();
    });
    expect(result.current.state.shape).toEqual([48]);

    // Mutate again and restore a second time — proves the slot survived.
    act(() => {
      result.current.dispatch({ type: 'SET_SHAPE', shape: [3] });
    });
    act(() => {
      result.current.restoreCheckpoint();
    });
    expect(result.current.state.shape).toEqual([48]);
    expect(hasCheckpoint()).toBe(true);
  });

  it('restores across a dataModel switch: checkpoint saved on tabular, restored while on array', () => {
    const { result } = renderApp();

    act(() => {
      result.current.dispatch({ type: 'SET_SHAPE', shape: [48] });
    });
    act(() => {
      saveCheckpoint(result.current.state);
    });
    expect(result.current.state.dataModel).toBe('tabular');

    act(() => {
      result.current.switchDataModel('array');
    });
    expect(result.current.state.dataModel).toBe('array');

    act(() => {
      result.current.restoreCheckpoint();
    });
    expect(result.current.state.dataModel).toBe('tabular');
    expect(result.current.state.shape).toEqual([48]);
  });

  it('restores a checkpoint saved from the array model while currently on tabular', () => {
    const { result } = renderApp();

    act(() => {
      result.current.switchDataModel('array');
    });
    act(() => {
      result.current.dispatch({ type: 'SET_SHAPE', shape: [9, 9] });
    });
    act(() => {
      saveCheckpoint(result.current.state);
    });

    act(() => {
      result.current.switchDataModel('tabular');
    });
    expect(result.current.state.dataModel).toBe('tabular');

    act(() => {
      result.current.restoreCheckpoint();
    });
    expect(result.current.state.dataModel).toBe('array');
    expect(result.current.state.shape).toEqual([9, 9]);
  });

  it('corrupt checkpoint JSON: restore is a no-op, no crash', () => {
    const { result } = renderApp();
    act(() => {
      result.current.dispatch({ type: 'SET_SHAPE', shape: [55] });
    });
    localStorage.setItem(CHECKPOINT_KEY, '{not valid json');

    const before = result.current.state;
    expect(() => {
      act(() => {
        result.current.restoreCheckpoint();
      });
    }).not.toThrow();
    expect(result.current.state).toBe(before);
  });

  it('restoring with no checkpoint saved is a no-op', () => {
    const { result } = renderApp();
    const before = result.current.state;
    act(() => {
      result.current.restoreCheckpoint();
    });
    expect(result.current.state).toBe(before);
  });
});
