// @vitest-environment jsdom
//
// Task 13 (perf plan): useWorkerPipeline replaces the deleted chained-useMemo
// usePipeline hook with a worker-backed one. jsdom is needed for renderHook
// (same pattern as the former usePipeline.memo.test.tsx / other component
// tests — see CLAUDE.md's per-file `@vitest-environment jsdom` pragma
// convention). FakeWorker mirrors src/__tests__/worker/client.test.ts's.
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useWorkerPipeline } from '../../../src/hooks/useWorkerPipeline.ts';
import { DEFAULT_STATE } from '../../../src/types/state.ts';
import type { WorkerLike } from '../../../src/worker/client.ts';
import { createPipelineComputer, type PipelineDelta } from '../../../src/engine/pipelineCompute.ts';
import type { WorkerRequest, WorkerResponse } from '../../../src/worker/protocol.ts';
import type { AppState } from '../../../src/types/state.ts';

// A real full delta (PERF-1 stage-delta protocol) — what the worker's first
// compute produces. The hook itself only sees the assembled PipelineResult.
const FULL_DELTA: PipelineDelta = createPipelineComputer()(DEFAULT_STATE);

type Listener = (e: { data?: WorkerResponse; message?: string }) => void;

class FakeWorker implements WorkerLike {
  posted: WorkerRequest[] = [];
  listeners: Record<'message' | 'error', Listener[]> = { message: [], error: [] };
  terminated = false;
  postMessage(msg: unknown) { this.posted.push(msg as WorkerRequest); }
  addEventListener(type: 'message' | 'error', fn: Listener) { this.listeners[type].push(fn); }
  terminate() { this.terminated = true; }
  emitResult(id: number, delta: PipelineDelta = FULL_DELTA) {
    this.listeners.message.forEach((f) => f({
      data: { kind: 'result', id, ok: true, delta, timings: {}, totalMs: 1 },
    }));
  }
}

describe('useWorkerPipeline', () => {
  it('starts with result null and computing true', () => {
    const worker = new FakeWorker();
    const { result } = renderHook((state: AppState) => useWorkerPipeline(state, () => worker), {
      initialProps: DEFAULT_STATE,
    });
    expect(result.current.result).toBeNull();
    expect(result.current.computing).toBe(true);
  });

  it('sets result and clears computing when the worker emits a result', () => {
    const worker = new FakeWorker();
    const { result } = renderHook((state: AppState) => useWorkerPipeline(state, () => worker), {
      initialProps: DEFAULT_STATE,
    });

    expect(worker.posted).toHaveLength(1);
    act(() => worker.emitResult(worker.posted[0].id));

    expect(result.current.result).not.toBeNull();
    expect(result.current.result!.stages).toHaveLength(7);
    expect(result.current.computing).toBe(false);
  });

  it('sets computing true again on a state change, while retaining the last-good result (stale view)', () => {
    const worker = new FakeWorker();
    const { result, rerender } = renderHook((state: AppState) => useWorkerPipeline(state, () => worker), {
      initialProps: DEFAULT_STATE,
    });

    act(() => worker.emitResult(worker.posted[0].id));
    expect(result.current.computing).toBe(false);
    const firstResult = result.current.result;

    const nextState: AppState = { ...DEFAULT_STATE, interleaving: 'row' };
    rerender(nextState);

    // A new compute was posted (queued or immediate — client coalescing is
    // Task 12's concern; here we only assert the hook's own contract).
    expect(result.current.computing).toBe(true);
    // Stale-view contract: the previous result is still what's returned.
    expect(result.current.result).toBe(firstResult);
  });

  it('disposes the client on unmount', () => {
    const worker = new FakeWorker();
    const terminateSpy = vi.spyOn(worker, 'terminate');
    const { unmount } = renderHook((state: AppState) => useWorkerPipeline(state, () => worker), {
      initialProps: DEFAULT_STATE,
    });
    unmount();
    expect(terminateSpy).toHaveBeenCalled();
  });
});

describe('useWorkerPipeline compute trigger scope', () => {
  it('does NOT post a compute for a ui-only state change', () => {
    const worker = new FakeWorker();
    const { result, rerender } = renderHook((state: AppState) => useWorkerPipeline(state, () => worker), {
      initialProps: DEFAULT_STATE,
    });
    expect(worker.posted).toHaveLength(1);
    act(() => worker.emitResult(worker.posted[0].id));
    expect(result.current.computing).toBe(false);

    // New state identity, same pipeline-relevant slices, different ui — this
    // is what a pane-stage change dispatch produces.
    const uiOnly: AppState = { ...DEFAULT_STATE, ui: { ...DEFAULT_STATE.ui, leftPaneStage: 'typed' } };
    rerender(uiOnly);

    expect(worker.posted).toHaveLength(1); // no new compute
    expect(result.current.computing).toBe(false); // no recompute indicator flash
  });

  it('DOES post a compute for a pipeline-relevant change', () => {
    const worker = new FakeWorker();
    const { rerender } = renderHook((state: AppState) => useWorkerPipeline(state, () => worker), {
      initialProps: DEFAULT_STATE,
    });
    expect(worker.posted).toHaveLength(1);
    // Settle the in-flight compute first — the client queues (not posts)
    // while one is outstanding (Task 12 coalescing).
    act(() => worker.emitResult(worker.posted[0].id));

    const shapeChange: AppState = { ...DEFAULT_STATE, shape: [64] };
    rerender(shapeChange);
    expect(worker.posted).toHaveLength(2);
  });
});
