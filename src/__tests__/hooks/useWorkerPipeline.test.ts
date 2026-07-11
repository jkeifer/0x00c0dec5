// @vitest-environment jsdom
//
// Task 13 (perf plan): useWorkerPipeline replaces the deleted chained-useMemo
// usePipeline hook with a worker-backed one. jsdom is needed for renderHook
// (same pattern as the former usePipeline.memo.test.tsx / other component
// tests — see CLAUDE.md's per-file `@vitest-environment jsdom` pragma
// convention). FakeWorker mirrors src/__tests__/worker/client.test.ts's.
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useWorkerPipeline } from '../../hooks/useWorkerPipeline.ts';
import { DEFAULT_STATE } from '../../types/state.ts';
import type { WorkerLike } from '../../worker/client.ts';
import type { PipelineResult } from '../../engine/pipelineCompute.ts';
import type { AppState } from '../../types/state.ts';

class FakeWorker implements WorkerLike {
  posted: any[] = [];
  listeners: Record<string, ((e: any) => void)[]> = { message: [], error: [] };
  terminated = false;
  postMessage(msg: unknown) { this.posted.push(msg); }
  addEventListener(type: 'message' | 'error', fn: (e: any) => void) { this.listeners[type].push(fn); }
  terminate() { this.terminated = true; }
  emitResult(id: number, result: Partial<PipelineResult> = {}) {
    this.listeners.message.forEach((f) => f({
      data: { kind: 'result', id, ok: true, result: result as PipelineResult, timings: {}, totalMs: 1 },
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
    const fakeResult = { stages: [], files: [] } as unknown as Partial<PipelineResult>;
    act(() => worker.emitResult(worker.posted[0].id, fakeResult));

    expect(result.current.result).toEqual(fakeResult);
    expect(result.current.computing).toBe(false);
  });

  it('sets computing true again on a state change, while retaining the last-good result (stale view)', () => {
    const worker = new FakeWorker();
    const { result, rerender } = renderHook((state: AppState) => useWorkerPipeline(state, () => worker), {
      initialProps: DEFAULT_STATE,
    });

    const fakeResult = { stages: [], files: [] } as unknown as Partial<PipelineResult>;
    act(() => worker.emitResult(worker.posted[0].id, fakeResult));
    expect(result.current.computing).toBe(false);

    const nextState: AppState = { ...DEFAULT_STATE, interleaving: 'row' };
    rerender(nextState);

    // A new compute was posted (queued or immediate — client coalescing is
    // Task 12's concern; here we only assert the hook's own contract).
    expect(result.current.computing).toBe(true);
    // Stale-view contract: the previous result is still what's returned.
    expect(result.current.result).toEqual(fakeResult);
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
