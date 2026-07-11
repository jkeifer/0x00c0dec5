// Imports from src/engine/pipelineCompute.ts directly (NOT src/hooks/usePipeline.ts,
// which is a thin re-export but still a module under src/hooks/ — importing
// the engine module directly keeps this worker's dependency graph visibly
// react-free; see CLAUDE.md/Task 13 brief's react-free-bundle requirement,
// verified by inspecting the built worker chunk for `react`/`useMemo`).
import { createPipelineComputer } from '../engine/pipelineCompute.ts';
import type { WorkerRequest, WorkerResponse, StageTimings } from './protocol.ts';

// One memoizing computer for the worker's lifetime (Task 13 Step 2b): caches
// each stage's output keyed by the state slices it reads, so a metadata
// keystroke does not re-run generation/typing/chunking/encoding.
const computePipelineStages = createPipelineComputer();

// NOT using protocol.ts's collectTransferables()/Task 12's transfer-list
// optimization here: Task 12 built it against an uncached compute (every
// message's buffers were fresh). Task 13's memoizer reuses the SAME
// ArrayBuffer instances across messages for cache-hit stages (that's the
// whole point — no recompute), but a transferred buffer is DETACHED from
// this thread; a cache hit on a later message would then hand back a
// reference to already-detached memory, and postMessage throws synchronously
// trying to clone/transfer it ("ArrayBuffer ... already detached" /
// "detached and could not be cloned") — which surfaced as every subsequent
// compute silently failing (`ok: false`) with no way to recover, since the
// bad buffer stays cached forever. Transfer and per-stage memoization are
// incompatible for the same object: whichever stages are cached must never
// be transferred. Rather than track cache-hit/miss per buffer (fragile —
// today's miss is next message's hit), we drop the transfer list and let
// structured clone copy the result; the memoizer's whole point is avoiding
// *recompute*, and a clone of the (already-small, serialized) stage bytes is
// far cheaper than that recompute, so this is the right trade.

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
    );
  } catch (err) {
    (self as unknown as Worker).postMessage(
      { kind: 'result', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies WorkerResponse);
  }
};
