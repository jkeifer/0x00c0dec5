import { describe, it, expect, beforeEach } from 'vitest';
import { loadState, saveState } from '../../state/persistence.ts';
import { DEFAULT_STATE, type AppState, type Variable } from '../../types/state.ts';

/** Minimal Map-backed localStorage mock — the vitest node environment has no localStorage. */
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

beforeEach(() => {
  globalThis.localStorage = new MockStorage() as unknown as Storage;
});

function makeVariable(overrides: Partial<Variable> = {}): Variable {
  return {
    id: 'v1',
    name: 'temp',
    logicalType: { type: 'decimal', min: -50, max: 50, decimalPlaces: 1 },
    typeAssignment: { storageDtype: 'float32' },
    color: '#e06c75',
    ...overrides,
  };
}

describe('loadState — corrupt/missing input', () => {
  it('returns null when nothing is persisted', () => {
    expect(loadState('tabular')).toBeNull();
  });

  it('returns null for unparseable JSON', () => {
    localStorage.setItem(TABULAR_KEY, '{not valid json');
    expect(loadState('tabular')).toBeNull();
  });

  it('returns null for non-object JSON', () => {
    localStorage.setItem(TABULAR_KEY, '42');
    expect(loadState('tabular')).toBeNull();
    localStorage.setItem(TABULAR_KEY, '"a string"');
    expect(loadState('tabular')).toBeNull();
    localStorage.setItem(TABULAR_KEY, 'null');
    expect(loadState('tabular')).toBeNull();
  });
});

describe('loadState — v1 dtype-variable migration', () => {
  it('migrates old-format variables with dtype into logicalType + typeAssignment', () => {
    const oldState = {
      ...DEFAULT_STATE,
      variables: [
        { id: 'v1', name: 'temp', color: '#e06c75', dtype: 'float32' },
        { id: 'v2', name: 'hum', color: '#98c379', dtype: 'uint16' },
      ],
      fieldPipelines: {
        temp: [{ codec: 'scale-offset', params: {} }, { codec: 'delta', params: { order: 1 } }],
        hum: [{ codec: 'bitround', params: {} }],
      },
    };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(oldState));

    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.variables).toHaveLength(2);
    expect(result!.variables[0].logicalType).toBeDefined();
    expect(result!.variables[0].typeAssignment.storageDtype).toBe('float32');
    expect(result!.variables[1].typeAssignment.storageDtype).toBe('uint16');
    expect(result!.variables[1].logicalType.type).toBe('integer');

    // scale-offset / bitround steps stripped from pipelines
    expect(result!.fieldPipelines.temp).toEqual([{ codec: 'delta', params: { order: 1 } }]);
    expect(result!.fieldPipelines.hum).toEqual([]);
  });
});

describe('loadState — default-merge for missing fields', () => {
  it('fills in missing write.includeMetadata and ui.showDiff with defaults', () => {
    const partial = {
      dataModel: 'tabular',
      shape: [16],
      chunkShape: [16],
      interleaving: 'column',
      variables: DEFAULT_STATE.variables,
      fieldPipelines: DEFAULT_STATE.fieldPipelines,
      chunkPipeline: [],
      metadata: { customEntries: [], serialization: 'json' },
      write: {
        magicNumber: 'DEADBEEF',
        partitioning: 'single',
        metadataPlacement: 'header',
        chunkOrder: 'row-major',
        // includeMetadata intentionally omitted
      },
      ui: {
        leftPaneStage: 0,
        rightPaneStage: -1,
        leftPaneView: 'table',
        rightPaneView: 'hex',
        sidebarWidth: 300,
        leftPaneRatio: 0.5,
        // showDiff intentionally omitted
      },
    };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(partial));

    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.write.includeMetadata).toBe(DEFAULT_STATE.write.includeMetadata);
    expect(result!.write.magicNumber).toBe('DEADBEEF'); // preserved
    expect(result!.ui.showDiff).toBe(DEFAULT_STATE.ui.showDiff);
  });

  it('fills in an entirely missing top-level section (metadata)', () => {
    const partial: Record<string, unknown> = { ...DEFAULT_STATE };
    delete partial.metadata;
    localStorage.setItem(TABULAR_KEY, JSON.stringify(partial));

    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.metadata).toEqual(DEFAULT_STATE.metadata);
  });
});

describe('loadState — shape/chunkShape validation', () => {
  it('falls back entirely to defaults when shape is invalid', () => {
    const bad = { ...DEFAULT_STATE, shape: [0], chunkShape: [0] };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(bad));
    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.shape).toEqual(DEFAULT_STATE.shape);
    expect(result!.chunkShape).toEqual(DEFAULT_STATE.chunkShape);
  });

  it('falls back entirely to defaults when shape is not an array', () => {
    const bad = { ...DEFAULT_STATE, shape: 'nope' };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(bad));
    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.shape).toEqual(DEFAULT_STATE.shape);
  });

  it('clamps and pads wrong-length chunkShape to match shape', () => {
    // shape has 2 dims, chunkShape has 3 (too long) with an out-of-range value
    const bad = {
      ...DEFAULT_STATE,
      shape: [10, 8],
      chunkShape: [999, 4, 4],
    };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(bad));
    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.chunkShape).toEqual([10, 4]);
  });

  it('pads a too-short chunkShape with shape-sized defaults for missing dims', () => {
    const bad = {
      ...DEFAULT_STATE,
      shape: [10, 8, 6],
      chunkShape: [5],
    };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(bad));
    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.chunkShape).toEqual([5, 8, 6]);
  });

  it('replaces a non-array chunkShape with the shape itself', () => {
    const bad = { ...DEFAULT_STATE, shape: [12], chunkShape: null };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(bad));
    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.chunkShape).toEqual([12]);
  });
});

