import { describe, it, expect } from 'vitest';
import { reducer } from '../../../src/state/useAppState.ts';
import { validateExternalState } from '../../../src/state/persistence.ts';
import { DEFAULT_STATE, type AppState, type Variable } from '../../../src/types/state.ts';
import { buildDatasetApplication } from '../../../src/datasets/apply.ts';
import type { DatasetManifest } from '../../../src/datasets/types.ts';

const MANIFEST: DatasetManifest = {
  id: 'ghcn-daily',
  shape: [4],
  attribution: { source: 'NOAA', source_url: 'u', retrieved: '2026-07-12', license: 'PD' },
  variables: [
    { name: 'date', kind: 'number', dtype: 'int32', file: 'date.bin', min: 1, max: 4,
      logicalType: { type: 'integer', min: 1, max: 4, generation: 'sorted' } },
  ],
};
const APPLICATION = buildDatasetApplication(MANIFEST);
const SEEDED = [
  { key: 'source', value: 'NOAA' },
  { key: 'source_url', value: 'u' },
  { key: 'retrieved', value: '2026-07-12' },
  { key: 'license', value: 'PD' },
];

// A second dataset (etopo-dem, array) for the re-apply swap test.
const ETOPO_MANIFEST: DatasetManifest = {
  id: 'etopo-dem',
  shape: [4],
  attribution: { source: 'ETOPO', source_url: 'e', retrieved: '2026-01-01', license: 'PD2' },
  variables: [
    { name: 'elevation', kind: 'number', dtype: 'int16', file: 'elevation.bin', min: 0, max: 9,
      logicalType: { type: 'integer', min: 0, max: 9, generation: 'smooth' } },
  ],
};
const ETOPO_APPLICATION = buildDatasetApplication(ETOPO_MANIFEST);

function base(overrides: Partial<AppState> = {}): AppState {
  return { ...structuredClone(DEFAULT_STATE), ...overrides };
}

function applied(state: AppState = base()) {
  return reducer(state, { type: 'APPLY_DATASET', application: APPLICATION });
}

describe('APPLY_DATASET — schema + metadata only', () => {
  it('sets dataset ref (with seededEntries), shape, variables, empty pipelines', () => {
    const s = applied();
    expect(s.dataset).toEqual({ id: 'ghcn-daily', attribution: 'NOAA · PD', seededEntries: SEEDED });
    expect(s.shape).toEqual([4]);
    expect(s.variables.map((v) => v.name)).toEqual(['date']);
    expect(s.variables[0].id).toBe('ghcn-daily-date');
    expect(s.variables[0].typeAssignment.storageDtype).toBe('int32');
    expect(Object.keys(s.fieldPipelines)).toEqual(['ghcn-daily-date']);
    expect(s.fieldPipelines['ghcn-daily-date']).toEqual([]);
  });

  it('appends seeded provenance entries, preserving the user\'s own entries', () => {
    const s = applied(base({
      metadata: { ...DEFAULT_STATE.metadata, customEntries: [{ key: 'mine', value: 'keep' }] },
    }));
    expect(s.metadata.customEntries).toEqual([{ key: 'mine', value: 'keep' }, ...SEEDED]);
  });

  it('does NOT touch interleaving / linearization / byteOrder / chunkPipeline / write', () => {
    const start = base({
      interleaving: 'row',
      linearization: 'morton',
      byteOrder: 'big',
      chunkPipeline: [{ codec: 'rle', params: {} }],
      write: { ...DEFAULT_STATE.write, magicNumber: 'CAFE', metadataPlacement: 'footer' },
    });
    const s = applied(start);
    expect(s.interleaving).toBe('row');
    expect(s.linearization).toBe('morton');
    expect(s.byteOrder).toBe('big');
    expect(s.chunkPipeline).toEqual([{ codec: 'rle', params: {} }]);
    expect(s.write.magicNumber).toBe('CAFE');
    expect(s.write.metadataPlacement).toBe('footer');
  });

  it('reconciles chunkShape to the new shape (clamped per-dim), like SET_SHAPE', () => {
    // Start 2-D with a big chunk; applying a 1-D [4] dataset clamps to [4].
    const s = applied(base({ shape: [32, 32], chunkShape: [16, 16] }));
    expect(s.chunkShape).toEqual([4]);
  });
});

describe('re-apply swaps seeded entries', () => {
  it('removes the previous dataset\'s unmodified seeded entries before appending the new one\'s', () => {
    const first = applied();
    expect(first.metadata.customEntries).toEqual(SEEDED);
    const second = reducer(first, { type: 'APPLY_DATASET', application: ETOPO_APPLICATION });
    // ghcn's seeded entries gone, etopo's present.
    expect(second.metadata.customEntries).toEqual([
      { key: 'source', value: 'ETOPO' },
      { key: 'source_url', value: 'e' },
      { key: 'retrieved', value: '2026-01-01' },
      { key: 'license', value: 'PD2' },
    ]);
    expect(second.dataset!.id).toBe('etopo-dem');
  });

  it('a modified seeded entry survives a re-apply', () => {
    const first = applied();
    // User edits the license value.
    const edited = reducer(first, {
      type: 'UPDATE_METADATA_ENTRY',
      index: first.metadata.customEntries.findIndex((e) => e.key === 'license'),
      value: 'edited',
    });
    const second = reducer(edited, { type: 'APPLY_DATASET', application: ETOPO_APPLICATION });
    expect(second.metadata.customEntries).toContainEqual({ key: 'license', value: 'edited' });
  });
});

