import { useEffect, useRef, useState } from 'react';
import type { AppState } from '../types/state.ts';
import type { PipelineResult } from '../engine/pipelineCompute.ts';
import { PipelineWorkerClient, createPipelineWorker, INITIAL_RUNTIME_STATE, type WorkerLike, type WorkerDiagnostics } from '../worker/client.ts';

const IDLE_DIAGNOSTICS: WorkerDiagnostics = {
  status: 'idle',
  respawnCount: 0,
  lastTimings: null,
  lastTotalMs: null,
  lastError: null,
  runtime: INITIAL_RUNTIME_STATE,
};

export interface UseWorkerPipelineResult {
  result: PipelineResult | null;
  computing: boolean;
  diagnostics: WorkerDiagnostics;
}

/**
 * Task 13 (perf plan): worker-backed replacement for the old chained-useMemo
 * `usePipeline` hook (deleted; its pure compute code lives on in
 * src/engine/pipelineCompute.ts). Every state change posts to
 * `PipelineWorkerClient` (Task 12's latest-wins coalescing client); `result`
 * holds the last-good `PipelineResult` and is retained (stale-view UX) while
 * `computing` is true for a newer in-flight state.
 *
 * `createWorker` is injectable for tests (FakeWorker); defaults to the real
 * `createPipelineWorker`.
 */
export function useWorkerPipeline(
  state: AppState,
  createWorker: () => WorkerLike = createPipelineWorker,
): UseWorkerPipelineResult {
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [computing, setComputing] = useState(true);
  const [diagnostics, setDiagnostics] = useState<WorkerDiagnostics>(IDLE_DIAGNOSTICS);

  const clientRef = useRef<PipelineWorkerClient | null>(null);
  if (clientRef.current === null) {
    clientRef.current = new PipelineWorkerClient({
      createWorker,
      onResult: (r, diag) => {
        setResult(r);
        setDiagnostics(diag);
      },
      onStatus: (diag) => {
        setDiagnostics(diag);
        setComputing(diag.status === 'computing');
      },
    });
  }

  // Recompute only when a PIPELINE input changes. `state.ui` (pane
  // selections, view modes, diff toggle) lives in the same AppState object,
  // and depending on `[state]` fired a full worker round-trip — result
  // structured-clone included — on every pane click (measured ~1.3s at 1M
  // elements for a change that recomputes nothing). Immer keeps untouched
  // slice identities stable, so depending on the slices themselves skips
  // ui-only changes. The posted state still carries `ui`; the worker's
  // stage memos never key on it.
  //
  // `linearization` and `byteOrder` (added by the codec-curation project)
  // are pipeline inputs like any other: linearization permutes each chunk's
  // element order, byteOrder changes every multi-byte value's encoding at
  // every stage. They were originally missing from this list, which made the
  // Chunk section's Order/Byte order controls silently show stale results —
  // any new AppState field that reaches pipelineCompute must be added here.
  const { dataModel, shape, chunkShape, interleaving, linearization, byteOrder, variables, fieldPipelines, chunkPipeline, metadata, write } = state;
  useEffect(() => {
    setComputing(true);
    clientRef.current!.compute(state);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberate: `state` is posted whole, but only pipeline slices trigger
  }, [dataModel, shape, chunkShape, interleaving, linearization, byteOrder, variables, fieldPipelines, chunkPipeline, metadata, write]);

  useEffect(() => () => clientRef.current!.dispose(), []);

  return { result, computing, diagnostics };
}
