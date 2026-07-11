import { useEffect, useRef, useState } from 'react';
import type { AppState } from '../types/state.ts';
import type { PipelineResult } from '../engine/pipelineCompute.ts';
import { PipelineWorkerClient, createPipelineWorker, type WorkerLike, type WorkerDiagnostics } from '../worker/client.ts';

const IDLE_DIAGNOSTICS: WorkerDiagnostics = {
  status: 'idle',
  respawnCount: 0,
  lastTimings: null,
  lastTotalMs: null,
  lastError: null,
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

  useEffect(() => {
    setComputing(true);
    clientRef.current!.compute(state);
  }, [state]);

  useEffect(() => () => clientRef.current!.dispose(), []);

  return { result, computing, diagnostics };
}
