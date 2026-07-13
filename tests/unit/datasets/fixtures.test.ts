import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadPyodide } from 'pyodide';
import { validateManifest, fetchDatasetValues } from '../../../src/datasets/assets.ts';
import { DATASETS, datasetById } from '../../../src/datasets/registry.ts';
import { buildDatasetApplication } from '../../../src/datasets/apply.ts';
import { computePipelineStages } from '../../../src/engine/pipelineCompute.ts';
import { initPyodideRuntime } from '../../../src/engine/pyodideRuntime.ts';
import { DEFAULT_STATE, type AppState } from '../../../src/types/state.ts';

const ROOT = path.join(__dirname, '..', '..', 'fixtures', 'datasets');

// All three curated pipelines use pyodide-backed entropy codecs (deflate on
// etopo-dem/ghcn-daily, zstd on sst-field), so the roundtrip tests need the
// real runtime — same node-side loader pattern as realCodecs.test.ts.
// SKIP_PYODIDE=1 skips only the roundtrips; the name-pinning tests still run.
const skipPyodide = !!process.env.SKIP_PYODIDE;

beforeAll(async () => {
  if (skipPyodide) return;
  await initPyodideRuntime(undefined, () =>
    loadPyodide({ packageCacheDir: 'node_modules/.cache/pyodide' }));
}, 300_000);

function fsFetch(id: string): typeof fetch {
  return (async (url: string | URL | Request) => {
    const file = String(url).split('/').pop()!;
    const buf = readFileSync(path.join(ROOT, id, file));
    return new Response(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  }) as typeof fetch;
}

describe.each(DATASETS.map((d) => [d.id] as const))('fixture %s', (id) => {
  const manifest = validateManifest(JSON.parse(readFileSync(path.join(ROOT, id, 'manifest.json'), 'utf-8')));
  const entry = datasetById(id)!;

  it('matches the registry: model + every curated name exists in the manifest', () => {
    const names = new Set(manifest.variables.map((v) => v.name));
    for (const name of Object.keys(entry.curated.typeAssignments)) expect(names.has(name)).toBe(true);
    for (const name of Object.keys(entry.curated.fieldPipelines)) expect(names.has(name)).toBe(true);
  });

  it.skipIf(skipPyodide)('decodes, applies, computes, and read-roundtrips', async () => {
    const values = await fetchDatasetValues(manifest, (f) => `fixture://${id}/${f}`, fsFetch(id));
    const app = buildDatasetApplication(entry, manifest);
    const state: AppState = {
      ...structuredClone(DEFAULT_STATE),
      dataModel: entry.dataModel,
      dataset: app.dataset,
      shape: app.shape,
      chunkShape: app.chunkShape,
      interleaving: app.interleaving ?? DEFAULT_STATE.interleaving,
      linearization: app.linearization ?? structuredClone(DEFAULT_STATE).linearization,
      variables: app.variables,
      fieldPipelines: app.fieldPipelines,
      chunkPipeline: app.chunkPipeline,
      // Metadata must be on for the read step to succeed at all (the default
      // state ships with includeMetadata: false → an honest no-metadata fail).
      write: { ...structuredClone(DEFAULT_STATE).write, includeMetadata: true },
    };
    const result = computePipelineStages(state, undefined, values);
    expect(result.readResult.success).toBe(true);
  });
});
