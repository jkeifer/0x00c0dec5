import type { AppState } from '../types/state.ts';
import type { PipelineResult } from '../hooks/usePipeline.ts';
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
    this.worker.postMessage({ kind: 'compute', id, state } satisfies WorkerRequest);
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
      this.lastTimings = msg.timings;
      this.lastTotalMs = msg.totalMs;
      this.lastError = null;
      this.onResult(msg.result, this.diagnostics()); // superseded result still published
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
