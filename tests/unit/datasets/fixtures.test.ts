import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateManifest, fetchDatasetVariable } from '../../../src/datasets/assets.ts';
import { DATASETS, datasetById } from '../../../src/datasets/registry.ts';
import { computePipelineStages, type SourceValues } from '../../../src/engine/pipelineCompute.ts';
import { reconcileChunkShape, DEFAULT_STATE, type AppState, type Variable } from '../../../src/types/state.ts';
import { colors } from '../../../src/theme.ts';

const ROOT = path.join(__dirname, '..', '..', 'fixtures', 'datasets');

// Datasets are a catalog of curated variables now; a row binds by `source`.
// The fixture roundtrip is codec-free (no Pyodide runtime needed). Curated
// pipeline/chunking configs live in the top-level format presets, round-tripped
// in-browser by tests/ui/scenario-curated-variables.mjs.
const KNOWN_IDS = DATASETS.map((d) => d.id);

function fsFetch(id: string): typeof fetch {
  return (async (url: string | URL | Request) => {
    const file = String(url).split('/').pop()!;
    const buf = readFileSync(path.join(ROOT, id, file));
    return new Response(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  }) as typeof fetch;
}

describe.each(DATASETS.map((d) => [d.id] as const))('fixture %s', (id) => {
  const manifest = validateManifest(
    JSON.parse(readFileSync(path.join(ROOT, id, 'manifest.json'), 'utf-8')),
    KNOWN_IDS,
  );
  const entry = datasetById(id)!;

  it('registry model matches the fixture model', () => {
    expect(manifest.variables.every((v) => v.logicalType)).toBe(true);
    expect(entry.dataModel).toBeDefined();
  });

  it('decodes per-variable, binds by source, computes, and read-roundtrips codec-free', async () => {
    // One variable row per manifest variable, each bound to its curated source.
    const variables: Variable[] = manifest.variables.map((mv, i) => ({
      id: `${id}-${mv.name}`,
      name: mv.name,
      source: { datasetId: id, variableName: mv.name },
      logicalType: mv.logicalType,
      typeAssignment: mv.kind === 'number' ? { storageDtype: mv.dtype } : { storageDtype: 'char16' as const },
      color: colors.palette[i % colors.palette.length],
    }));

    // Build the worker-shaped sourceValues map by fetching each variable.
    const sourceValues: SourceValues = new Map();
    for (const mv of manifest.variables) {
      const values = await fetchDatasetVariable(manifest, mv.name, (f) => `fixture://${id}/${f}`, fsFetch(id));
      sourceValues.set(`${id}/${mv.name}`, { values, naturalShape: manifest.shape });
    }

    const state: AppState = {
      ...structuredClone(DEFAULT_STATE),
      dataModel: entry.dataModel,
      shape: [...manifest.shape],
      chunkShape: reconcileChunkShape(structuredClone(DEFAULT_STATE).chunkShape, manifest.shape),
      variables,
      fieldPipelines: Object.fromEntries(variables.map((v) => [v.id, []])),
      chunkPipeline: [],
      metadata: {
        ...structuredClone(DEFAULT_STATE).metadata,
        enabled: true,
        include: { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true, endianness: true },
      },
    };
    const result = computePipelineStages(state, undefined, sourceValues);
    expect(result.readResult.success).toBe(true);
  });
});
