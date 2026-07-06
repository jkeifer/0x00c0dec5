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
    logicalType: { type: 'decimal', min: -50, max: 50, decimalPlaces: 1, generation: 'random' },
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

    // scale-offset / bitround steps stripped from pipelines. The v1 format
    // predates id-keyed fieldPipelines (D5, Phase 3.1), so the legacy
    // name-keyed entries ('temp'/'hum') are re-keyed to the matching
    // variable's id ('v1'/'v2') by the same load-time migration.
    expect(result!.fieldPipelines.v1).toEqual([{ codec: 'delta', params: { order: 1 } }]);
    expect(result!.fieldPipelines.v2).toEqual([]);
    expect(result!.fieldPipelines).not.toHaveProperty('temp');
    expect(result!.fieldPipelines).not.toHaveProperty('hum');
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

  // Phase 2 tasks 2.3/2.13 (D1/D3): a save from before these fields existed
  // (or one that simply omits them) must default-merge cleanly rather than
  // leaving `write.footerLocator`/`metadata.includeChunkIndex` undefined.
  it('fills in missing write.footerLocator and metadata.includeChunkIndex with defaults', () => {
    const partial = {
      dataModel: 'tabular',
      shape: [16],
      chunkShape: [16],
      interleaving: 'column',
      variables: DEFAULT_STATE.variables,
      fieldPipelines: DEFAULT_STATE.fieldPipelines,
      chunkPipeline: [],
      metadata: {
        customEntries: [],
        serialization: 'json',
        // includeChunkIndex intentionally omitted
      },
      write: {
        magicNumber: 'DEADBEEF',
        partitioning: 'single',
        metadataPlacement: 'footer',
        chunkOrder: 'row-major',
        includeMetadata: true,
        // footerLocator intentionally omitted
      },
      ui: DEFAULT_STATE.ui,
    };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(partial));

    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.write.footerLocator).toBe(DEFAULT_STATE.write.footerLocator);
    expect(result!.write.footerLocator).toBe('trailer');
    expect(result!.metadata.includeChunkIndex).toBe(DEFAULT_STATE.metadata.includeChunkIndex);
    expect(result!.metadata.includeChunkIndex).toBe(true);
    // Sibling fields still preserved through the merge.
    expect(result!.write.magicNumber).toBe('DEADBEEF');
    expect(result!.write.metadataPlacement).toBe('footer');
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

// D9 (Phase 6.1): logicalType.generation postdates the field's introduction —
// persisted variables from before it existed have no `generation` key at all
// (and a hand-edited save could have an invalid one). Neither case should
// reject the variable outright (isValidVariable doesn't check this field);
// both should default the field to 'random', the pre-D9 behavior.
describe('loadState — generation mode migration (D9)', () => {
  it('defaults a variable with no logicalType.generation field to "random"', () => {
    const legacyVar = makeVariable({ id: 'v1', name: 'temp' });
    // Simulate a pre-D9 save: strip the field entirely.
    const logicalTypeWithoutGeneration = { ...legacyVar.logicalType } as Record<string, unknown>;
    delete logicalTypeWithoutGeneration.generation;
    const raw = {
      ...DEFAULT_STATE,
      variables: [{ ...legacyVar, logicalType: logicalTypeWithoutGeneration }],
    };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(raw));
    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.variables).toHaveLength(1);
    expect(result!.variables[0].logicalType.generation).toBe('random');
  });

  it('defaults a variable with an invalid logicalType.generation value to "random"', () => {
    const badVar = makeVariable({
      id: 'v1',
      name: 'temp',
      logicalType: { ...makeVariable().logicalType, generation: 'not-a-mode' as never },
    });
    const raw = { ...DEFAULT_STATE, variables: [badVar] };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(raw));
    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.variables[0].logicalType.generation).toBe('random');
  });

  it('preserves a valid non-default generation mode across load', () => {
    const sortedVar = makeVariable({
      id: 'v1',
      name: 'temp',
      logicalType: { ...makeVariable().logicalType, generation: 'sorted' },
    });
    const raw = { ...DEFAULT_STATE, variables: [sortedVar] };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(raw));
    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.variables[0].logicalType.generation).toBe('sorted');
  });

  it('does not drop the variable just because generation is missing', () => {
    const legacyVar = makeVariable({ id: 'v1', name: 'temp' });
    const logicalTypeWithoutGeneration = { ...legacyVar.logicalType } as Record<string, unknown>;
    delete logicalTypeWithoutGeneration.generation;
    const raw = {
      ...DEFAULT_STATE,
      variables: [{ ...legacyVar, logicalType: logicalTypeWithoutGeneration }],
    };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(raw));
    const result = loadState('tabular');
    expect(result!.variables).toHaveLength(1);
    expect(result!.variables[0].id).toBe('v1');
  });
});

