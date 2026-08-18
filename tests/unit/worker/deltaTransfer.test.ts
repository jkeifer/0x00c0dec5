// PERF-1: the worker posts stage-delta results with a transfer list (zero-copy)
// instead of structured-cloning the full ~hundreds-of-MB PipelineResult (which
// threw "Data cannot be cloned, out of memory" above ~8.38M values). Transfer
// DETACHES every listed buffer on the sending side — the exact failure mode
// that made Task 13 drop transferables — so this test simulates the full
// worker loop with real detaching (Node's structuredClone supports transfer)
// and proves the computer never hands postMessage a detached buffer:
// every sent payload's buffers are freshly computed (evict-on-send), and
// omitted stages' buffers never enter the message at all.
import { describe, it, expect } from 'vitest';
import {
  createPipelineComputer,
  computePipelineStages,
  assemblePipelineResult,
  type PipelineDelta,
  type StagePayloads,
} from '../../../src/engine/pipelineCompute.ts';
import { collectTransferables } from '../../../src/worker/protocol.ts';
import { STAGE_ORDER, type StageName } from '../../../src/types/pipeline.ts';
import { DEFAULT_STATE } from '../../../src/types/state.ts';
import type { AppState } from '../../../src/types/state.ts';

/** One round of the worker loop: compute the delta, then post it with a
 * transfer list — structuredClone with transfer detaches the buffers on the
 * "worker" side exactly like postMessage does. Returns the "main thread"'s
 * received copy. Throws if any buffer is detached or listed twice, exactly
 * like the real postMessage. */
function computeAndPost(
  compute: ReturnType<typeof createPipelineComputer>,
  state: AppState,
  knownKeys?: Partial<Record<StageName, string>>,
): PipelineDelta {
  const delta = compute(state, knownKeys);
  return structuredClone(delta, { transfer: collectTransferables(delta) });
}

function apply(store: Partial<StagePayloads>, delta: PipelineDelta): Partial<Record<StageName, string>> {
  const keys: Partial<Record<StageName, string>> = {};
  for (const s of STAGE_ORDER) {
    if (delta[s].payload !== undefined) (store as Record<StageName, unknown>)[s] = delta[s].payload;
    keys[s] = delta[s].key;
  }
  return keys;
}

function expectMatchesReference(store: Partial<StagePayloads>, state: AppState) {
  const assembled = assemblePipelineResult(store as StagePayloads);
  const reference = computePipelineStages(state);
  for (let i = 0; i < reference.stages.length; i++) {
    expect(Array.from(assembled.stages[i].bytes)).toEqual(Array.from(reference.stages[i].bytes));
  }
  expect(assembled.logicalValues).toEqual(reference.logicalValues);
  expect(assembled.typedValues).toEqual(reference.typedValues);
  expect(assembled.readResult.success).toBe(reference.readResult.success);
}

describe('delta transfer with real buffer detaching', () => {
  it('survives boot -> chunkShape change -> codec change -> metadata change, matching the reference each time', () => {
    const compute = createPipelineComputer();
    const store: Partial<StagePayloads> = {};

    // Boot: everything sent and transferred (all worker-side buffers detach).
    let keys = apply(store, computeAndPost(compute, DEFAULT_STATE));
    expectMatchesReference(store, DEFAULT_STATE);

    // chunkShape change: linearized+ recompute; typed/values were evicted at
    // boot (their buffers are detached) so they must recompute, NOT hand back
    // detached cache entries. This is the exact crash Task 13 hit.
    const chunkChanged: AppState = { ...DEFAULT_STATE, chunkShape: [Math.max(1, Math.floor(DEFAULT_STATE.chunkShape[0] / 2))] };
    keys = apply(store, computeAndPost(compute, chunkChanged, keys));
    expectMatchesReference(store, chunkChanged);

    // Codec change on top: encoded+ resent.
    const codecChanged: AppState = {
      ...chunkChanged,
      fieldPipelines: { ...chunkChanged.fieldPipelines, temperature: [{ codec: 'delta', params: {} }] },
    };
    keys = apply(store, computeAndPost(compute, codecChanged, keys));
    expectMatchesReference(store, codecChanged);

    // Metadata change on top: metadata+ resent; upstream all cache hits.
    const metaChanged: AppState = {
      ...codecChanged,
      metadata: { ...codecChanged.metadata, customEntries: [{ key: 'k', value: 'v' }] },
    };
    const delta = computeAndPost(compute, metaChanged, keys);
    expect(STAGE_ORDER.filter((s) => delta[s].payload !== undefined)).toEqual(['metadata', 'write', 'read']);
    apply(store, delta);
    expectMatchesReference(store, metaChanged);
  });

  it('repeating the same state after a transfer neither resends nor throws', () => {
    const compute = createPipelineComputer();
    const store: Partial<StagePayloads> = {};
    const keys = apply(store, computeAndPost(compute, DEFAULT_STATE));
    const second = computeAndPost(compute, DEFAULT_STATE, keys);
    expect(STAGE_ORDER.filter((s) => second[s].payload !== undefined)).toEqual([]);
  });
});

describe('collectTransferables (generic walker)', () => {
  it('collects every buffer reachable from sent payloads, deduped, and nothing from omitted stages', () => {
    const compute = createPipelineComputer();
    const first = compute(DEFAULT_STATE);
    const list = collectTransferables(first);
    const set = new Set(list);
    expect(list.length).toBe(set.size); // no duplicates (transfer list requirement)
    for (const s of STAGE_ORDER) {
      expect(set.has(first[s].payload!.stage.bytes.buffer as ArrayBuffer)).toBe(true);
    }
    // Shared buffers (readResult.reconstructedValues vs the read payload's
    // logical values map) appear once — that's what the Set is for.

    const keys: Partial<Record<StageName, string>> = {};
    for (const s of STAGE_ORDER) keys[s] = first[s].key;
    const metaChanged: AppState = {
      ...DEFAULT_STATE,
      metadata: { ...DEFAULT_STATE.metadata, customEntries: [{ key: 'a', value: 'b' }] },
    };
    const second = compute(metaChanged, keys);
    const secondList = new Set(collectTransferables(second));
    // Omitted stages contribute nothing.
    expect(secondList.has(first.values.payload!.stage.bytes.buffer as ArrayBuffer)).toBe(false);
    expect(secondList.has(second.metadata.payload!.stage.bytes.buffer as ArrayBuffer)).toBe(true);
  });
});
