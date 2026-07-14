import { describe, it, expect } from 'vitest';
import { validateExternalState } from '../../../src/state/persistence.ts';
import { DEFAULT_STATE } from '../../../src/types/state.ts';

/**
 * Curated-variables migration: a persisted PRE-change state carries a
 * schema-wide `dataset: { id, attribution, seededEntries }` and binds values by
 * id prefix (`{dataset.id}-{name}`). `migrateState` converts each prefixed
 * variable to an explicit per-variable `source` ref and drops `dataset`.
 * Seeded metadata entries need no handling — they already live in
 * `customEntries` as ordinary entries.
 */
describe('dataset -> per-variable source migration', () => {
  // A raw pre-change etopo-dem (array) state literal.
  const raw = {
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

  const migrated = validateExternalState(raw, 'array');

  it('the prefixed variable gains the right source ref', () => {
    const elev = migrated!.variables.find((v) => v.name === 'elevation')!;
    expect(elev.source).toEqual({ datasetId: 'etopo-dem', variableName: 'elevation' });
  });

  it('the custom (unprefixed) variable is untouched — no source', () => {
    const noise = migrated!.variables.find((v) => v.name === 'noise')!;
    expect(noise.source).toBeUndefined();
  });

  it('the schema-wide dataset field is gone from the result', () => {
    expect('dataset' in (migrated as unknown as Record<string, unknown>)).toBe(false);
  });

  it('customEntries are preserved verbatim (seeded entries stay as ordinary entries)', () => {
    expect(migrated!.metadata.customEntries).toEqual([
      { key: 'source', value: 'NOAA NCEI ETOPO' },
      { key: 'license', value: 'public domain' },
    ]);
  });
});
