import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DATASETS } from '../../../src/datasets/registry.ts';
import { CURATED_VARIABLES, curatedVariable, DATASET_SEED_ENTRIES } from '../../../src/datasets/registry.ts';
import type { DatasetManifest, ManifestVariable } from '../../../src/datasets/types.ts';
import geotiffesque from '../../../src/presets/geotiffesque.json';
import cogEsque from '../../../src/presets/cog-esque.json';
import zarrish from '../../../src/presets/zarrish.json';
import parquetAdjacent from '../../../src/presets/parquet-adjacent.json';

const ROOT = path.join(__dirname, '..', '..', 'fixtures', 'datasets');

function readManifestVariables(id: string): ManifestVariable[] {
  return readManifest(id).variables;
}

function readManifest(id: string): DatasetManifest {
  return JSON.parse(readFileSync(path.join(ROOT, id, 'manifest.json'), 'utf-8'));
}

type CustomEntry = { key: string; value: string };
const PRESET_ENTRIES: Record<string, CustomEntry[]> = {
  'etopo-dem': geotiffesque.metadata.customEntries as CustomEntry[],
  'copernicus-dem': cogEsque.metadata.customEntries as CustomEntry[],
  'sst-field': zarrish.metadata.customEntries as CustomEntry[],
  'ghcn-daily': parquetAdjacent.metadata.customEntries as CustomEntry[],
};

describe('CURATED_VARIABLES pinned against fixture manifests', () => {
  for (const dataset of DATASETS) {
    const manifestVars = readManifestVariables(dataset.id);

    for (const mv of manifestVars) {
      it(`${dataset.id}/${mv.name} matches its fixture manifest entry`, () => {
        const entry = CURATED_VARIABLES.find(
          (c) => c.datasetId === dataset.id && c.name === mv.name,
        );
        expect(entry, `no catalog entry for ${dataset.id}/${mv.name}`).toBeDefined();
        expect(entry!.kind).toBe(mv.kind);
        if (mv.kind === 'number') {
          // A scaled bin decodes to floats, so the catalog's drop-in dtype is
          // float32 rather than the bin's int (see CuratedVariable.dtype).
          expect(entry!.dtype).toBe(mv.scale ? 'float32' : mv.dtype);
        } else {
          expect(entry!.dtype).toBeUndefined();
        }
        expect(entry!.logicalType).toEqual(mv.logicalType);
        expect(entry!.dataModel).toBe(dataset.dataModel);
      });
    }
  }

  it('has exactly the 8 curated variables named in the plan, no extras', () => {
    const totalManifestVars = DATASETS.reduce(
      (sum, d) => sum + readManifestVariables(d.id).length,
      0,
    );
    expect(totalManifestVars).toBe(8);
    expect(CURATED_VARIABLES.length).toBe(8);
  });

  it('every entry has a non-empty label and attribution', () => {
    for (const entry of CURATED_VARIABLES) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.attribution.length).toBeGreaterThan(0);
      // label follows "Dataset label › name"
      const dataset = DATASETS.find((d) => d.id === entry.datasetId)!;
      expect(entry.label).toBe(`${dataset.label} › ${entry.name}`);
    }
  });
});

describe('curatedVariable()', () => {
  it('resolves each catalog entry by ref', () => {
    for (const entry of CURATED_VARIABLES) {
      const resolved = curatedVariable({ datasetId: entry.datasetId, variableName: entry.name });
      expect(resolved).toBe(entry);
    }
  });

  it('returns undefined for an unknown variable name within a known dataset', () => {
    expect(curatedVariable({ datasetId: 'etopo-dem', variableName: 'not-a-real-variable' })).toBeUndefined();
  });

  it('returns undefined for an unknown dataset id', () => {
    // @ts-expect-error deliberately passing a bad DatasetId to test runtime guard
    expect(curatedVariable({ datasetId: 'not-a-real-dataset', variableName: 'elevation' })).toBeUndefined();
  });
});

describe('DATASET_SEED_ENTRIES', () => {
  it('has an entry list for every dataset', () => {
    for (const dataset of DATASETS) {
      expect(DATASET_SEED_ENTRIES[dataset.id]).toBeDefined();
      expect(DATASET_SEED_ENTRIES[dataset.id].length).toBeGreaterThan(0);
    }
  });

  it('every seed key is unique per dataset', () => {
    for (const dataset of DATASETS) {
      const keys = DATASET_SEED_ENTRIES[dataset.id].map((e) => e.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('attribution seed values are copied verbatim from the matching preset customEntries', () => {
    for (const dataset of DATASETS) {
      const seed = new Map(DATASET_SEED_ENTRIES[dataset.id].map((e) => [e.key, e.value]));
      for (const presetEntry of PRESET_ENTRIES[dataset.id]) {
        expect(seed.get(presetEntry.key), `${dataset.id}.${presetEntry.key}`).toBe(presetEntry.value);
      }
    }
  });

  it('grid datasets seed a spatial block that JSON.parses to the fixture manifest spatial block', () => {
    for (const id of ['etopo-dem', 'sst-field', 'copernicus-dem'] as const) {
      const manifest = readManifest(id);
      const seed = new Map(DATASET_SEED_ENTRIES[id].map((e) => [e.key, e.value]));
      expect(manifest.spatial).toBeDefined();
      expect(seed.get('crs')).toBe(manifest.spatial!.crs);
      expect(JSON.parse(seed.get('bbox')!)).toEqual(manifest.spatial!.bbox);
      expect(JSON.parse(seed.get('transform')!)).toEqual(manifest.spatial!.transform);
    }
  });

  it('ghcn-daily has no spatial seed entries', () => {
    const keys = DATASET_SEED_ENTRIES['ghcn-daily'].map((e) => e.key);
    expect(keys).not.toContain('crs');
    expect(keys).not.toContain('bbox');
    expect(keys).not.toContain('transform');
  });

  it('ghcn-daily seeds units entries copied verbatim from the preset', () => {
    const seed = new Map(DATASET_SEED_ENTRIES['ghcn-daily'].map((e) => [e.key, e.value]));
    for (const key of ['date_units', 'temperature_units', 'precipitation_units']) {
      const presetEntry = PRESET_ENTRIES['ghcn-daily'].find((e) => e.key === key)!;
      expect(seed.get(key)).toBe(presetEntry.value);
    }
  });

  it('ghcn-daily fixture manifest has no spatial block', () => {
    expect(readManifest('ghcn-daily').spatial).toBeUndefined();
  });
});
