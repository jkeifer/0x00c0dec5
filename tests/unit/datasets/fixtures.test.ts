import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateManifest, fetchDatasetValues } from '../../../src/datasets/assets.ts';
import { DATASETS, datasetById } from '../../../src/datasets/registry.ts';
import { buildDatasetApplication } from '../../../src/datasets/apply.ts';
import { computePipelineStages } from '../../../src/engine/pipelineCompute.ts';
import { reconcileChunkShape, DEFAULT_STATE, type AppState } from '../../../src/types/state.ts';

const ROOT = path.join(__dirname, '..', '..', 'fixtures', 'datasets');

// Datasets now apply SCHEMA + METADATA ONLY (no curated codecs), so the
// fixture roundtrip is codec-free and needs no Pyodide runtime. The curated
// pipeline/chunking configs moved into the top-level format presets, which are
// round-tripped in-browser by tests/ui/scenario-dataset-presets.mjs.
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
    // Sanity: the fixture exists and its variables all have logicalTypes.
    expect(manifest.variables.every((v) => v.logicalType)).toBe(true);
    expect(entry.dataModel).toBeDefined();
  });

  it('decodes, applies (schema+metadata only), computes, and read-roundtrips codec-free', async () => {
    const values = await fetchDatasetValues(manifest, (f) => `fixture://${id}/${f}`, fsFetch(id));
    const app = buildDatasetApplication(manifest);
    const state: AppState = {
      ...structuredClone(DEFAULT_STATE),
      dataModel: entry.dataModel,
      dataset: { id: app.datasetId, attribution: app.attribution, seededEntries: app.seededEntries },
      shape: app.shape,
      chunkShape: reconcileChunkShape(structuredClone(DEFAULT_STATE).chunkShape, app.shape),
      variables: app.variables,
      // Schema-only apply => empty field pipelines for each variable.
      fieldPipelines: Object.fromEntries(app.variables.map((v) => [v.id, []])),
      chunkPipeline: [],
      // Metadata must be on for the read step to succeed at all (the default
      // state ships with includeMetadata: false → an honest no-metadata fail).
      write: { ...structuredClone(DEFAULT_STATE).write, includeMetadata: true },
    };
    const result = computePipelineStages(state, undefined, values);
    expect(result.readResult.success).toBe(true);
  });
});
