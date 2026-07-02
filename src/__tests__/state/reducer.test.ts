import { describe, it, expect, beforeEach } from 'vitest';
import { reducer } from '../../state/useAppState.ts';
import { DEFAULT_STATE, type AppState, type Variable } from '../../types/state.ts';
import type { CodecStep } from '../../types/codecs.ts';

/** Minimal Map-backed localStorage mock — the vitest node environment has no localStorage.
 * (Mirrors the mock in persistence.test.ts — SET_DATA_MODEL calls saveState/loadState
 * directly inside the reducer, see finding SW-4.) */
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

function makeState(overrides: Partial<AppState> = {}): AppState {
  return { ...DEFAULT_STATE, ...overrides };
}

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

// ─── SET_SHAPE ─────────────────────────────────────────────────────

describe('SET_SHAPE', () => {
  it('updates shape with same dimensionality', () => {
    const state = makeState({ shape: [32], chunkShape: [16] });
    const result = reducer(state, { type: 'SET_SHAPE', shape: [64] });
    expect(result.shape).toEqual([64]);
    expect(result.chunkShape).toEqual([16]);
  });

  it('clamps chunkShape to new smaller shape', () => {
    const state = makeState({ shape: [32], chunkShape: [32] });
    const result = reducer(state, { type: 'SET_SHAPE', shape: [16] });
    expect(result.shape).toEqual([16]);
    expect(result.chunkShape).toEqual([16]);
  });

  it('adds dimension with default chunk size', () => {
    const state = makeState({ shape: [32], chunkShape: [16] });
    const result = reducer(state, { type: 'SET_SHAPE', shape: [32, 8] });
    expect(result.shape).toEqual([32, 8]);
    expect(result.chunkShape).toEqual([16, 8]);
  });

  it('removes dimension by truncating chunkShape', () => {
    const state = makeState({ shape: [32, 16], chunkShape: [8, 4] });
    const result = reducer(state, { type: 'SET_SHAPE', shape: [32] });
    expect(result.shape).toEqual([32]);
    expect(result.chunkShape).toEqual([8]);
  });

  it('clamps existing dims and pads new dims', () => {
    const state = makeState({ shape: [32, 16], chunkShape: [32, 16] });
    const result = reducer(state, { type: 'SET_SHAPE', shape: [10, 8, 4] });
    expect(result.shape).toEqual([10, 8, 4]);
    expect(result.chunkShape).toEqual([10, 8, 4]);
  });
});

// ─── ADD_VARIABLE ──────────────────────────────────────────────────

describe('ADD_VARIABLE', () => {
  it('adds a variable and creates empty field pipeline', () => {
    const state = makeState({ variables: [], fieldPipelines: {} });
    const v = makeVariable({ id: 'v1', name: 'temp' });
    const result = reducer(state, { type: 'ADD_VARIABLE', variable: v });
    expect(result.variables).toHaveLength(1);
    expect(result.variables[0]).toEqual(v);
    expect(result.fieldPipelines['temp']).toEqual([]);
  });

  it('appends to existing variables', () => {
    const v1 = makeVariable({ id: 'v1', name: 'temp' });
    const state = makeState({
      variables: [v1],
      fieldPipelines: { temp: [] },
    });
    const v2 = makeVariable({ id: 'v2', name: 'pressure', color: '#61afef' });
    const result = reducer(state, { type: 'ADD_VARIABLE', variable: v2 });
    expect(result.variables).toHaveLength(2);
    expect(result.fieldPipelines['pressure']).toEqual([]);
  });

  // KNOWN BUG SW-1 — flip when Phase 3.1 lands (id-keyed pipelines)
  it.fails('adding a variable whose name collides with an existing one preserves the existing pipeline', () => {
    const existingSteps: CodecStep[] = [{ codec: 'delta', params: { order: 1 } }];
    const v1 = makeVariable({ id: 'v1', name: 'temp' });
    const state = makeState({
      variables: [v1],
      fieldPipelines: { temp: existingSteps },
    });
    // A second variable with a different id but the SAME name.
    const v2 = makeVariable({ id: 'v2', name: 'temp', color: '#61afef' });
    const result = reducer(state, { type: 'ADD_VARIABLE', variable: v2 });
    expect(result.variables).toHaveLength(2);
    // fieldPipelines is keyed by name, so the new variable's empty pipeline
    // clobbers the existing one under the shared 'temp' key.
    expect(result.fieldPipelines['temp']).toEqual(existingSteps);
  });
});

