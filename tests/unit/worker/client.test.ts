import { describe, it, expect, vi } from 'vitest';
import { PipelineWorkerClient, type WorkerLike } from '../../../src/worker/client.ts';
import { createPipelineComputer, type PipelineDelta, type PipelineResult } from '../../../src/engine/pipelineCompute.ts';
import type { WorkerRequest, WorkerResponse } from '../../../src/worker/protocol.ts';
import { DEFAULT_STATE } from '../../../src/types/state.ts';

// A real full delta (every stage payload present) — what the worker's first
// compute produces. Computed once; tests only need its shape, not freshness.
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
    this.listeners.message.forEach((f) => f({ data: { kind: 'result', id, ok: true, delta, timings: {}, totalMs: 1 } }));
  }
  emitFailure(id: number, error: string) {
    this.listeners.message.forEach((f) => f({ data: { kind: 'result', id, ok: false, error } }));
  }
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

describe('PipelineWorkerClient stage-delta protocol (PERF-1)', () => {
  it('sends empty knownKeys on the first compute, then the applied keys on the next', () => {
    const w = new FakeWorker();
    const c = new PipelineWorkerClient({ createWorker: () => w, onResult: () => {} });
    c.compute(DEFAULT_STATE);
    expect(w.posted[0].knownKeys).toEqual({});
    w.emitResult(w.posted[0].id);
    c.compute({ ...DEFAULT_STATE, interleaving: 'row' });
    expect(w.posted[1].knownKeys.values).toBe(FULL_DELTA.values.key);
    expect(w.posted[1].knownKeys.read).toBe(FULL_DELTA.read.key);
  });
  it('assembles a full result from a partial delta using stored payloads', () => {
    const w = new FakeWorker();
    const results: PipelineResult[] = [];
    const c = new PipelineWorkerClient({ createWorker: () => w, onResult: (r) => results.push(r) });
    c.compute(DEFAULT_STATE);
    w.emitResult(w.posted[0].id); // full delta applied

    c.compute({ ...DEFAULT_STATE, write: { ...DEFAULT_STATE.write, magicNumber: 'CAFEBABE' } });
    // Partial delta: only read resent (fake keys for changed stage).
    const partial: PipelineDelta = {
      ...FULL_DELTA,
      values: { key: FULL_DELTA.values.key },
      typed: { key: FULL_DELTA.typed.key },
      linearized: { key: FULL_DELTA.linearized.key },
      encoded: { key: FULL_DELTA.encoded.key },
      metadata: { key: FULL_DELTA.metadata.key },
      write: { key: FULL_DELTA.write.key },
      read: { key: 'new-read-key', payload: FULL_DELTA.read.payload },
    };
    w.emitResult(w.posted[1].id, partial);

    expect(results).toHaveLength(2);
    expect(results[1].stages).toHaveLength(7);
    // Unsent stages come from the store — reference-identical to the first result's.
    expect(results[1].stages[0]).toBe(results[0].stages[0]);
  });
  it('records lastError and publishes no result for an ok:false reply', () => {
    const w = new FakeWorker();
    const onResult = vi.fn();
    const c = new PipelineWorkerClient({ createWorker: () => w, onResult });
    c.compute(DEFAULT_STATE);
    w.emitFailure(w.posted[0].id, 'engine exploded');
    expect(onResult).not.toHaveBeenCalled();
    expect(c.diagnostics().lastError).toBe('engine exploded');
    expect(c.diagnostics().status).toBe('idle'); // not stuck computing
  });
  it('does not crash (records lastError) when a delta omits a stage it never sent', () => {
    const w = new FakeWorker();
    const onResult = vi.fn();
    const c = new PipelineWorkerClient({ createWorker: () => w, onResult });
    c.compute(DEFAULT_STATE);
    const broken: PipelineDelta = { ...FULL_DELTA, values: { key: FULL_DELTA.values.key } }; // payload omitted, nothing stored
    w.emitResult(w.posted[0].id, broken);
    expect(onResult).not.toHaveBeenCalled();
    expect(c.diagnostics().lastError).toContain('values');
  });
});
