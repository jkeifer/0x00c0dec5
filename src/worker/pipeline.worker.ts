import { computePipelineStages } from '../hooks/usePipeline.ts';
import { collectTransferables, type WorkerRequest, type WorkerResponse, type StageTimings } from './protocol.ts';

// Whole-pipeline recompute per message; Task 13 adds per-stage memoization
// inside computePipelineStages (spec: metadata keystrokes must not re-run codecs).
//
// `self` here is typed via the DOM lib (this file is compiled under the same
// tsconfig as the rest of src/, which has "DOM" not "WebWorker" in `lib` —
// adding "WebWorker" would conflict with DOM's incompatible `self` typing).
// Rather than fork tsconfig for one file, we cast through `unknown` to the
// structural bits of the real DedicatedWorkerGlobalScope API (onmessage,
// postMessage) we actually use, matching the brief's specified pattern.
self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.kind !== 'compute') return;
  const timings: StageTimings = {};
  const t0 = performance.now();
  try {
    const result = computePipelineStages(msg.state, (stage, ms) => {
      timings[stage] = ms;
      (self as unknown as Worker).postMessage({ kind: 'progress', id: msg.id, stage } satisfies WorkerResponse);
    });
    (self as unknown as Worker).postMessage(
      { kind: 'result', id: msg.id, ok: true, result, timings, totalMs: performance.now() - t0 } satisfies WorkerResponse,
      collectTransferables(result),
    );
  } catch (err) {
    (self as unknown as Worker).postMessage(
      { kind: 'result', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies WorkerResponse);
  }
};