// ─── REMOVE_VARIABLE ───────────────────────────────────────────────

describe('REMOVE_VARIABLE', () => {
  it('removes variable and its field pipeline', () => {
    const v1 = makeVariable({ id: 'v1', name: 'temp' });
    const v2 = makeVariable({ id: 'v2', name: 'pressure' });
    const state = makeState({
      variables: [v1, v2],
      fieldPipelines: { temp: [], pressure: [] },
    });
    const result = reducer(state, { type: 'REMOVE_VARIABLE', id: 'v1' });
    expect(result.variables).toHaveLength(1);
    expect(result.variables[0].name).toBe('pressure');
    expect(result.fieldPipelines).not.toHaveProperty('temp');
    expect(result.fieldPipelines).toHaveProperty('pressure');
  });

  it('does nothing for unknown id', () => {
    const state = makeState();
    const result = reducer(state, { type: 'REMOVE_VARIABLE', id: 'nonexistent' });
    expect(result.variables).toEqual(state.variables);
  });
});

// ─── UPDATE_VARIABLE ───────────────────────────────────────────────

describe('UPDATE_VARIABLE', () => {
  it('updates typeAssignment only', () => {
    const v = makeVariable({ id: 'v1', name: 'temp' });
    const state = makeState({ variables: [v], fieldPipelines: { temp: [] } });
    const result = reducer(state, {
      type: 'UPDATE_VARIABLE',
      id: 'v1',
      changes: { typeAssignment: { storageDtype: 'int16' } },
    });
    expect(result.variables[0].typeAssignment.storageDtype).toBe('int16');
    expect(result.variables[0].name).toBe('temp');
  });

  it('updates logicalType only', () => {
    const v = makeVariable({ id: 'v1', name: 'temp' });
    const state = makeState({ variables: [v], fieldPipelines: { temp: [] } });
    const result = reducer(state, {
      type: 'UPDATE_VARIABLE',
      id: 'v1',
      changes: { logicalType: { type: 'integer', min: 0, max: 100 } },
    });
    expect(result.variables[0].logicalType.type).toBe('integer');
    expect(result.variables[0].name).toBe('temp');
  });

  it('updates name and re-keys fieldPipelines', () => {
    const steps: CodecStep[] = [{ codec: 'delta', params: { order: 1 } }];
    const v = makeVariable({ id: 'v1', name: 'temp' });
    const state = makeState({
      variables: [v],
      fieldPipelines: { temp: steps },
    });
    const result = reducer(state, {
      type: 'UPDATE_VARIABLE',
      id: 'v1',
      changes: { name: 'temperature' },
    });
    expect(result.variables[0].name).toBe('temperature');
    expect(result.fieldPipelines).not.toHaveProperty('temp');
    expect(result.fieldPipelines['temperature']).toEqual(steps);
  });

  it('does nothing for unknown id', () => {
    const state = makeState();
    const result = reducer(state, {
      type: 'UPDATE_VARIABLE',
      id: 'nonexistent',
      changes: { name: 'x' },
    });
    expect(result).toBe(state);
  });

  // KNOWN BUG SW-1 — flip when Phase 3.1 lands (id-keyed pipelines)
  it.fails('renaming a variable to another variable\'s name preserves the target\'s pipeline', () => {
    const a = makeVariable({ id: 'a', name: 'alpha' });
    const b = makeVariable({ id: 'b', name: 'beta', color: '#61afef' });
    const bSteps: CodecStep[] = [{ codec: 'rle', params: {} }];
    const state = makeState({
      variables: [a, b],
      fieldPipelines: { alpha: [], beta: bSteps },
    });
    const result = reducer(state, {
      type: 'UPDATE_VARIABLE',
      id: 'a',
      changes: { name: 'beta' },
    });
    expect(result.variables.find((v) => v.id === 'a')!.name).toBe('beta');
    // Renaming 'alpha' -> 'beta' re-keys fieldPipelines['alpha'] into
    // fieldPipelines['beta'], clobbering b's existing rle pipeline.
    expect(result.fieldPipelines['beta']).toEqual(bSteps);
  });

  // KNOWN BUG SW-1 — flip when Phase 3.1 lands (id-keyed pipelines)
  it.fails('renaming away after a collision does not resurrect or lose the collided-with pipeline', () => {
    const a = makeVariable({ id: 'a', name: 'alpha' });
    const b = makeVariable({ id: 'b', name: 'beta', color: '#61afef' });
    const bSteps: CodecStep[] = [{ codec: 'rle', params: {} }];
    const state = makeState({
      variables: [a, b],
      fieldPipelines: { alpha: [], beta: bSteps },
    });
    // First, collide: rename a -> 'beta' (clobbers b's pipeline under the shared key).
    const collided = reducer(state, {
      type: 'UPDATE_VARIABLE',
      id: 'a',
      changes: { name: 'beta' },
    });
    // Then rename a away again to something else entirely.
    const result = reducer(collided, {
      type: 'UPDATE_VARIABLE',
      id: 'a',
      changes: { name: 'gamma' },
    });
    expect(result.variables.find((v) => v.id === 'a')!.name).toBe('gamma');
    // b's pipeline should have survived the whole collide/uncollide sequence.
    expect(result.fieldPipelines['beta']).toEqual(bSteps);
  });
});

