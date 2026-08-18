import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DATASETS } from '../../../src/datasets/registry.ts';
import { CURATED_VARIABLES, curatedVariable } from '../../../src/datasets/registry.ts';
import type { ManifestVariable } from '../../../src/datasets/types.ts';

const ROOT = path.join(__dirname, '..', '..', 'fixtures', 'datasets');

function readManifestVariables(id: string): ManifestVariable[] {
  const raw = JSON.parse(readFileSync(path.join(ROOT, id, 'manifest.json'), 'utf-8'));
  return raw.variables as ManifestVariable[];
}

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

  it('has exactly the 7 curated variables named in the plan, no extras', () => {
    const totalManifestVars = DATASETS.reduce(
      (sum, d) => sum + readManifestVariables(d.id).length,
      0,
    );
    expect(totalManifestVars).toBe(7);
    expect(CURATED_VARIABLES.length).toBe(7);
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
