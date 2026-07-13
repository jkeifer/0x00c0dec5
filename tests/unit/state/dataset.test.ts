import { describe, it, expect } from 'vitest';
import { reducer } from '../../../src/state/useAppState.ts';
import { validateExternalState } from '../../../src/state/persistence.ts';
import { DEFAULT_STATE } from '../../../src/types/state.ts';
import { datasetById } from '../../../src/datasets/registry.ts';
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
const APPLICATION = buildDatasetApplication(datasetById('ghcn-daily')!, MANIFEST);

function applied() {
  return reducer(structuredClone(DEFAULT_STATE), { type: 'APPLY_DATASET', application: APPLICATION });
}

describe('APPLY_DATASET', () => {
  it('applies dataset, shape, variables, pipelines, customEntries', () => {
    const s = applied();
    expect(s.dataset).toEqual({ id: 'ghcn-daily', attribution: 'NOAA · PD' });
    expect(s.shape).toEqual([4]);
    expect(s.variables.map((v) => v.name)).toEqual(['date']);
    expect(Object.keys(s.fieldPipelines)).toEqual(['ghcn-daily-date']);
    expect(s.metadata.customEntries.map((e) => e.key)).toEqual(['source', 'source_url', 'retrieved', 'license']);
    expect(s.interleaving).toBe('column');
  });
});

describe('schema locks while dataset active', () => {
  it('SET_SHAPE / ADD_VARIABLE / REMOVE_VARIABLE are no-ops', () => {
    const s = applied();
    expect(reducer(s, { type: 'SET_SHAPE', shape: [9] })).toBe(s);
    expect(reducer(s, {
      type: 'ADD_VARIABLE',
      variable: { id: 'x', name: 'x', color: '#fff',
        logicalType: { type: 'integer', min: 0, max: 1, generation: 'random' },
        typeAssignment: { storageDtype: 'int16' } },
    })).toBe(s);
    expect(reducer(s, { type: 'REMOVE_VARIABLE', id: 'ghcn-daily-date' })).toBe(s);
  });
  it('UPDATE_VARIABLE strips name/logicalType but keeps typeAssignment', () => {
    const s = applied();
    const out = reducer(s, {
      type: 'UPDATE_VARIABLE', id: 'ghcn-daily-date',
      changes: { name: 'hax', typeAssignment: { storageDtype: 'int16' } },
    });
    expect(out.variables[0].name).toBe('date');
    expect(out.variables[0].typeAssignment.storageDtype).toBe('int16');
  });
});

describe('SET_DATASET_CUSTOM', () => {
  it('clears dataset, keeps schema and customEntries as starting point', () => {
    const s = reducer(applied(), { type: 'SET_DATASET_CUSTOM' });
    expect(s.dataset).toBeNull();
    expect(s.shape).toEqual([4]);
    expect(s.variables).toHaveLength(1);
    expect(s.metadata.customEntries).toHaveLength(4);
    // unlocked again
    expect(reducer(s, { type: 'SET_SHAPE', shape: [9] }).shape).toEqual([9]);
  });
});

describe('persistence validation', () => {
  it('passes a known, model-matching dataset through', () => {
    const s = validateExternalState({ ...structuredClone(DEFAULT_STATE), dataset: { id: 'ghcn-daily', attribution: 'a' } }, 'tabular');
    expect(s?.dataset).toEqual({ id: 'ghcn-daily', attribution: 'a' });
  });
  it.each([
    ['unknown id', { id: 'nope', attribution: 'a' }],
    ['wrong model', { id: 'etopo-dem', attribution: 'a' }], // array dataset in tabular state
    ['malformed', { id: 42 }],
    ['string', 'ghcn-daily'],
  ])('drops %s to null', (_l, dataset) => {
    const s = validateExternalState({ ...structuredClone(DEFAULT_STATE), dataset }, 'tabular');
    expect(s?.dataset).toBeNull();
  });
  it('defaults missing dataset to null', () => {
    const s = validateExternalState(structuredClone(DEFAULT_STATE), 'tabular');
    expect(s?.dataset).toBeNull();
  });
});