// ─── SET_CHUNK_SHAPE ───────────────────────────────────────────────

describe('SET_CHUNK_SHAPE', () => {
  it('sets chunk shape', () => {
    const state = makeState({ shape: [32], chunkShape: [32] });
    const result = reducer(state, { type: 'SET_CHUNK_SHAPE', chunkShape: [8] });
    expect(result.chunkShape).toEqual([8]);
  });

  it('clamps a chunk dim larger than the shape dim', () => {
    const state = makeState({ shape: [32], chunkShape: [32] });
    const result = reducer(state, { type: 'SET_CHUNK_SHAPE', chunkShape: [999] });
    expect(result.chunkShape).toEqual([32]);
  });

  it('clamps per-dimension in a multi-dim shape', () => {
    const state = makeState({ shape: [10, 8], chunkShape: [10, 8] });
    const result = reducer(state, { type: 'SET_CHUNK_SHAPE', chunkShape: [999, 3] });
    expect(result.chunkShape).toEqual([10, 3]);
  });

  it('rejects an empty chunk shape', () => {
    const state = makeState({ shape: [32], chunkShape: [16] });
    const result = reducer(state, { type: 'SET_CHUNK_SHAPE', chunkShape: [] });
    expect(result).toBe(state);
  });

  it('rejects a zero chunk dim', () => {
    const state = makeState({ shape: [32], chunkShape: [16] });
    const result = reducer(state, { type: 'SET_CHUNK_SHAPE', chunkShape: [0] });
    expect(result).toBe(state);
  });

  it('rejects a negative chunk dim', () => {
    const state = makeState({ shape: [32], chunkShape: [16] });
    const result = reducer(state, { type: 'SET_CHUNK_SHAPE', chunkShape: [-4] });
    expect(result).toBe(state);
  });

  it('rejects a non-integer chunk dim', () => {
    const state = makeState({ shape: [32], chunkShape: [16] });
    const result = reducer(state, { type: 'SET_CHUNK_SHAPE', chunkShape: [4.5] });
    expect(result).toBe(state);
  });

  it('rejects a chunk shape whose length differs from shape length', () => {
    const state = makeState({ shape: [10, 8], chunkShape: [10, 8] });
    const result = reducer(state, { type: 'SET_CHUNK_SHAPE', chunkShape: [4] });
    expect(result).toBe(state);
  });
});

// ─── SET_INTERLEAVING ──────────────────────────────────────────────