describe('schema lock while dataset active (Task 5: shape locked; compose allowed)', () => {
  const CUSTOM_VAR: Variable = {
    id: 'x', name: 'x', color: '#fff',
    logicalType: { type: 'integer', min: 0, max: 1, generation: 'random' },
    typeAssignment: { storageDtype: 'int16' },
  };

  it('SET_SHAPE is still a no-op (dataset owns shape)', () => {
    const s = applied();
    expect(reducer(s, { type: 'SET_SHAPE', shape: [9] })).toBe(s);
  });

  it('ADD_VARIABLE appends a custom variable (with an empty pipeline)', () => {
    const s = applied();
    const out = reducer(s, { type: 'ADD_VARIABLE', variable: CUSTOM_VAR });
    expect(out.variables.map((v) => v.id)).toEqual(['ghcn-daily-date', 'x']);
    expect(out.fieldPipelines['x']).toEqual([]);
  });

  it('REMOVE_VARIABLE removes a dataset-backed variable', () => {
    const s = applied();
    const out = reducer(s, { type: 'REMOVE_VARIABLE', id: 'ghcn-daily-date' });
    expect(out.variables).toHaveLength(0);
  });

  it('UPDATE_VARIABLE strips name/logicalType on a dataset-backed row, keeps typeAssignment', () => {
    const s = applied();
    const out = reducer(s, {
      type: 'UPDATE_VARIABLE', id: 'ghcn-daily-date',
      changes: { name: 'hax', typeAssignment: { storageDtype: 'int16' } },
    });
    expect(out.variables[0].name).toBe('date');
    expect(out.variables[0].typeAssignment.storageDtype).toBe('int16');
  });

  it('UPDATE_VARIABLE renames a CUSTOM variable added alongside the dataset', () => {
    const s = reducer(applied(), { type: 'ADD_VARIABLE', variable: CUSTOM_VAR });
    const out = reducer(s, {
      type: 'UPDATE_VARIABLE', id: 'x',
      changes: { name: 'renamed', logicalType: { type: 'text', min: 0, max: 0, generation: 'random' } },
    });
    const custom = out.variables.find((v) => v.id === 'x')!;
    expect(custom.name).toBe('renamed');
    expect(custom.logicalType.type).toBe('text');
  });
});

describe('SET_DATASET_CUSTOM — deselect', () => {
  it('clears dataset, removes seeded entries, keeps schema as starting point', () => {
    const s = reducer(applied(), { type: 'SET_DATASET_CUSTOM' });
    expect(s.dataset).toBeNull();
    expect(s.shape).toEqual([4]);
    expect(s.variables).toHaveLength(1);
    // Seeded entries removed on deselect.
    expect(s.metadata.customEntries).toEqual([]);
    // unlocked again
    expect(reducer(s, { type: 'SET_SHAPE', shape: [9] }).shape).toEqual([9]);
  });

  it('keeps a modified seeded entry and the user\'s own entries', () => {
    const applied1 = applied(base({
      metadata: { ...DEFAULT_STATE.metadata, customEntries: [{ key: 'mine', value: 'keep' }] },
    }));
    // Edit the source value; leave the rest seeded.
    const edited = reducer(applied1, {
      type: 'UPDATE_METADATA_ENTRY',
      index: applied1.metadata.customEntries.findIndex((e) => e.key === 'source'),
      value: 'user-edited',
    });
    const s = reducer(edited, { type: 'SET_DATASET_CUSTOM' });
    expect(s.metadata.customEntries).toEqual([
      { key: 'mine', value: 'keep' },
      { key: 'source', value: 'user-edited' },
    ]);
  });
});

describe('persistence validation', () => {
  it('passes a known, model-matching dataset through, defaulting seededEntries', () => {
    const s = validateExternalState(base({ dataset: { id: 'ghcn-daily', attribution: 'a', seededEntries: SEEDED } }), 'tabular');
    expect(s?.dataset).toEqual({ id: 'ghcn-daily', attribution: 'a', seededEntries: SEEDED });
  });
  it('tolerates a dataset ref with missing seededEntries (degrades to [])', () => {
    const s = validateExternalState({ ...base(), dataset: { id: 'ghcn-daily', attribution: 'a' } }, 'tabular');
    expect(s?.dataset).toEqual({ id: 'ghcn-daily', attribution: 'a', seededEntries: [] });
  });
  it('drops malformed seededEntries to [] without nulling the ref', () => {
    const s = validateExternalState({
      ...base(),
      dataset: { id: 'ghcn-daily', attribution: 'a', seededEntries: [{ key: 'ok', value: 'v' }, { nope: 1 }, 'garbage'] },
    }, 'tabular');
    expect(s?.dataset).toEqual({ id: 'ghcn-daily', attribution: 'a', seededEntries: [{ key: 'ok', value: 'v' }] });
  });
  it.each([
    ['unknown id', { id: 'nope', attribution: 'a', seededEntries: [] }],
    ['wrong model', { id: 'etopo-dem', attribution: 'a', seededEntries: [] }], // array dataset in tabular state
    ['malformed', { id: 42 }],
    ['string', 'ghcn-daily'],
  ])('drops %s to null', (_l, dataset) => {
    const s = validateExternalState({ ...base(), dataset }, 'tabular');
    expect(s?.dataset).toBeNull();
  });
  it('defaults missing dataset to null', () => {
    const s = validateExternalState(base(), 'tabular');
    expect(s?.dataset).toBeNull();
  });
});
