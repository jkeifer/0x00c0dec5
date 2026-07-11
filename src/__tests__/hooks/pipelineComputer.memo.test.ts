// Gate test for Phase 3.2 (remediation-plan.md, fixes SW-3) and Task 13's
// Step 2b (perf plan): the old chained-useMemo `usePipeline` hook was deleted
// (its pure compute code moved to src/engine/pipelineCompute.ts, react-free
// so pipeline.worker.ts's bundle doesn't pull react in). Its dependency-
// boundary guarantee — typing into a metadata custom-entry field (or any
// other late-stage-only input) must not recompute generation/typing/
// chunking/encoding — now lives in `createPipelineComputer`'s per-stage
// memoization, exercised here directly (no React/jsdom needed: the computer
// is a plain closure over a state, unlike the deleted hook).
import { describe, it, expect } from 'vitest';
import { createPipelineComputer, computePipelineStages } from '../../engine/pipelineCompute.ts';
import { DEFAULT_STATE } from '../../types/state.ts';
import type { AppState } from '../../types/state.ts';

const STAGE_NAMES = ['Values', 'Typed', 'Linearized', 'Encoded', 'Metadata', 'Write', 'Read'] as const;

function stageByName(result: ReturnType<typeof computePipelineStages>, name: string) {
  const stage = result.stages.find((s) => s.name === name);
  if (!stage) throw new Error(`stage ${name} not found`);
  return stage;
}

describe('createPipelineComputer memoization boundaries', () => {
  it('produces the fixed 7-stage list', () => {
    const compute = createPipelineComputer();
    const result = compute(DEFAULT_STATE);
    expect(result.stages.map((s) => s.name)).toEqual(STAGE_NAMES);
  });

  it('a metadata customEntries change leaves stages[0..3] (Values..Encoded) reference-identical across calls', () => {
    const compute = createPipelineComputer();
    const before = compute(DEFAULT_STATE);

    const changed: AppState = {
      ...DEFAULT_STATE,
      metadata: {
        ...DEFAULT_STATE.metadata,
        customEntries: [{ key: 'note', value: 'hello' }],
      },
    };
    const after = compute(changed);

    // stages[0..3]: Values, Typed, Linearized, Encoded
    for (let i = 0; i <= 3; i++) {
      expect(after.stages[i]).toBe(before.stages[i]);
    }

    // Sanity: the Metadata stage itself DID pick up the change.
    const metaText = new TextDecoder().decode(stageByName(after, 'Metadata').bytes);
    expect(metaText).toContain('hello');
  });

  it('a shape change invalidates everything (no stage is reference-identical)', () => {
    const compute = createPipelineComputer();
    const before = compute(DEFAULT_STATE);

    const changed: AppState = { ...DEFAULT_STATE, shape: [DEFAULT_STATE.shape[0] * 2] };
    const after = compute(changed);

    for (let i = 0; i < before.stages.length; i++) {
      expect(after.stages[i]).not.toBe(before.stages[i]);
    }
  });

  it('a codec param change leaves Values/Typed/Linearized stable but changes Encoded', () => {
    const withEmptyPipeline: AppState = {
      ...DEFAULT_STATE,
      fieldPipelines: { ...DEFAULT_STATE.fieldPipelines, temperature: [] },
    };
    const compute = createPipelineComputer();
    const before = compute(withEmptyPipeline);

    const withDelta: AppState = {
      ...withEmptyPipeline,
      fieldPipelines: {
        ...withEmptyPipeline.fieldPipelines,
        temperature: [{ codec: 'delta', params: { order: 1 } }],
      },
    };
    const after = compute(withDelta);

    expect(stageByName(after, 'Values')).toBe(stageByName(before, 'Values'));
    expect(stageByName(after, 'Typed')).toBe(stageByName(before, 'Typed'));
    expect(stageByName(after, 'Linearized')).toBe(stageByName(before, 'Linearized'));
    expect(stageByName(after, 'Encoded')).not.toBe(stageByName(before, 'Encoded'));
    expect(Array.from(stageByName(after, 'Encoded').bytes)).not.toEqual(Array.from(stageByName(before, 'Encoded').bytes));
  });

  it('reports 0ms via onStage for cache hits, non-zero-or-real timing for misses', () => {
    const compute = createPipelineComputer();
    compute(DEFAULT_STATE); // warm the cache

    const changed: AppState = {
      ...DEFAULT_STATE,
      metadata: { ...DEFAULT_STATE.metadata, customEntries: [{ key: 'a', value: 'b' }] },
    };
    const timings: Record<string, number> = {};
    compute(changed, (stage, ms) => { timings[stage] = ms; });

    // Upstream stages (unaffected by a metadata-only change) are cache hits -> 0ms.
    expect(timings['values']).toBe(0);
    expect(timings['typed']).toBe(0);
    expect(timings['linearized']).toBe(0);
    expect(timings['encoded']).toBe(0);
    // Metadata (and downstream) changed -> a miss, timings key still present.
    expect(timings['metadata']).toBeGreaterThanOrEqual(0);
  });

  it('matches computePipelineStages output for a given state (uncached reference)', () => {
    const compute = createPipelineComputer();
    const memoized = compute(DEFAULT_STATE);
    const reference = computePipelineStages(DEFAULT_STATE);
    expect(memoized.stages.map((s) => s.name)).toEqual(reference.stages.map((s) => s.name));
    for (let i = 0; i < memoized.stages.length; i++) {
      expect(Array.from(memoized.stages[i].bytes)).toEqual(Array.from(reference.stages[i].bytes));
    }
  });
});
