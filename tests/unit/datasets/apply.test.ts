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
  it('has all three datasets with model scoping (id/label/dataModel only — no curated block)', () => {
    expect(DATASETS.map((d) => d.id).sort()).toEqual(['etopo-dem', 'ghcn-daily', 'sst-field']);
    expect(datasetById('etopo-dem')!.dataModel).toBe('array');
    expect(datasetById('sst-field')!.dataModel).toBe('array');
    expect(datasetById('ghcn-daily')!.dataModel).toBe('tabular');
    expect(datasetById('nope')).toBeUndefined();
    // Registry entries are now { id, label, dataModel } — no curated config.
    expect(DATASETS.every((d) => !('curated' in d))).toBe(true);
  });
  it('builds dataset-relative URLs', () => {
    expect(datasetUrl('etopo-dem', 'manifest.json')).toMatch(/\/datasets\/etopo-dem\/manifest\.json$/);
  });
});

describe('buildDatasetApplication — schema + metadata only', () => {
  const app = buildDatasetApplication(GHCN_MANIFEST);

  it('mints deterministic ids and palette colors', () => {
    expect(app.variables.map((v) => v.id)).toEqual(['ghcn-daily-date', 'ghcn-daily-station']);
    expect(app.variables.every((v) => typeof v.color === 'string' && v.color.length > 0)).toBe(true);
  });
  it('takes logicalType/shape from the manifest and derives dataset id + attribution', () => {
    expect(app.shape).toEqual([4]);
    expect(app.datasetId).toBe('ghcn-daily');
    expect(app.attribution).toBe('NOAA · PD');
    expect(app.variables[0].logicalType.generation).toBe('sorted');
  });
  it('typeAssignment defaults to the manifest bin dtype (numbers) / char16 (strings) — natural storage, no curated tuning', () => {
    expect(app.variables[0].typeAssignment.storageDtype).toBe('int32');
    expect(app.variables[1].typeAssignment.storageDtype).toBe('char16');
  });
  it('seeds provenance entries (returned as seededEntries, appended by the reducer)', () => {
    expect(app.seededEntries).toEqual([
      { key: 'source', value: 'NOAA' },
      { key: 'source_url', value: 'https://ncei.noaa.gov' },
      { key: 'retrieved', value: '2026-07-12' },
      { key: 'license', value: 'PD' },
    ]);
  });
});