describe('loadState — variable validation', () => {
  it('drops invalid variable entries', () => {
    const good = makeVariable({ id: 'v1', name: 'temp' });
    const missingFields = { id: 'v2', name: 'bad' }; // no color/logicalType/typeAssignment
    const badDtype = makeVariable({ id: 'v3', name: 'weird', typeAssignment: { storageDtype: 'not-a-dtype' as never } });
    const state = {
      ...DEFAULT_STATE,
      variables: [good, missingFields, badDtype],
    };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(state));
    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.variables).toHaveLength(1);
    expect(result!.variables[0].id).toBe('v1');
  });

  it('falls back to default variables array when variables is not an array', () => {
    const state = { ...DEFAULT_STATE, variables: 'nope' };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(state));
    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.variables).toEqual(DEFAULT_STATE.variables);
  });
});

describe('loadState — pane stage range validation', () => {
  it('resets an out-of-range leftPaneStage to the default', () => {
    const state = { ...DEFAULT_STATE, ui: { ...DEFAULT_STATE.ui, leftPaneStage: 99 } };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(state));
    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.ui.leftPaneStage).toBe(DEFAULT_STATE.ui.leftPaneStage);
  });

  it('resets a negative leftPaneStage to the default', () => {
    const state = { ...DEFAULT_STATE, ui: { ...DEFAULT_STATE.ui, leftPaneStage: -5 } };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(state));
    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.ui.leftPaneStage).toBe(DEFAULT_STATE.ui.leftPaneStage);
  });

  it('keeps a valid rightPaneStage within 0..6', () => {
    const state = { ...DEFAULT_STATE, ui: { ...DEFAULT_STATE.ui, rightPaneStage: 4 } };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(state));
    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.ui.rightPaneStage).toBe(4);
  });

  it('preserves the -1 sentinel for rightPaneStage', () => {
    const state = { ...DEFAULT_STATE, ui: { ...DEFAULT_STATE.ui, rightPaneStage: -1 } };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(state));
    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.ui.rightPaneStage).toBe(-1);
  });

  it('resets an out-of-range rightPaneStage to the default', () => {
    const state = { ...DEFAULT_STATE, ui: { ...DEFAULT_STATE.ui, rightPaneStage: 42 } };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(state));
    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.ui.rightPaneStage).toBe(DEFAULT_STATE.ui.rightPaneStage);
  });
});

describe('loadState — fieldPipelines/chunkPipeline defaults', () => {
  it('falls back to the default fieldPipelines when the key is entirely missing', () => {
    const state: Record<string, unknown> = { ...DEFAULT_STATE };
    delete state.fieldPipelines;
    localStorage.setItem(TABULAR_KEY, JSON.stringify(state));
    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.fieldPipelines).toEqual(DEFAULT_STATE.fieldPipelines);
  });

  it('defaults fieldPipelines to an empty object when the persisted value is the wrong type', () => {
    const state: Record<string, unknown> = { ...DEFAULT_STATE, fieldPipelines: 'nope' };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(state));
    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.fieldPipelines).toEqual({});
  });

  it('drops non-array pipeline values for individual variable keys but keeps valid ones', () => {
    const state: Record<string, unknown> = {
      ...DEFAULT_STATE,
      fieldPipelines: { temperature: [{ codec: 'delta', params: { order: 1 } }], pressure: 'nope' },
    };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(state));
    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.fieldPipelines.temperature).toEqual([{ codec: 'delta', params: { order: 1 } }]);
    expect(result!.fieldPipelines.pressure).toEqual([]);
  });

  it('defaults chunkPipeline to an empty array when missing', () => {
    const state: Record<string, unknown> = { ...DEFAULT_STATE };
    delete state.chunkPipeline;
    localStorage.setItem(TABULAR_KEY, JSON.stringify(state));
    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.chunkPipeline).toEqual([]);
  });
});

describe('loadState — per-model storage keys', () => {
  it('loads tabular and array state independently', () => {
    const tabularState: AppState = { ...DEFAULT_STATE, dataModel: 'tabular', shape: [10] };
    const arrayState: AppState = { ...DEFAULT_STATE, dataModel: 'array', shape: [4, 4] };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(tabularState));
    localStorage.setItem(ARRAY_KEY, JSON.stringify(arrayState));

    const loadedTabular = loadState('tabular');
    const loadedArray = loadState('array');

    expect(loadedTabular).not.toBeNull();
    expect(loadedArray).not.toBeNull();
    expect(loadedTabular!.shape).toEqual([10]);
    expect(loadedArray!.shape).toEqual([4, 4]);
  });

  it('forces the returned state dataModel to the requested model key', () => {
    // Persisted under the tabular key but with a (corrupted/stale) array dataModel value.
    const state = { ...DEFAULT_STATE, dataModel: 'array' };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(state));
    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.dataModel).toBe('tabular');
  });

  it('saveState writes to the correct per-model key', () => {
    const state: AppState = { ...DEFAULT_STATE, dataModel: 'array', shape: [2, 2] };
    saveState(state);
    expect(localStorage.getItem(ARRAY_KEY)).not.toBeNull();
    expect(localStorage.getItem(TABULAR_KEY)).toBeNull();
    const loaded = loadState('array');
    expect(loaded!.shape).toEqual([2, 2]);
  });
});
