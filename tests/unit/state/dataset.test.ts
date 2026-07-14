import { describe, it, expect } from 'vitest';
import { reducer } from '../../../src/state/useAppState.ts';
import { validateExternalState } from '../../../src/state/persistence.ts';
import { DEFAULT_STATE, type AppState, type Variable } from '../../../src/types/state.ts';
import { curatedVariable } from '../../../src/datasets/registry.ts';

function base(overrides: Partial<AppState> = {}): AppState {
  return { ...structuredClone(DEFAULT_STATE), ...overrides };
}

// A custom (generated) row.
const CUSTOM: Variable = {
  id: 'v1', name: 'noise', color: '#fff',
  logicalType: { type: 'integer', min: 0, max: 5, generation: 'random' },
  typeAssignment: { storageDtype: 'int16' },
};

// The elevation ref (etopo-dem, array model) — a real catalog entry.
const ELEV_REF = { datasetId: 'etopo-dem' as const, variableName: 'elevation' };

describe('UPDATE_VARIABLE — source set/clear', () => {
  function stateWith(v: Variable, model: AppState['dataModel'] = 'array'): AppState {
    return base({ dataModel: model, variables: [v], fieldPipelines: { [v.id]: [] } });
  }

  it('setting source pulls the catalog logicalType (deep copy) and defaults typeAssignment from the natural dtype', () => {
    const s = reducer(stateWith(CUSTOM), { type: 'UPDATE_VARIABLE', id: 'v1', changes: { source: ELEV_REF } });
    const v = s.variables[0];
    expect(v.source).toEqual(ELEV_REF);
    const cat = curatedVariable(ELEV_REF)!;
    expect(v.logicalType).toEqual(cat.logicalType);
    expect(v.logicalType).not.toBe(cat.logicalType); // deep copy, not shared ref
    expect(v.typeAssignment.storageDtype).toBe(cat.dtype); // int16
  });

  it('setting a string source defaults typeAssignment to char16', () => {
    // station is a text curated var (tabular). Use a tabular custom row.
    const s = reducer(
      stateWith(CUSTOM, 'tabular'),
      { type: 'UPDATE_VARIABLE', id: 'v1', changes: { source: { datasetId: 'ghcn-daily', variableName: 'station' } } },
    );
    expect(s.variables[0].typeAssignment.storageDtype).toBe('char16');
    expect(s.variables[0].logicalType.type).toBe('text');
  });

  it('while source is set, logicalType changes are ignored (single lock point)', () => {
    const bound = reducer(stateWith(CUSTOM), { type: 'UPDATE_VARIABLE', id: 'v1', changes: { source: ELEV_REF } });
    const attempt = reducer(bound, {
      type: 'UPDATE_VARIABLE', id: 'v1',
      changes: { logicalType: { type: 'text', min: 0, max: 0, generation: 'random' } },
    });
    expect(attempt.variables[0].logicalType).toEqual(bound.variables[0].logicalType);
  });

  it('name stays editable on a curated row', () => {
    const bound = reducer(stateWith(CUSTOM), { type: 'UPDATE_VARIABLE', id: 'v1', changes: { source: ELEV_REF } });
    const renamed = reducer(bound, { type: 'UPDATE_VARIABLE', id: 'v1', changes: { name: 'terrain' } });
    expect(renamed.variables[0].name).toBe('terrain');
    expect(renamed.variables[0].source).toEqual(ELEV_REF); // still bound
  });

  it('typeAssignment stays editable on a curated row', () => {
    const bound = reducer(stateWith(CUSTOM), { type: 'UPDATE_VARIABLE', id: 'v1', changes: { source: ELEV_REF } });
    const retyped = reducer(bound, { type: 'UPDATE_VARIABLE', id: 'v1', changes: { typeAssignment: { storageDtype: 'int32' } } });
    expect(retyped.variables[0].typeAssignment.storageDtype).toBe('int32');
  });

  it('clearing source (null) keeps current logicalType and unlocks the row', () => {
    const bound = reducer(stateWith(CUSTOM), { type: 'UPDATE_VARIABLE', id: 'v1', changes: { source: ELEV_REF } });
    const lt = bound.variables[0].logicalType;
    const cleared = reducer(bound, { type: 'UPDATE_VARIABLE', id: 'v1', changes: { source: null } });
    expect(cleared.variables[0].source).toBeUndefined();
    expect(cleared.variables[0].logicalType).toEqual(lt); // kept as a starting point
    // now editable again
    const edited = reducer(cleared, {
      type: 'UPDATE_VARIABLE', id: 'v1',
      changes: { logicalType: { type: 'text', min: 0, max: 0, generation: 'random' } },
    });
    expect(edited.variables[0].logicalType.type).toBe('text');
  });

  it('an unknown ref is ignored (no source set)', () => {
    const s = reducer(stateWith(CUSTOM), {
      type: 'UPDATE_VARIABLE', id: 'v1',
      changes: { source: { datasetId: 'etopo-dem', variableName: 'nope' } },
    });
    expect(s.variables[0].source).toBeUndefined();
  });
});

describe('schema actions have no dataset conditions', () => {
  it('SET_SHAPE works even with a curated variable present', () => {
    const s = base({ dataModel: 'array', variables: [{ ...CUSTOM, source: ELEV_REF }], fieldPipelines: { v1: [] } });
    expect(reducer(s, { type: 'SET_SHAPE', shape: [9, 9] }).shape).toEqual([9, 9]);
  });
});

describe('persistence — source validation', () => {
  function withVar(v: Variable, model: AppState['dataModel'] = 'array'): unknown {
    return { ...base({ dataModel: model }), variables: [v], fieldPipelines: { [v.id]: [] } };
  }

  it('keeps a valid, model-matching source ref', () => {
    const s = validateExternalState(withVar({ ...CUSTOM, source: ELEV_REF }), 'array');
    expect(s?.variables[0].source).toEqual(ELEV_REF);
  });

  it('drops a source whose dataModel does not match (row degrades to custom, keeps everything else)', () => {
    // etopo-dem is an array dataset; a tabular state referencing it must drop it.
    const s = validateExternalState(withVar({ ...CUSTOM, source: ELEV_REF }, 'tabular'), 'tabular');
    expect(s?.variables[0].source).toBeUndefined();
    expect(s?.variables[0].name).toBe('noise'); // rest intact
  });

  it('drops a source that names no curated variable', () => {
    const s = validateExternalState(withVar({ ...CUSTOM, source: { datasetId: 'etopo-dem', variableName: 'nope' } }), 'array');
    expect(s?.variables[0].source).toBeUndefined();
  });

  it('drops a structurally-malformed source without rejecting the variable', () => {
    const s = validateExternalState(withVar({ ...CUSTOM, source: { datasetId: 'etopo-dem' } as never }), 'array');
    expect(s?.variables[0].source).toBeUndefined();
    expect(s?.variables[0].name).toBe('noise');
  });
});