describe('SET_INTERLEAVING', () => {
  it('sets interleaving to row', () => {
    const state = makeState({ interleaving: 'column' });
    const result = reducer(state, { type: 'SET_INTERLEAVING', interleaving: 'row' });
    expect(result.interleaving).toBe('row');
  });

  it('sets interleaving to column', () => {
    const state = makeState({ interleaving: 'row' });
    const result = reducer(state, { type: 'SET_INTERLEAVING', interleaving: 'column' });
    expect(result.interleaving).toBe('column');
  });
});

// ─── SET_FIELD_PIPELINE ────────────────────────────────────────────

describe('SET_FIELD_PIPELINE', () => {
  it('sets pipeline for a variable', () => {
    const state = makeState({ fieldPipelines: { temp: [] } });
    const steps: CodecStep[] = [
      { codec: 'delta', params: { order: 1 } },
    ];
    const result = reducer(state, {
      type: 'SET_FIELD_PIPELINE',
      variableName: 'temp',
      steps,
    });
    expect(result.fieldPipelines['temp']).toEqual(steps);
  });
});

// ─── SET_CHUNK_PIPELINE ────────────────────────────────────────────

describe('SET_CHUNK_PIPELINE', () => {
  it('sets chunk pipeline', () => {
    const state = makeState({ chunkPipeline: [] });
    const steps: CodecStep[] = [{ codec: 'rle', params: {} }];
    const result = reducer(state, { type: 'SET_CHUNK_PIPELINE', steps });
    expect(result.chunkPipeline).toEqual(steps);
  });
});

// ─── Metadata actions ──────────────────────────────────────────────

describe('SET_METADATA_SERIALIZATION', () => {
  it('sets serialization to binary', () => {
    const state = makeState();
    const result = reducer(state, { type: 'SET_METADATA_SERIALIZATION', serialization: 'binary' });
    expect(result.metadata.serialization).toBe('binary');
  });

  it('sets serialization to json', () => {
    const state = makeState({
      metadata: { customEntries: [], serialization: 'binary', includeChunkIndex: true },
    });
    const result = reducer(state, { type: 'SET_METADATA_SERIALIZATION', serialization: 'json' });
    expect(result.metadata.serialization).toBe('json');
  });
});

describe('ADD_METADATA_ENTRY', () => {
  it('adds an empty entry', () => {
    const state = makeState();
    const result = reducer(state, { type: 'ADD_METADATA_ENTRY' });
    expect(result.metadata.customEntries).toHaveLength(1);
    expect(result.metadata.customEntries[0]).toEqual({ key: '', value: '' });
  });

  it('appends to existing entries', () => {
    const state = makeState({
      metadata: {
        customEntries: [{ key: 'a', value: 'b' }],
        serialization: 'json',
        includeChunkIndex: true,
      },
    });
    const result = reducer(state, { type: 'ADD_METADATA_ENTRY' });
    expect(result.metadata.customEntries).toHaveLength(2);
  });
});

describe('REMOVE_METADATA_ENTRY', () => {
  it('removes entry at index', () => {
    const state = makeState({
      metadata: {
        customEntries: [
          { key: 'a', value: '1' },
          { key: 'b', value: '2' },
        ],
        serialization: 'json',
        includeChunkIndex: true,
      },
    });
    const result = reducer(state, { type: 'REMOVE_METADATA_ENTRY', index: 0 });
    expect(result.metadata.customEntries).toHaveLength(1);
    expect(result.metadata.customEntries[0].key).toBe('b');
  });
});

