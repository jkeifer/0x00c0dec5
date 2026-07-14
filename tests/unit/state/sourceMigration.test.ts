import { describe, it, expect } from 'vitest';
import { validateExternalState } from '../../../src/state/persistence.ts';
import { DEFAULT_STATE } from '../../../src/types/state.ts';

/**
 * Curated-variables rework: pre-change states carried a schema-wide
 * `dataset: { id, attribution, seededEntries }` and bound values by id
 * prefix (`{dataset.id}-{name}`). That shape is incompatible with the
 * current per-variable `source` ref model, so `migrateState` drops the whole
 * state (returns `null`, degrading to defaults) rather than converting it.
 */
describe('pre-curated-variables dataset states are dropped, not migrated', () => {
  // A raw pre-change etopo-dem (array) state literal — `dataset` active.
  const rawWithDataset = {
    ...JSON.parse(JSON.stringify(DEFAULT_STATE)),
    dataModel: 'array',
    shape: [16, 16],
    chunkShape: [16, 16],
    dataset: {
      id: 'etopo-dem',
      attribution: 'NOAA · public domain',
      seededEntries: [
        { key: 'source', value: 'NOAA NCEI ETOPO' },
        { key: 'license', value: 'public domain' },
      ],
    },
    variables: [
      {
        id: 'etopo-dem-elevation', name: 'elevation', color: '#e06c75',
        logicalType: { type: 'integer', min: 97, max: 178, generation: 'smooth' },
        typeAssignment: { storageDtype: 'int16' },
      },
      {
        // A custom variable the user added alongside — NOT prefixed.
        id: 'var_123', name: 'noise', color: '#61afef',
        logicalType: { type: 'integer', min: 0, max: 5, generation: 'random' },
        typeAssignment: { storageDtype: 'int16' },
      },
    ],
    fieldPipelines: { 'etopo-dem-elevation': [], var_123: [] },
    metadata: {
      ...DEFAULT_STATE.metadata,
      customEntries: [
        { key: 'source', value: 'NOAA NCEI ETOPO' },
        { key: 'license', value: 'public domain' },
      ],
    },
  };

  it('validateExternalState returns null for a state with a non-null dataset', () => {
    expect(validateExternalState(rawWithDataset, 'array')).toBeNull();
  });

  it('a state with `dataset: null` loads normally, variables intact as custom rows', () => {
    const raw = {
      ...JSON.parse(JSON.stringify(DEFAULT_STATE)),
      dataModel: 'array',
      shape: [16, 16],
      chunkShape: [16, 16],
      dataset: null,
      variables: [
        {
          id: 'var_123', name: 'noise', color: '#61afef',
          logicalType: { type: 'integer', min: 0, max: 5, generation: 'random' },
          typeAssignment: { storageDtype: 'int16' },
        },
      ],
    };

    const loaded = validateExternalState(raw, 'array');
    expect(loaded).not.toBeNull();
    expect(loaded!.variables).toHaveLength(1);
    expect(loaded!.variables[0]).toMatchObject({ id: 'var_123', name: 'noise' });
    expect(loaded!.variables[0].source).toBeUndefined();
    expect('dataset' in (loaded as unknown as Record<string, unknown>)).toBe(false);
  });

  it('a current-shape state with per-variable `source` refs loads unchanged', () => {
    const raw = {
      ...JSON.parse(JSON.stringify(DEFAULT_STATE)),
      dataModel: 'array',
      shape: [16, 16],
      chunkShape: [16, 16],
      variables: [
        {
          id: 'var_elev', name: 'elevation', color: '#e06c75',
          logicalType: { type: 'integer', min: 97, max: 178, generation: 'smooth' },
          typeAssignment: { storageDtype: 'int16' },
          source: { datasetId: 'etopo-dem', variableName: 'elevation' },
        },
      ],
    };

    const loaded = validateExternalState(raw, 'array');
    expect(loaded).not.toBeNull();
    const elev = loaded!.variables.find((v) => v.name === 'elevation');
    // `etopo-dem`/`elevation` is a real 'array'-model catalog entry, so the
    // source ref resolves and survives normalizeSource unchanged.
    expect(elev?.source).toEqual({ datasetId: 'etopo-dem', variableName: 'elevation' });
  });
});
