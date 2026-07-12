// Imports from src/engine/pipelineCompute.ts directly (NOT src/hooks/usePipeline.ts,
// which is a thin re-export but still a module under src/hooks/ — importing
// the engine module directly keeps this worker's dependency graph visibly
// react-free; see CLAUDE.md/Task 13 brief's react-free-bundle requirement,
// verified by inspecting the built worker chunk for `react`/`useMemo`).
import { createPipelineComputer } from '../engine/pipelineCompute.ts';
import { collectTransferables } from './protocol.ts';
import type { WorkerRequest, WorkerResponse, StageTimings } from './protocol.ts';
import { initPyodideRuntime } from '../engine/pyodideRuntime.ts';
import { stateUsesPyodideCodec } from '../engine/codecs.ts';

// One memoizing computer for the worker's lifetime (Task 13 Step 2b): caches
// each stage's output keyed by the state slices it reads, so a metadata
// keystroke does not re-run generation/typing/chunking/encoding.
const computeDelta = createPipelineComputer();

const post = (msg: WorkerResponse) => (self as unknown as Worker).postMessage(msg);

// Project 4: load the Python runtime eagerly at worker startup, narrating
// progress. Computes that don't use a real codec never wait on this; ones
// that do await `runtimeReady` below (a failed load surfaces per-compute
// through the existing ok:false path — and as a runtime-status error banner).
const runtimeReady = initPyodideRuntime((e) =>
  post({ kind: 'runtime-status', status: 'loading', step: e.step, stepState: e.state }),
).then(
  () => post({ kind: 'runtime-status', status: 'ready' }),
  (err) => {
    post({ kind: 'runtime-status', status: 'error', error: err instanceof Error ? err.message : String(err) });
    throw err;
  },
);
runtimeReady.catch(() => { /* handled per-compute; avoid unhandled rejection */ });

// PERF-1: results are posted as stage DELTAS with a transfer list. The full
// PipelineResult's structured clone threw "Data cannot be cloned, out of
// memory" above ~8.38M values (~400MB); transfer is zero-copy and has no such
// ceiling. Transfer detaches buffers on this side — the Task 13 conflict with
// memoization — which the computer resolves by evicting every stage whose
// payload is included in the delta (see the evict-on-send comment in
// pipelineCompute.ts). Omitted stages (memo key already held by the client,
// per msg.knownKeys) contribute no buffers to the message at all.

// `self` here is typed via the DOM lib (this file is compiled under the same
// tsconfig as the rest of src/, which has "DOM" not "WebWorker" in `lib` —
// adding "WebWorker" would conflict with DOM's incompatible `self` typing).
// Rather than fork tsconfig for one file, we cast through `unknown` to the
// structural bits of the real DedicatedWorkerGlobalScope API (onmessage,
// postMessage) we actually use, matching the brief's specified pattern.
self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.kind !== 'compute') return;
  const timings: StageTimings = {};
  const t0 = performance.now();
  try {
    if (stateUsesPyodideCodec(msg.state)) await runtimeReady;
    const delta = computeDelta(msg.state, msg.knownKeys, (stage, ms) => {
      timings[stage] = ms;
      post({ kind: 'progress', id: msg.id, stage } satisfies WorkerResponse);
    });
    (self as unknown as Worker).postMessage(
      { kind: 'result', id: msg.id, ok: true, delta, timings, totalMs: performance.now() - t0 } satisfies WorkerResponse,
      collectTransferables(delta),
    );
  } catch (err) {
    post({ kind: 'result', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies WorkerResponse);
  }
};
