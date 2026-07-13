import { describe, it, expect, beforeEach } from 'vitest';
import { reducer } from '../../../src/state/useAppState.ts';
import { DEFAULT_STATE, type AppState, type Variable } from '../../../src/types/state.ts';
import type { CodecStep } from '../../../src/types/codecs.ts';

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
    logicalType: { type: 'decimal', min: -50, max: 50, decimalPlaces: 1, generation: 'random' },
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
    expect(result.fieldPipelines['v1']).toEqual([]);
  });

  it('appends to existing variables', () => {
    const v1 = makeVariable({ id: 'v1', name: 'temp' });
    const state = makeState({
      variables: [v1],
      fieldPipelines: { v1: [] },
    });
    const v2 = makeVariable({ id: 'v2', name: 'pressure', color: '#61afef' });
    const result = reducer(state, { type: 'ADD_VARIABLE', variable: v2 });
    expect(result.variables).toHaveLength(2);
    expect(result.fieldPipelines['v2']).toEqual([]);
  });

  // Fixed by Phase 3.1 (D5, id-keyed pipelines) — was `it.fails` under SW-1.
  it('adding a variable whose name collides with an existing one preserves the existing pipeline', () => {
    const existingSteps: CodecStep[] = [{ codec: 'delta', params: { order: 1 } }];
    const v1 = makeVariable({ id: 'v1', name: 'temp' });
    const state = makeState({
      variables: [v1],
      fieldPipelines: { v1: existingSteps },
    });
    // A second variable with a different id but the SAME name.
    const v2 = makeVariable({ id: 'v2', name: 'temp', color: '#61afef' });
    const result = reducer(state, { type: 'ADD_VARIABLE', variable: v2 });
    expect(result.variables).toHaveLength(2);
    // fieldPipelines is keyed by id, so the new variable's empty pipeline
    // lands under its own 'v2' key, leaving v1's pipeline untouched.
    expect(result.fieldPipelines['v1']).toEqual(existingSteps);
    expect(result.fieldPipelines['v2']).toEqual([]);
  });
});

// ─── REMOVE_VARIABLE ───────────────────────────────────────────────