describe('UPDATE_METADATA_ENTRY', () => {
  it('updates key only', () => {
    const state = makeState({
      metadata: {
        customEntries: [{ key: '', value: 'v' }],
        serialization: 'json',
        includeChunkIndex: true,
      },
    });
    const result = reducer(state, { type: 'UPDATE_METADATA_ENTRY', index: 0, key: 'mykey' });
    expect(result.metadata.customEntries[0].key).toBe('mykey');
    expect(result.metadata.customEntries[0].value).toBe('v');
  });

  it('updates value only', () => {
    const state = makeState({
      metadata: {
        customEntries: [{ key: 'k', value: '' }],
        serialization: 'json',
        includeChunkIndex: true,
      },
    });
    const result = reducer(state, { type: 'UPDATE_METADATA_ENTRY', index: 0, value: 'myval' });
    expect(result.metadata.customEntries[0].key).toBe('k');
    expect(result.metadata.customEntries[0].value).toBe('myval');
  });

  it('updates both key and value', () => {
    const state = makeState({
      metadata: {
        customEntries: [{ key: '', value: '' }],
        serialization: 'json',
        includeChunkIndex: true,
      },
    });
    const result = reducer(state, {
      type: 'UPDATE_METADATA_ENTRY',
      index: 0,
      key: 'foo',
      value: 'bar',
    });
    expect(result.metadata.customEntries[0]).toEqual({ key: 'foo', value: 'bar' });
  });

  it('does nothing for out-of-range index', () => {
    const state = makeState();
    const result = reducer(state, { type: 'UPDATE_METADATA_ENTRY', index: 99, key: 'x' });
    expect(result.metadata.customEntries).toEqual(state.metadata.customEntries);
  });
});

// ─── SET_INCLUDE_CHUNK_INDEX (D3) ───────────────────────────────────

describe('SET_INCLUDE_CHUNK_INDEX', () => {
  it('sets includeChunkIndex to false', () => {
    const state = makeState();
    const result = reducer(state, { type: 'SET_INCLUDE_CHUNK_INDEX', includeChunkIndex: false });
    expect(result.metadata.includeChunkIndex).toBe(false);
  });

  it('sets includeChunkIndex back to true', () => {
    const state = makeState({
      metadata: { ...DEFAULT_STATE.metadata, includeChunkIndex: false },
    });
    const result = reducer(state, { type: 'SET_INCLUDE_CHUNK_INDEX', includeChunkIndex: true });
    expect(result.metadata.includeChunkIndex).toBe(true);
  });
});

// ─── Write actions ─────────────────────────────────────────────────

describe('SET_WRITE_MAGIC', () => {
  it('sets magic number', () => {
    const state = makeState();
    const result = reducer(state, { type: 'SET_WRITE_MAGIC', magicNumber: 'DEADBEEF' });
    expect(result.write.magicNumber).toBe('DEADBEEF');
  });
});

describe('SET_WRITE_PARTITIONING', () => {
  it('sets partitioning', () => {
    const state = makeState();
    const result = reducer(state, { type: 'SET_WRITE_PARTITIONING', partitioning: 'per-chunk' });
    expect(result.write.partitioning).toBe('per-chunk');
  });
});

describe('SET_WRITE_METADATA_PLACEMENT', () => {
  it('sets metadata placement', () => {
    const state = makeState();
    const result = reducer(state, { type: 'SET_WRITE_METADATA_PLACEMENT', metadataPlacement: 'footer' });
    expect(result.write.metadataPlacement).toBe('footer');
  });

  it('sets sidecar placement', () => {
    const state = makeState();
    const result = reducer(state, { type: 'SET_WRITE_METADATA_PLACEMENT', metadataPlacement: 'sidecar' });
    expect(result.write.metadataPlacement).toBe('sidecar');
  });
});

describe('SET_WRITE_CHUNK_ORDER', () => {
  it('sets chunk order', () => {
    const state = makeState();
    const result = reducer(state, { type: 'SET_WRITE_CHUNK_ORDER', chunkOrder: 'column-major' });
    expect(result.write.chunkOrder).toBe('column-major');
  });
});

// ─── SET_WRITE_FOOTER_LOCATOR (D1) ─────────────────────────────────

describe('SET_WRITE_FOOTER_LOCATOR', () => {
  it('sets footerLocator to "none"', () => {
    const state = makeState();
    const result = reducer(state, { type: 'SET_WRITE_FOOTER_LOCATOR', footerLocator: 'none' });
    expect(result.write.footerLocator).toBe('none');
  });

  it('sets footerLocator back to "trailer"', () => {
    const state = makeState({
      write: { ...DEFAULT_STATE.write, footerLocator: 'none' },
    });
    const result = reducer(state, { type: 'SET_WRITE_FOOTER_LOCATOR', footerLocator: 'trailer' });
    expect(result.write.footerLocator).toBe('trailer');
  });
});

