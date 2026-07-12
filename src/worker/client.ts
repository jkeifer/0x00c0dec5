import type { AppState } from '../types/state.ts';
import { assemblePipelineResult } from '../engine/pipelineCompute.ts';
import type { PipelineResult, StagePayloads, StageKnownKeys, PipelineDelta } from '../engine/pipelineCompute.ts';
import { STAGE_ORDER } from '../types/pipeline.ts';
import type { WorkerRequest, WorkerResponse, StageTimings } from './protocol.ts';

export interface WorkerDiagnostics {
  status: 'idle' | 'computing' | 'crashed';
  respawnCount: number;
  lastTimings: StageTimings | null;
  lastTotalMs: number | null;
  lastError: string | null;
}

export interface WorkerLike { // structural subset of Worker, for test fakes
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  // Structural subset shared with test fakes (FakeWorker); a typed event here would force
  // casts in the pinned fixture.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addEventListener(type: 'message' | 'error', fn: (e: any) => void): void;
  terminate(): void;
}

interface InFlight { id: number; state: AppState }

export class PipelineWorkerClient {
  private readonly createWorker: () => WorkerLike;
  private readonly onResult: (result: PipelineResult, diag: WorkerDiagnostics) => void;
  private readonly onStatus?: (diag: WorkerDiagnostics) => void;
  private readonly watchdogMs: number;

  private worker: WorkerLike | null = null;
  private inFlight: InFlight | null = null;
  private queued: AppState | null = null;
  private nextId = 1;
  private respawnCount = 0;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private status: WorkerDiagnostics['status'] = 'idle';
  private lastTimings: StageTimings | null = null;
  private lastTotalMs: number | null = null;
  private lastError: string | null = null;

  // PERF-1 stage-delta protocol: the per-stage payloads of the last applied
  // result and their memo keys. `knownKeys` rides along on every compute
  // request so the worker can omit stages this side already holds; payloads
  // survive worker crashes/respawns (the data itself is still valid here).
  private payloads: Partial<StagePayloads> = {};
  private knownKeys: StageKnownKeys = {};

  constructor(opts: {
    createWorker: () => WorkerLike;
    onResult: (result: PipelineResult, diag: WorkerDiagnostics) => void;
    onStatus?: (diag: WorkerDiagnostics) => void;
    watchdogMs?: number;
  }) {
    this.createWorker = opts.createWorker;
    this.onResult = opts.onResult;
    this.onStatus = opts.onStatus;
    this.watchdogMs = opts.watchdogMs ?? 10_000;
  }

  compute(state: AppState): void {
    if (this.inFlight) {
      this.queued = state;
      return;
    }
    this.post(state);
  }

  diagnostics(): WorkerDiagnostics {
    return {
      status: this.status,
      respawnCount: this.respawnCount,
      lastTimings: this.lastTimings,
      lastTotalMs: this.lastTotalMs,
      lastError: this.lastError,
    };
  }

  dispose(): void {
    this.clearWatchdog();
    this.worker?.terminate();
    this.worker = null;
    this.inFlight = null;
    this.queued = null;
  }

  private post(state: AppState): void {
    if (!this.worker) {
      this.worker = this.createWorker();
      this.worker.addEventListener('message', (e) => this.handleMessage(e.data as WorkerResponse));
      this.worker.addEventListener('error', (e) => this.handleCrash(e?.message ?? 'worker error'));
    }
    const id = this.nextId++;
    this.inFlight = { id, state };
    this.status = 'computing';
    this.armWatchdog();
    this.worker.postMessage({ kind: 'compute', id, state, knownKeys: { ...this.knownKeys } } satisfies WorkerRequest);
    this.onStatus?.(this.diagnostics());
  }

  private armWatchdog(): void {
    this.clearWatchdog();
    this.watchdogTimer = setTimeout(() => {
      // Per the brief: watchdog only fires the crash path when a NEWER state
      // is queued behind the stuck compute — an in-flight compute with
      // nothing queued is left alone (no substitute state to repost).
      if (this.queued !== null) this.handleCrash('watchdog timeout');
    }, this.watchdogMs);
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer !== null) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private handleMessage(msg: WorkerResponse): void {
    if (msg.kind === 'progress') return;
    if (!this.inFlight || msg.id !== this.inFlight.id) return; // stale, ignore

    this.clearWatchdog();
    this.inFlight = null;
    this.status = 'idle';

    if (msg.ok) {
      const result = this.applyDelta(msg.delta);
      if (result !== null) {
        this.lastTimings = msg.timings;
        this.lastTotalMs = msg.totalMs;
        this.lastError = null;
        this.onResult(result, this.diagnostics()); // superseded result still published
      }
    } else {
      this.lastError = msg.error;
    }
    this.onStatus?.(this.diagnostics());

    if (this.queued !== null) {
      const next = this.queued;
      this.queued = null;
      this.post(next);
    }
  }

  /** Merge a stage delta into the payload store and reassemble the full
   * result. Returns null (recording lastError) if an omitted stage isn't in
   * the store — a protocol violation that can't happen when the worker
   * honors `knownKeys`, but must not crash the message handler. */
  private applyDelta(delta: PipelineDelta): PipelineResult | null {
    for (const s of STAGE_ORDER) {
      const entry = delta[s];
      if (entry.payload !== undefined) {
        (this.payloads as Record<string, unknown>)[s] = entry.payload;
      } else if (this.payloads[s] === undefined) {
        this.lastError = `worker omitted stage "${s}" but no prior payload is held`;
        return null;
      }
      this.knownKeys[s] = entry.key;
    }
    return assemblePipelineResult(this.payloads as StagePayloads);
  }

  private handleCrash(error: string): void {
    const repost = this.queued ?? this.inFlight?.state ?? null;
    this.clearWatchdog();
    this.worker?.terminate();
    this.worker = null;
    this.inFlight = null;
    this.queued = null;
    this.respawnCount++;
    this.status = 'crashed';
    this.lastError = error;
    this.onStatus?.(this.diagnostics());
    if (repost !== null) this.post(repost);
  }
}

export function createPipelineWorker(): Worker {
  return new Worker(new URL('./pipeline.worker.ts', import.meta.url), { type: 'module' });
}
