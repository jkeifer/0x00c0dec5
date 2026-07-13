import { describe, it, expect } from 'vitest';
import { DATASETS, datasetById, datasetUrl } from '../../../src/datasets/registry.ts';
import { buildDatasetApplication } from '../../../src/datasets/apply.ts';
import type { DatasetManifest } from '../../../src/datasets/types.ts';

const GHCN_MANIFEST: DatasetManifest = {
  id: 'ghcn-daily',
  shape: [4],
  attribution: { source: 'NOAA', source_url: 'https://ncei.noaa.gov', retrieved: '2026-07-12', license: 'PD' },
  variables: [
    { name: 'date', kind: 'number', dtype: 'int32', file: 'date.bin', min: 20200101, max: 20200104,
      logicalType: { type: 'integer', min: 20200101, max: 20200104, generation: 'sorted' } },
    { name: 'station', kind: 'string', dictFile: 'station.dict.json', codesFile: 'station.codes.bin',
      codesDtype: 'uint8',
      logicalType: { type: 'text', min: 0, max: 0, wordSet: 'stations', generation: 'stepped' } },
  ],
};

describe('registry', () => {
  it('has all three datasets with model scoping', () => {
    expect(DATASETS.map((d) => d.id).sort()).toEqual(['etopo-dem', 'ghcn-daily', 'sst-field']);
    expect(datasetById('etopo-dem')!.dataModel).toBe('array');
    expect(datasetById('sst-field')!.dataModel).toBe('array');
    expect(datasetById('ghcn-daily')!.dataModel).toBe('tabular');
    expect(datasetById('nope')).toBeUndefined();
  });
  it('builds dataset-relative URLs', () => {
    expect(datasetUrl('etopo-dem', 'manifest.json')).toMatch(/\/datasets\/etopo-dem\/manifest\.json$/);
  });
});

describe('buildDatasetApplication', () => {
  const entry = datasetById('ghcn-daily')!;
  const app = buildDatasetApplication(entry, GHCN_MANIFEST);

  it('mints deterministic ids and palette colors', () => {
    expect(app.variables.map((v) => v.id)).toEqual(['ghcn-daily-date', 'ghcn-daily-station']);
    expect(app.variables.every((v) => typeof v.color === 'string' && v.color.length > 0)).toBe(true);
  });
  it('takes logicalType from the manifest and shape/dataset from entry+manifest', () => {
    expect(app.shape).toEqual([4]);
    expect(app.dataset).toEqual({ id: 'ghcn-daily', attribution: 'NOAA · PD' });
    expect(app.variables[0].logicalType.generation).toBe('sorted');
  });
  it('applies curated typeAssignment by name; falls back to bin dtype / char16', () => {
    // curated block covers these names — the assertions pin what registry.ts declares
    expect(app.variables[0].typeAssignment.storageDtype).toBe('int32');
    expect(app.variables[1].typeAssignment.storageDtype).toBe('char16');
  });
  it('keys fieldPipelines by minted variable id and ignores unknown curated names', () => {
    for (const key of Object.keys(app.fieldPipelines)) {
      expect(app.variables.some((v) => v.id === key)).toBe(true);
    }
    // curated names not present in the manifest (e.g. tmax here) simply don't appear
    expect(Object.keys(app.fieldPipelines)).not.toContain('ghcn-daily-tmax');
  });
  it('seeds provenance customEntries', () => {
    expect(app.customEntries).toEqual([
      { key: 'source', value: 'NOAA' },
      { key: 'source_url', value: 'https://ncei.noaa.gov' },
      { key: 'retrieved', value: '2026-07-12' },
      { key: 'license', value: 'PD' },
    ]);
  });
});