// D5 (Phase 3.8): ui.leftPaneStage / ui.rightPaneStage are StageName values,
// not numeric indices. STAGE_ORDER = ['values', 'typed', 'linearized',
// 'encoded', 'metadata', 'write', 'read']. Old persisted numeric indices
// (0..6) migrate positionally via STAGE_ORDER; the old -1 sentinel maps to
// 'write'; anything else invalid/unrecognized falls back to the default
// ('values' for left, 'write' for right per D5 — fixes SW-2's stale default).
describe('loadState — pane stage migration (index -> name, D5)', () => {
  const STAGE_ORDER = ['values', 'typed', 'linearized', 'encoded', 'metadata', 'write', 'read'];

  it.each(STAGE_ORDER.map((name, i) => [i, name] as const))(
    'migrates old numeric leftPaneStage %i to %s',
    (index, name) => {
      const state = { ...DEFAULT_STATE, ui: { ...DEFAULT_STATE.ui, leftPaneStage: index } };
      localStorage.setItem(TABULAR_KEY, JSON.stringify(state));
      const result = loadState('tabular');
      expect(result).not.toBeNull();
      expect(result!.ui.leftPaneStage).toBe(name);
    },
  );

  it.each(STAGE_ORDER.map((name, i) => [i, name] as const))(
    'migrates old numeric rightPaneStage %i to %s',
    (index, name) => {
      const state = { ...DEFAULT_STATE, ui: { ...DEFAULT_STATE.ui, rightPaneStage: index } };
      localStorage.setItem(TABULAR_KEY, JSON.stringify(state));
      const result = loadState('tabular');
      expect(result).not.toBeNull();
      expect(result!.ui.rightPaneStage).toBe(name);
    },
  );

  it('migrates the old -1 sentinel to "write" for leftPaneStage', () => {
    const state = { ...DEFAULT_STATE, ui: { ...DEFAULT_STATE.ui, leftPaneStage: -1 } };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(state));
    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.ui.leftPaneStage).toBe('write');
  });

  it('migrates the old -1 sentinel to "write" for rightPaneStage', () => {
    const state = { ...DEFAULT_STATE, ui: { ...DEFAULT_STATE.ui, rightPaneStage: -1 } };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(state));
    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.ui.rightPaneStage).toBe('write');
  });

  it('falls back to the default ("values") for an out-of-range numeric leftPaneStage', () => {
    const state = { ...DEFAULT_STATE, ui: { ...DEFAULT_STATE.ui, leftPaneStage: 99 } };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(state));
    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.ui.leftPaneStage).toBe('values');
  });

  it('falls back to the default ("values") for a negative (non-sentinel) leftPaneStage', () => {
    const state = { ...DEFAULT_STATE, ui: { ...DEFAULT_STATE.ui, leftPaneStage: -5 } };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(state));
    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.ui.leftPaneStage).toBe('values');
  });

  it('falls back to the default ("write") for an out-of-range numeric rightPaneStage', () => {
    const state = { ...DEFAULT_STATE, ui: { ...DEFAULT_STATE.ui, rightPaneStage: 42 } };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(state));
    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.ui.rightPaneStage).toBe('write');
  });

  it('keeps a valid stage-name leftPaneStage unchanged', () => {
    const state = { ...DEFAULT_STATE, ui: { ...DEFAULT_STATE.ui, leftPaneStage: 'encoded' } };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(state));
    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.ui.leftPaneStage).toBe('encoded');
  });

  it('keeps a valid stage-name rightPaneStage unchanged', () => {
    const state = { ...DEFAULT_STATE, ui: { ...DEFAULT_STATE.ui, rightPaneStage: 'read' } };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(state));
    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.ui.rightPaneStage).toBe('read');
  });

  it('falls back to the default for an unrecognized string leftPaneStage', () => {
    const state = { ...DEFAULT_STATE, ui: { ...DEFAULT_STATE.ui, leftPaneStage: 'not-a-stage' } };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(state));
    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.ui.leftPaneStage).toBe('values');
  });

  it('falls back to the default for an unrecognized string rightPaneStage', () => {
    const state = { ...DEFAULT_STATE, ui: { ...DEFAULT_STATE.ui, rightPaneStage: 'not-a-stage' } };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(state));
    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.ui.rightPaneStage).toBe('write');
  });

  it('falls back to the default for a non-string, non-integer leftPaneStage', () => {
    const state = { ...DEFAULT_STATE, ui: { ...DEFAULT_STATE.ui, leftPaneStage: 4.5 } };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(state));
    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.ui.leftPaneStage).toBe('values');
  });

  it('falls back to the default for a null rightPaneStage', () => {
    const state = { ...DEFAULT_STATE, ui: { ...DEFAULT_STATE.ui, rightPaneStage: null } };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(state));
    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.ui.rightPaneStage).toBe('write');
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

  // D5 (Phase 3.1): fieldPipelines is keyed by Variable.id. A persisted save
  // whose keys are variable NAMEs (e.g. from before this migration, or a
  // hand-edited/legacy save) must be re-keyed to the matching variable's id;
  // keys matching neither a name nor an id are dropped.
  it('re-keys a legacy name-keyed fieldPipelines entry to the matching variable id', () => {
    const state: Record<string, unknown> = {
      ...DEFAULT_STATE,
      variables: [makeVariable({ id: 'v1', name: 'temp' })],
      fieldPipelines: { temp: [{ codec: 'delta', params: { order: 1 } }] },
    };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(state));
    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.fieldPipelines.v1).toEqual([{ codec: 'delta', params: { order: 1 } }]);
    expect(result!.fieldPipelines).not.toHaveProperty('temp');
  });

  it('drops a fieldPipelines key matching neither a variable id nor a variable name', () => {
    const state: Record<string, unknown> = {
      ...DEFAULT_STATE,
      variables: [makeVariable({ id: 'v1', name: 'temp' })],
      fieldPipelines: { v1: [], orphaned: [{ codec: 'rle', params: {} }] },
    };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(state));
    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.fieldPipelines).not.toHaveProperty('orphaned');
    expect(result!.fieldPipelines.v1).toEqual([]);
  });

  it('an id-keyed entry wins over a same-named legacy entry when both are present', () => {
    const state: Record<string, unknown> = {
      ...DEFAULT_STATE,
      variables: [makeVariable({ id: 'v1', name: 'temp' })],
      fieldPipelines: {
        v1: [{ codec: 'rle', params: {} }],
        temp: [{ codec: 'delta', params: { order: 1 } }],
      },
    };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(state));
    const result = loadState('tabular');
    expect(result).not.toBeNull();
    expect(result!.fieldPipelines.v1).toEqual([{ codec: 'rle', params: {} }]);
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

// ─── Round trip from the current DEFAULT_STATE ────────────────────────

describe('loadState — round trip from DEFAULT_STATE', () => {
  it('a save of DEFAULT_STATE loads back deep-equal', () => {
    saveState(DEFAULT_STATE);
    const loaded = loadState('tabular');
    expect(loaded).not.toBeNull();
    expect(loaded).toEqual(DEFAULT_STATE);
  });
});

// ─── Shared mutable references with DEFAULT_STATE ─────────────────────
//
// loadState should always return data structures independent of DEFAULT_STATE,
// so that a caller mutating the loaded state (as the app does via immer-free
// direct mutation in some places, or simply by accident) can never corrupt the
// shared defaults object for the rest of the session.

describe('loadState — must not share mutable references with DEFAULT_STATE', () => {
  it('mutating the variables array of a normal round-trip load leaves DEFAULT_STATE untouched', () => {
    saveState(DEFAULT_STATE);
    const loaded = loadState('tabular');
    expect(loaded).not.toBeNull();
    const defaultLengthBefore = DEFAULT_STATE.variables.length;
    loaded!.variables.push(makeVariable({ id: 'zzz', name: 'zzz' }));
    expect(DEFAULT_STATE.variables.length).toBe(defaultLengthBefore);
  });

  // Regression for finding NF-1 (fixed in Phase 1): loadState fallback paths must
  // never return arrays/objects aliased with DEFAULT_STATE itself — mutation of a
  // loaded state would otherwise corrupt the app's defaults for the session.
  it('invalid-shape fallback does not alias DEFAULT_STATE.variables', () => {
    const bad = { ...DEFAULT_STATE, shape: [0] };
    localStorage.setItem(TABULAR_KEY, JSON.stringify(bad));
    const loaded = loadState('tabular');
    expect(loaded).not.toBeNull();
    const defaultLengthBefore = DEFAULT_STATE.variables.length;
    loaded!.variables.push(makeVariable({ id: 'zzz', name: 'zzz' }));
    expect(DEFAULT_STATE.variables.length).toBe(defaultLengthBefore);
  });

  // Regression for finding NF-1 (fixed in Phase 1): merge fallbacks must clone
  // default-derived values, including open-ended dict entries like fieldPipelines.
  it('missing-fieldPipelines merge does not alias DEFAULT_STATE.fieldPipelines arrays', () => {
    const partial: Record<string, unknown> = { ...DEFAULT_STATE };
    delete partial.fieldPipelines;
    localStorage.setItem(TABULAR_KEY, JSON.stringify(partial));
    const loaded = loadState('tabular');
    expect(loaded).not.toBeNull();
    const before = [...DEFAULT_STATE.fieldPipelines.temperature];
    loaded!.fieldPipelines.temperature.push({ codec: 'delta', params: { order: 1 } });
    expect(DEFAULT_STATE.fieldPipelines.temperature).toEqual(before);
  });
});

describe('text variable normalization', () => {
  function makeTextVariable(overrides: Record<string, unknown> = {}): Variable {
    return {
      id: 'city', name: 'city', color: '#61afef',
      logicalType: { type: 'text', min: 0, max: 0, wordSet: 'cities', generation: 'stepped' },
      typeAssignment: { storageDtype: 'char8' },
      ...overrides,
    } as Variable;
  }

  it('accepts a well-formed text variable (charN passes registry-derived DTYPE_KEYS)', () => {
    localStorage.setItem(TABULAR_KEY, JSON.stringify({ ...DEFAULT_STATE, variables: [makeTextVariable()] }));
    const loaded = loadState('tabular')!;
    expect(loaded.variables.length).toBe(1);
    expect(loaded.variables[0].logicalType.type).toBe('text');
    expect(loaded.variables[0].logicalType.wordSet).toBe('cities');
    expect(loaded.variables[0].typeAssignment.storageDtype).toBe('char8');
  });

  it('defaults a missing wordSet to names', () => {
    const v = makeTextVariable();
    delete (v.logicalType as unknown as Record<string, unknown>).wordSet;
    localStorage.setItem(TABULAR_KEY, JSON.stringify({ ...DEFAULT_STATE, variables: [v] }));
    const loaded = loadState('tabular')!;
    expect(loaded.variables[0].logicalType.wordSet).toBe('names');
  });

  it('defaults an unrecognized wordSet to names', () => {
    const v = makeTextVariable();
    (v.logicalType as unknown as Record<string, unknown>).wordSet = 'planets';
    localStorage.setItem(TABULAR_KEY, JSON.stringify({ ...DEFAULT_STATE, variables: [v] }));
    const loaded = loadState('tabular')!;
    expect(loaded.variables[0].logicalType.wordSet).toBe('names');
  });

  it('coerces a numeric storageDtype on a text variable to char8', () => {
    const v = makeTextVariable({ typeAssignment: { storageDtype: 'float32' } });
    localStorage.setItem(TABULAR_KEY, JSON.stringify({ ...DEFAULT_STATE, variables: [v] }));
    const loaded = loadState('tabular')!;
    expect(loaded.variables[0].typeAssignment.storageDtype).toBe('char8');
  });

  it('leaves numeric variables untouched by text normalization', () => {
    localStorage.setItem(TABULAR_KEY, JSON.stringify({ ...DEFAULT_STATE, variables: [makeVariable()] }));
    const loaded = loadState('tabular')!;
    expect(loaded.variables[0].typeAssignment.storageDtype).toBe('float32');
    expect((loaded.variables[0].logicalType as unknown as Record<string, unknown>).wordSet).toBeUndefined();
  });
});
