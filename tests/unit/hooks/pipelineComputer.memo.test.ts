// Gate test for Phase 3.2 (remediation-plan.md, fixes SW-3), Task 13's Step
// 2b (perf plan), and PERF-1's stage-delta protocol: the worker-side
// `createPipelineComputer` memoizes each stage on exactly the state slices it
// reads, and now returns a per-stage DELTA instead of a full PipelineResult —
// a stage whose memo key matches the caller's `knownKeys` entry has its
// payload omitted (the main thread already holds it), and any stage whose
// payload IS included is evicted from the worker cache (its buffers get
// transferred/detached by postMessage, so the cached value would be garbage).
// The old dependency-boundary guarantee — typing a metadata custom entry must
// not recompute generation/typing/chunking/encoding — is now expressed as
// "only metadata/write/read payloads are resent".
import { describe, it, expect } from 'vitest';
import {
  createPipelineComputer,
  computePipelineStages,
  assemblePipelineResult,
  type PipelineDelta,
  type StagePayloads,
} from '../../../src/engine/pipelineCompute.ts';
import { STAGE_ORDER, type StageName } from '../../../src/types/pipeline.ts';
import { DEFAULT_STATE } from '../../../src/types/state.ts';
import type { AppState } from '../../../src/types/state.ts';

function knownKeysOf(delta: PipelineDelta): Partial<Record<StageName, string>> {
  const keys: Partial<Record<StageName, string>> = {};
  for (const s of STAGE_ORDER) keys[s] = delta[s].key;
  return keys;
}

function applyDelta(store: Partial<StagePayloads>, delta: PipelineDelta): StagePayloads {
  for (const s of STAGE_ORDER) {
    const payload = delta[s].payload;
    if (payload !== undefined) (store as Record<StageName, unknown>)[s] = payload;
  }
  return store as StagePayloads;
}

function sentStages(delta: PipelineDelta): StageName[] {
  return STAGE_ORDER.filter((s) => delta[s].payload !== undefined);
}

const metadataChanged: AppState = {
  ...DEFAULT_STATE,
  metadata: {
    ...DEFAULT_STATE.metadata,
    // Metadata redesign Task 3: the master switch must be on for the
    // Metadata stage to produce any bytes at all (DEFAULT_STATE has it off).
    enabled: true,
    // Custom entries are ungated by include-group toggles (metadata redesign
    // Task 2), so `descriptive` doesn't need to be on for the "hello" sanity
    // check below — left on here anyway since this test isn't exercising
    // include-group filtering.
    include: { ...DEFAULT_STATE.metadata.include, descriptive: true },
    customEntries: [{ key: 'note', value: 'hello' }],
  },
};

