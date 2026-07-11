import { describe, it, expect, vi } from 'vitest';
import { PipelineWorkerClient, type WorkerLike } from '../../../src/worker/client.ts';
import { DEFAULT_STATE } from '../../../src/types/state.ts';

class FakeWorker implements WorkerLike {
  posted: any[] = [];
  listeners: Record<string, ((e: any) => void)[]> = { message: [], error: [] };
  terminated = false;
  postMessage(msg: unknown) { this.posted.push(msg); }
  addEventListener(type: 'message' | 'error', fn: (e: any) => void) { this.listeners[type].push(fn); }
  terminate() { this.terminated = true; }
  emitResult(id: number) { this.listeners.message.forEach((f) => f({ data: { kind: 'result', id, ok: true, result: {} as any, timings: {}, totalMs: 1 } })); }
  emitError(msg: string) { this.listeners.error.forEach((f) => f({ message: msg })); }
}

describe('PipelineWorkerClient coalescing', () => {
  it('posts immediately when idle', () => {
    const w = new FakeWorker();
    const c = new PipelineWorkerClient({ createWorker: () => w, onResult: () => {} });
    c.compute(DEFAULT_STATE);
    expect(w.posted).toHaveLength(1);
  });
  it('queues while busy and posts only the LAST queued state on result', () => {
    const w = new FakeWorker();
    const onResult = vi.fn();
    const c = new PipelineWorkerClient({ createWorker: () => w, onResult });
    c.compute(DEFAULT_STATE);                                        // in flight (id 1)
    c.compute({ ...DEFAULT_STATE, interleaving: 'row' });            // queued
    c.compute({ ...DEFAULT_STATE, interleaving: 'column' });         // overwrites queue
    expect(w.posted).toHaveLength(1);
    w.emitResult(w.posted[0].id);
    expect(onResult).toHaveBeenCalledTimes(1);                       // superseded result still published
    expect(w.posted).toHaveLength(2);                                // exactly one follow-up
    expect(w.posted[1].state.interleaving).toBe('column');
  });
  it('respawns on worker error and reposts the newest state', () => {
    const workers: FakeWorker[] = [];
    const c = new PipelineWorkerClient({ createWorker: () => { const w = new FakeWorker(); workers.push(w); return w; }, onResult: () => {} });
    c.compute(DEFAULT_STATE);
    workers[0].emitError('boom');
    expect(workers[0].terminated).toBe(true);
    expect(c.diagnostics().respawnCount).toBe(1);
    expect(workers).toHaveLength(2);                                 // respawned + reposted
    expect(workers[1].posted).toHaveLength(1);
  });
  it('watchdog terminates a stuck compute when newer state is queued', () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const c = new PipelineWorkerClient({ createWorker: () => { const w = new FakeWorker(); workers.push(w); return w; }, onResult: () => {}, watchdogMs: 1000 });
    c.compute(DEFAULT_STATE);
    c.compute({ ...DEFAULT_STATE, interleaving: 'row' });            // queued
    vi.advanceTimersByTime(1001);
    expect(workers[0].terminated).toBe(true);
    expect(workers[1].posted[0].state.interleaving).toBe('row');
    vi.useRealTimers();
  });
  it('ignores stale results (id mismatch after respawn)', () => {
    const workers: FakeWorker[] = [];
    const onResult = vi.fn();
    const c = new PipelineWorkerClient({ createWorker: () => { const w = new FakeWorker(); workers.push(w); return w; }, onResult });
    c.compute(DEFAULT_STATE);
    const staleId = workers[0].posted[0].id;
    workers[0].emitError('boom');
    workers[0].emitResult(staleId);   // late message from the dead worker
    expect(onResult).not.toHaveBeenCalled();
  });
});