describe('REMOVE_VARIABLE', () => {
  it('removes variable and its field pipeline', () => {
    const v1 = makeVariable({ id: 'v1', name: 'temp' });
    const v2 = makeVariable({ id: 'v2', name: 'pressure' });
    const state = makeState({
      variables: [v1, v2],
      fieldPipelines: { v1: [], v2: [] },
    });
    const result = reducer(state, { type: 'REMOVE_VARIABLE', id: 'v1' });
    expect(result.variables).toHaveLength(1);
    expect(result.variables[0].name).toBe('pressure');
    expect(result.fieldPipelines).not.toHaveProperty('v1');
    expect(result.fieldPipelines).toHaveProperty('v2');
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
    const state = makeState({ variables: [v], fieldPipelines: { v1: [] } });
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
    const state = makeState({ variables: [v], fieldPipelines: { v1: [] } });
    const result = reducer(state, {
      type: 'UPDATE_VARIABLE',
      id: 'v1',
      changes: { logicalType: { type: 'integer', min: 0, max: 100, generation: 'random' } },
    });
    expect(result.variables[0].logicalType.type).toBe('integer');
    expect(result.variables[0].name).toBe('temp');
  });

  it('updates name without touching fieldPipelines (id-keyed, D5)', () => {
    const steps: CodecStep[] = [{ codec: 'delta', params: { order: 1 } }];
    const v = makeVariable({ id: 'v1', name: 'temp' });
    const state = makeState({
      variables: [v],
      fieldPipelines: { v1: steps },
    });
    const result = reducer(state, {
      type: 'UPDATE_VARIABLE',
      id: 'v1',
      changes: { name: 'temperature' },
    });
    expect(result.variables[0].name).toBe('temperature');
    expect(result.fieldPipelines['v1']).toEqual(steps);
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

  it('updates color', () => {
    const v = makeVariable({ id: 'v1', name: 'temp', color: '#e06c75' });
    const state = makeState({ variables: [v], fieldPipelines: { v1: [] } });
    const result = reducer(state, {
      type: 'UPDATE_VARIABLE',
      id: 'v1',
      changes: { color: '#61afef' },
    });
    expect(result.variables[0].color).toBe('#61afef');
    expect(result.variables[0].name).toBe('temp');
  });

  it('updates color even when a dataset locks the schema (display-only, not schema)', () => {
    const v = makeVariable({ id: 'v1', name: 'temp', color: '#e06c75' });
    const state = makeState({
      variables: [v],
      fieldPipelines: { v1: [] },
      dataset: { id: 'etopo-dem', attribution: 'test', seededEntries: [] },
    });
    const result = reducer(state, {
      type: 'UPDATE_VARIABLE',
      id: 'v1',
      changes: { color: '#61afef' },
    });
    expect(result.variables[0].color).toBe('#61afef');
  });

  it('blocks name change on a dataset-backed variable (id prefix matches the active dataset)', () => {
    const v = makeVariable({ id: 'etopo-dem-temp', name: 'temp' });
    const state = makeState({
      variables: [v],
      fieldPipelines: { 'etopo-dem-temp': [] },
      dataset: { id: 'etopo-dem', attribution: 'test', seededEntries: [] },
    });
    const result = reducer(state, {
      type: 'UPDATE_VARIABLE',
      id: 'etopo-dem-temp',
      changes: { name: 'renamed' },
    });
    expect(result.variables[0].name).toBe('temp');
  });

  it('allows name change on a CUSTOM variable added alongside a dataset (id not prefixed)', () => {
    const v = makeVariable({ id: 'custom-1', name: 'noise' });
    const state = makeState({
      variables: [v],
      fieldPipelines: { 'custom-1': [] },
      dataset: { id: 'etopo-dem', attribution: 'test', seededEntries: [] },
    });
    const result = reducer(state, {
      type: 'UPDATE_VARIABLE',
      id: 'custom-1',
      changes: { name: 'renamed' },
    });
    expect(result.variables[0].name).toBe('renamed');
  });

  // Fixed by Phase 3.1 (D5, id-keyed pipelines) — was `it.fails` under SW-1.
  it('renaming a variable to another variable\'s name preserves the target\'s pipeline', () => {
    const a = makeVariable({ id: 'a', name: 'alpha' });
    const b = makeVariable({ id: 'b', name: 'beta', color: '#61afef' });
    const bSteps: CodecStep[] = [{ codec: 'rle', params: {} }];
    const state = makeState({
      variables: [a, b],
      fieldPipelines: { a: [], b: bSteps },
    });
    const result = reducer(state, {
      type: 'UPDATE_VARIABLE',
      id: 'a',
      changes: { name: 'beta' },
    });
    expect(result.variables.find((v) => v.id === 'a')!.name).toBe('beta');
    // Pipelines are keyed by id, so the name collision has no effect on
    // either variable's pipeline.
    expect(result.fieldPipelines['b']).toEqual(bSteps);
    expect(result.fieldPipelines['a']).toEqual([]);
  });

  // Fixed by Phase 3.1 (D5, id-keyed pipelines) — was `it.fails` under SW-1.
  it('renaming away after a collision does not resurrect or lose the collided-with pipeline', () => {
    const a = makeVariable({ id: 'a', name: 'alpha' });
    const b = makeVariable({ id: 'b', name: 'beta', color: '#61afef' });
    const bSteps: CodecStep[] = [{ codec: 'rle', params: {} }];
    const state = makeState({
      variables: [a, b],
      fieldPipelines: { a: [], b: bSteps },
    });
    // First, collide: rename a -> 'beta' (no-op on pipelines, id-keyed).
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
    expect(result.fieldPipelines['b']).toEqual(bSteps);
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
  it('sets pipeline for a variable by id', () => {
    const state = makeState({ fieldPipelines: { v1: [] } });
    const steps: CodecStep[] = [
      { codec: 'delta', params: { order: 1 } },
    ];
    const result = reducer(state, {
      type: 'SET_FIELD_PIPELINE',
      variableId: 'v1',
      steps,
    });
    expect(result.fieldPipelines['v1']).toEqual(steps);
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
//
// Task 3.7: SET_METADATA_SERIALIZATION and SET_INCLUDE_CHUNK_INDEX are
// deleted; both are now expressed via the UPDATE_METADATA_CONFIG patch
// action (merges into state.metadata).

describe('UPDATE_METADATA_CONFIG', () => {
  it('sets serialization to binary', () => {
    const state = makeState();
    const result = reducer(state, {
      type: 'UPDATE_METADATA_CONFIG',
      changes: { serialization: 'binary' },
    });
    expect(result.metadata.serialization).toBe('binary');
  });

  it('sets serialization to json', () => {
    const state = makeState({
      metadata: { customEntries: [], serialization: 'binary', include: DEFAULT_STATE.metadata.include },
    });
    const result = reducer(state, {
      type: 'UPDATE_METADATA_CONFIG',
      changes: { serialization: 'json' },
    });
    expect(result.metadata.serialization).toBe('json');
  });

  it('sets include.chunkIndex to false', () => {
    const state = makeState();
    const result = reducer(state, {
      type: 'UPDATE_METADATA_CONFIG',
      changes: { include: { ...DEFAULT_STATE.metadata.include, chunkIndex: false } },
    });
    expect(result.metadata.include.chunkIndex).toBe(false);
  });

  it('sets include.chunkIndex back to true', () => {
    const state = makeState({
      metadata: { ...DEFAULT_STATE.metadata, include: { ...DEFAULT_STATE.metadata.include, chunkIndex: false } },
    });
    const result = reducer(state, {
      type: 'UPDATE_METADATA_CONFIG',
      changes: { include: { ...DEFAULT_STATE.metadata.include, chunkIndex: true } },
    });
    expect(result.metadata.include.chunkIndex).toBe(true);
  });

  it('merges a partial patch without touching customEntries', () => {
    const state = makeState({
      metadata: {
        customEntries: [{ key: 'a', value: 'b' }],
        serialization: 'json',
        include: DEFAULT_STATE.metadata.include,
      },
    });
    const result = reducer(state, {
      type: 'UPDATE_METADATA_CONFIG',
      changes: { serialization: 'binary' },
    });
    expect(result.metadata.serialization).toBe('binary');
    expect(result.metadata.include.chunkIndex).toBe(true);
    expect(result.metadata.customEntries).toEqual([{ key: 'a', value: 'b' }]);
  });

  it('can patch both fields at once', () => {
    const state = makeState();
    const result = reducer(state, {
      type: 'UPDATE_METADATA_CONFIG',
      changes: { serialization: 'binary', include: { ...DEFAULT_STATE.metadata.include, chunkIndex: false } },
    });
    expect(result.metadata.serialization).toBe('binary');
    expect(result.metadata.include.chunkIndex).toBe(false);
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
        include: DEFAULT_STATE.metadata.include,
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
        include: DEFAULT_STATE.metadata.include,
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
        include: DEFAULT_STATE.metadata.include,
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
        include: DEFAULT_STATE.metadata.include,
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
        include: DEFAULT_STATE.metadata.include,
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

// ─── UPDATE_WRITE ────────────────────────────────────────────────────
//
// Task 3.7: the six SET_WRITE_* setters are deleted, replaced by a single
// UPDATE_WRITE patch action (merges into state.write).

describe('UPDATE_WRITE', () => {
  it('sets magic number', () => {
    const state = makeState();
    const result = reducer(state, { type: 'UPDATE_WRITE', changes: { magicNumber: 'DEADBEEF' } });
    expect(result.write.magicNumber).toBe('DEADBEEF');
  });

  it('sets partitioning', () => {
    const state = makeState();
    const result = reducer(state, { type: 'UPDATE_WRITE', changes: { partitioning: 'per-chunk' } });
    expect(result.write.partitioning).toBe('per-chunk');
  });

  it('sets metadata placement to footer', () => {
    const state = makeState();
    const result = reducer(state, {
      type: 'UPDATE_WRITE',
      changes: { metadataPlacement: 'footer' },
    });
    expect(result.write.metadataPlacement).toBe('footer');
  });

  it('sets metadata placement to sidecar', () => {
    const state = makeState();
    const result = reducer(state, {
      type: 'UPDATE_WRITE',
      changes: { metadataPlacement: 'sidecar' },
    });
    expect(result.write.metadataPlacement).toBe('sidecar');
  });

  it('sets chunk order', () => {
    const state = makeState();
    const result = reducer(state, { type: 'UPDATE_WRITE', changes: { chunkOrder: 'column-major' } });
    expect(result.write.chunkOrder).toBe('column-major');
  });

  it('sets footerLocator to "none"', () => {
    const state = makeState();
    const result = reducer(state, { type: 'UPDATE_WRITE', changes: { footerLocator: 'none' } });
    expect(result.write.footerLocator).toBe('none');
  });

  it('sets footerLocator back to "trailer"', () => {
    const state = makeState({
      write: { ...DEFAULT_STATE.write, footerLocator: 'none' },
    });
    const result = reducer(state, { type: 'UPDATE_WRITE', changes: { footerLocator: 'trailer' } });
    expect(result.write.footerLocator).toBe('trailer');
  });

  it('sets includeMetadata to true', () => {
    const state = makeState();
    const result = reducer(state, { type: 'UPDATE_WRITE', changes: { includeMetadata: true } });
    expect(result.write.includeMetadata).toBe(true);
  });

  it('sets includeMetadata to false', () => {
    const state = makeState({
      write: { ...DEFAULT_STATE.write, includeMetadata: true },
    });
    const result = reducer(state, { type: 'UPDATE_WRITE', changes: { includeMetadata: false } });
    expect(result.write.includeMetadata).toBe(false);
  });

  it('merges a partial patch without touching sibling fields', () => {
    const state = makeState();
    const result = reducer(state, { type: 'UPDATE_WRITE', changes: { magicNumber: 'CAFE' } });
    expect(result.write.magicNumber).toBe('CAFE');
    expect(result.write.partitioning).toBe(state.write.partitioning);
    expect(result.write.metadataPlacement).toBe(state.write.metadataPlacement);
  });

  it('can patch multiple fields at once', () => {
    const state = makeState();
    const result = reducer(state, {
      type: 'UPDATE_WRITE',
      changes: { magicNumber: 'CAFE', partitioning: 'per-chunk', includeMetadata: true },
    });
    expect(result.write.magicNumber).toBe('CAFE');
    expect(result.write.partitioning).toBe('per-chunk');
    expect(result.write.includeMetadata).toBe(true);
  });
});

// ─── UPDATE_UI ───────────────────────────────────────────────────────
//
// Task 3.7: SET_LEFT_PANE_STAGE/VIEW, SET_RIGHT_PANE_STAGE/VIEW, and
// SET_SHOW_DIFF are deleted, replaced by a single UPDATE_UI patch action.

describe('UPDATE_UI', () => {
  it('sets leftPaneStage', () => {
    const state = makeState();
    const result = reducer(state, { type: 'UPDATE_UI', changes: { leftPaneStage: 'encoded' } });
    expect(result.ui.leftPaneStage).toBe('encoded');
  });

  it('sets rightPaneStage', () => {
    const state = makeState();
    const result = reducer(state, { type: 'UPDATE_UI', changes: { rightPaneStage: 'write' } });
    expect(result.ui.rightPaneStage).toBe('write');
  });

  it('sets leftPaneView', () => {
    const state = makeState();
    const result = reducer(state, { type: 'UPDATE_UI', changes: { leftPaneView: 'grid' } });
    expect(result.ui.leftPaneView).toBe('grid');
  });

  it('sets rightPaneView', () => {
    const state = makeState();
    const result = reducer(state, { type: 'UPDATE_UI', changes: { rightPaneView: 'flat' } });
    expect(result.ui.rightPaneView).toBe('flat');
  });

  it('sets showDiff to true', () => {
    const state = makeState();
    const result = reducer(state, { type: 'UPDATE_UI', changes: { showDiff: true } });
    expect(result.ui.showDiff).toBe(true);
  });

  it('sets showDiff to false', () => {
    const state = makeState({
      ui: { ...DEFAULT_STATE.ui, showDiff: true },
    });
    const result = reducer(state, { type: 'UPDATE_UI', changes: { showDiff: false } });
    expect(result.ui.showDiff).toBe(false);
  });

  it('merges a partial patch without touching sibling fields', () => {
    const state = makeState();
    const result = reducer(state, { type: 'UPDATE_UI', changes: { leftPaneStage: 'linearized' } });
    expect(result.ui.leftPaneStage).toBe('linearized');
    expect(result.ui.rightPaneStage).toBe(state.ui.rightPaneStage);
    expect(result.ui.leftPaneView).toBe(state.ui.leftPaneView);
  });

  it('can patch multiple fields at once', () => {
    const state = makeState();
    const result = reducer(state, {
      type: 'UPDATE_UI',
      changes: { leftPaneStage: 'typed', rightPaneStage: 'read', showDiff: true },
    });
    expect(result.ui.leftPaneStage).toBe('typed');
    expect(result.ui.rightPaneStage).toBe('read');
    expect(result.ui.showDiff).toBe(true);
  });
});

// ─── SET_DATA_MODEL ────────────────────────────────────────────────
//
// Task 3.7 (fixes SW-4): SET_DATA_MODEL is now a pure reducer case — it only
// sets `state.dataModel`. All storage I/O (save the outgoing model, load or
// default the incoming model, record the active model) moved to the
// `switchDataModel` wrapper exposed by the provider (tested separately
// below), which dispatches REPLACE_STATE instead.

describe('SET_DATA_MODEL', () => {
  it('is a no-op when switching to the already-active model', () => {
    const state = makeState({ dataModel: 'tabular' });
    const result = reducer(state, { type: 'SET_DATA_MODEL', model: 'tabular' });
    expect(result).toBe(state);
  });

  it('sets dataModel and nothing else', () => {
    const state = makeState({ dataModel: 'tabular', shape: [99] });
    const result = reducer(state, { type: 'SET_DATA_MODEL', model: 'array' });
    expect(result.dataModel).toBe('array');
    // Nothing else about the state changes — no save/load/default swap.
    expect(result.shape).toEqual([99]);
    expect(result.variables).toBe(state.variables);
  });

  it('never touches localStorage (reducer purity, SW-4)', () => {
    const state = makeState({ dataModel: 'tabular' });
    reducer(state, { type: 'SET_DATA_MODEL', model: 'array' });
    expect(localStorage.getItem(TABULAR_KEY)).toBeNull();
    expect(localStorage.getItem(ARRAY_KEY)).toBeNull();
  });
});

// ─── REPLACE_STATE ───────────────────────────────────────────────────

describe('REPLACE_STATE', () => {
  it('replaces the entire state wholesale', () => {
    const state = makeState({ dataModel: 'tabular', shape: [10] });
    const replacement = makeState({ dataModel: 'array', shape: [4, 4] });
    const result = reducer(state, { type: 'REPLACE_STATE', state: replacement });
    expect(result).toBe(replacement);
  });
});