describe('createPipelineComputer delta protocol', () => {
  it('first compute (no knownKeys) sends every stage payload; assembled result matches the uncached reference', () => {
    const compute = createPipelineComputer();
    const delta = compute(DEFAULT_STATE);
    expect(sentStages(delta)).toEqual(STAGE_ORDER);

    const assembled = assemblePipelineResult(applyDelta({}, delta));
    const reference = computePipelineStages(DEFAULT_STATE);
    expect(assembled.stages.map((s) => s.name)).toEqual(reference.stages.map((s) => s.name));
    for (let i = 0; i < assembled.stages.length; i++) {
      expect(Array.from(assembled.stages[i].bytes)).toEqual(Array.from(reference.stages[i].bytes));
    }
    expect(assembled.logicalValues).toEqual(reference.logicalValues);
    expect(assembled.typedValues).toEqual(reference.typedValues);
    expect(assembled.variableStats).toEqual(reference.variableStats);
    expect(assembled.readResult.success).toBe(reference.readResult.success);
    expect(assembled.files.map((f) => f.name)).toEqual(reference.files.map((f) => f.name));
    expect([...assembled.stageSources.keys()]).toEqual([...reference.stageSources.keys()]);
  });

  it('same state again with knownKeys sends nothing (keys only)', () => {
    const compute = createPipelineComputer();
    const first = compute(DEFAULT_STATE);
    const second = compute(DEFAULT_STATE, knownKeysOf(first));
    expect(sentStages(second)).toEqual([]);
    for (const s of STAGE_ORDER) expect(second[s].key).toBe(first[s].key);
  });

  it('a metadata customEntries change resends only metadata/write/read', () => {
    const compute = createPipelineComputer();
    const first = compute(DEFAULT_STATE);
    const second = compute(metadataChanged, knownKeysOf(first));
    expect(sentStages(second)).toEqual(['metadata', 'write', 'read']);
    // Upstream keys unchanged — the main thread's copies are still valid.
    for (const s of ['values', 'typed', 'linearized', 'encoded'] as const) {
      expect(second[s].key).toBe(first[s].key);
    }
    // Sanity: the Metadata stage payload actually picked up the change.
    const metaText = new TextDecoder().decode(second.metadata.payload!.stage.bytes);
    expect(metaText).toContain('hello');
  });

  it('a codec param change resends only encoded/metadata/write/read', () => {
    const withEmptyPipeline: AppState = {
      ...DEFAULT_STATE,
      fieldPipelines: { ...DEFAULT_STATE.fieldPipelines, temperature: [] },
    };
    const compute = createPipelineComputer();
    const first = compute(withEmptyPipeline);
    const withDelta: AppState = {
      ...withEmptyPipeline,
      fieldPipelines: {
        ...withEmptyPipeline.fieldPipelines,
        temperature: [{ codec: 'delta', params: {} }],
      },
    };
    const second = compute(withDelta, knownKeysOf(first));
    expect(sentStages(second)).toEqual(['encoded', 'metadata', 'write', 'read']);
  });

  it('a shape change resends everything', () => {
    const compute = createPipelineComputer();
    const first = compute(DEFAULT_STATE);
    const changed: AppState = { ...DEFAULT_STATE, shape: [DEFAULT_STATE.shape[0] * 2] };
    const second = compute(changed, knownKeysOf(first));
    expect(sentStages(second)).toEqual(STAGE_ORDER);
  });

  it('assembled result stays correct across incremental delta applications', () => {
    const compute = createPipelineComputer();
    const store: Partial<StagePayloads> = {};
    const first = compute(DEFAULT_STATE);
    applyDelta(store, first);
    const beforeValuesStage = store.values!.stage;

    const second = compute(metadataChanged, knownKeysOf(first));
    applyDelta(store, second);

    const assembled = assemblePipelineResult(store as StagePayloads);
    const reference = computePipelineStages(metadataChanged);
    for (let i = 0; i < assembled.stages.length; i++) {
      expect(Array.from(assembled.stages[i].bytes)).toEqual(Array.from(reference.stages[i].bytes));
    }
    // Omitted upstream stage objects are literally the ones from the first
    // delta — reference identity, same contract the old memo test pinned.
    expect(store.values!.stage).toBe(beforeValuesStage);
  });

  it('sent stages are evicted (recomputed next call), unsent stages stay cached: onStage reports 0ms only once warm', () => {
    const compute = createPipelineComputer();
    const first = compute(DEFAULT_STATE); // everything sent -> everything evicted

    // Second call, same state: keys match knownKeys so nothing is sent, but
    // the evicted stages had to be recomputed (real timings, not asserted).
    // Because nothing was sent this time, the cache is warm again afterward.
    const second = compute(DEFAULT_STATE, knownKeysOf(first));
    expect(sentStages(second)).toEqual([]);

    // Third call, metadata-only change: upstream stages are true cache hits.
    const timings: Record<string, number> = {};
    compute(metadataChanged, knownKeysOf(second), (stage, ms) => { timings[stage] = ms; });
    expect(timings['values']).toBe(0);
    expect(timings['typed']).toBe(0);
    expect(timings['linearized']).toBe(0);
    expect(timings['encoded']).toBe(0);
    expect(timings['metadata']).toBeGreaterThanOrEqual(0);
  });

  it('a fresh computer (worker respawn) with the client\'s knownKeys resends nothing the client already holds', () => {
    const oldComputer = createPipelineComputer();
    const first = oldComputer(DEFAULT_STATE);

    const respawned = createPipelineComputer(); // empty cache
    const second = respawned(DEFAULT_STATE, knownKeysOf(first));
    expect(sentStages(second)).toEqual([]); // recomputed fresh, but keys match — nothing resent
  });

  it('a state.ui-only change is a memo hit on every stage, including metadata/write/read', () => {
    const compute = createPipelineComputer();
    const first = compute(DEFAULT_STATE); // everything sent -> everything evicted
    // Warm the cache back up (same state, nothing sent) before checking hits,
    // matching the eviction pattern in the test above.
    const warm = compute(DEFAULT_STATE, knownKeysOf(first));
    expect(sentStages(warm)).toEqual([]);

    const uiChanged: AppState = { ...DEFAULT_STATE, ui: { ...DEFAULT_STATE.ui, rightPaneView: 'grid' } };
    const timings: Record<string, number> = {};
    const second = compute(uiChanged, knownKeysOf(warm), (stage, ms) => { timings[stage] = ms; });
    expect(sentStages(second)).toEqual([]);
    for (const s of STAGE_ORDER) expect(timings[s]).toBe(0);
  });
});