// ─── SET_WRITE_INCLUDE_METADATA ───────────────────────────────────

describe('SET_WRITE_INCLUDE_METADATA', () => {
  it('sets includeMetadata to true', () => {
    const state = makeState();
    const result = reducer(state, { type: 'SET_WRITE_INCLUDE_METADATA', includeMetadata: true });
    expect(result.write.includeMetadata).toBe(true);
  });

  it('sets includeMetadata to false', () => {
    const state = makeState({
      write: { ...DEFAULT_STATE.write, includeMetadata: true },
    });
    const result = reducer(state, { type: 'SET_WRITE_INCLUDE_METADATA', includeMetadata: false });
    expect(result.write.includeMetadata).toBe(false);
  });
});

// ─── SET_SHOW_DIFF ─────────────────────────────────────────────────

describe('SET_SHOW_DIFF', () => {
  it('sets showDiff to true', () => {
    const state = makeState();
    const result = reducer(state, { type: 'SET_SHOW_DIFF', showDiff: true });
    expect(result.ui.showDiff).toBe(true);
  });

  it('sets showDiff to false', () => {
    const state = makeState({
      ui: { ...DEFAULT_STATE.ui, showDiff: true },
    });
    const result = reducer(state, { type: 'SET_SHOW_DIFF', showDiff: false });
    expect(result.ui.showDiff).toBe(false);
  });
});

// ─── SET_DATA_MODEL ────────────────────────────────────────────────
//
// SET_DATA_MODEL performs localStorage I/O (saveState/loadState) directly
// inside the reducer body — finding SW-4, a known design smell (reducers
// should be pure). These tests document/verify the CURRENT behavior, not
// endorse the pattern; localStorage is stubbed the same way persistence.test.ts
// does it.

describe('SET_DATA_MODEL', () => {
  it('is a no-op when switching to the already-active model', () => {
    const state = makeState({ dataModel: 'tabular' });
    const result = reducer(state, { type: 'SET_DATA_MODEL', model: 'tabular' });
    expect(result).toBe(state);
    // No save should have happened for a no-op switch.
    expect(localStorage.getItem(TABULAR_KEY)).toBeNull();
  });

  it('saves the current state under the OLD model key when switching', () => {
    const state = makeState({ dataModel: 'tabular', shape: [99] });
    reducer(state, { type: 'SET_DATA_MODEL', model: 'array' });
    const saved = localStorage.getItem(TABULAR_KEY);
    expect(saved).not.toBeNull();
    expect(JSON.parse(saved!).shape).toEqual([99]);
    // Nothing should have been written to the array key by this switch.
    expect(localStorage.getItem(ARRAY_KEY)).toBeNull();
  });

  it('switching to a model with no saved state yields defaults with the new dataModel', () => {
    const state = makeState({ dataModel: 'tabular' });
    const result = reducer(state, { type: 'SET_DATA_MODEL', model: 'array' });
    expect(result).toEqual({ ...DEFAULT_STATE, dataModel: 'array' });
  });

  it('switching back to a model restores its previously saved state', () => {
    const tabularState = makeState({ dataModel: 'tabular', shape: [77] });
    // Switch away: tabular gets saved, array has no saved state -> defaults.
    const arrayState = reducer(tabularState, { type: 'SET_DATA_MODEL', model: 'array' });
    expect(arrayState.dataModel).toBe('array');

    // Modify the array-side state, then switch back to tabular.
    const modifiedArrayState = { ...arrayState, shape: [4, 4] };
    const backToTabular = reducer(modifiedArrayState, { type: 'SET_DATA_MODEL', model: 'tabular' });
    expect(backToTabular.dataModel).toBe('tabular');
    expect(backToTabular.shape).toEqual([77]);

    // And switching to array again should restore the modified array state.
    const backToArray = reducer(backToTabular, { type: 'SET_DATA_MODEL', model: 'array' });
    expect(backToArray.dataModel).toBe('array');
    expect(backToArray.shape).toEqual([4, 4]);
  });
});
