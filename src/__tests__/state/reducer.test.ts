import { describe, it, expect } from 'vitest';
import { reducer } from '../../state/useAppState.ts';
import { DEFAULT_STATE, type AppState, type Variable } from '../../types/state.ts';
import type { CodecStep } from '../../types/codecs.ts';

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
});

// ─── SET_CHUNK_SHAPE ───────────────────────────────────────────────

describe('SET_CHUNK_SHAPE', () => {
  it('sets chunk shape', () => {
    const state = makeState({ chunkShape: [32] });
    const result = reducer(state, { type: 'SET_CHUNK_SHAPE', chunkShape: [8] });
    expect(result.chunkShape).toEqual([8]);
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
      metadata: { customEntries: [], serialization: 'binary' },
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
