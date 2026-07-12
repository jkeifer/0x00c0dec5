import type { AppState } from '../types/state.ts';
import type { StageName } from '../types/pipeline.ts';
import type { PipelineDelta, StageKnownKeys } from '../engine/pipelineCompute.ts';

/** `knownKeys` (PERF-1 stage-delta protocol): the per-stage memo keys of the
 * last result the client APPLIED — the worker omits any stage payload whose
 * computed key matches, so unchanged stages never re-cross the thread
 * boundary. Empty on the first compute (everything is sent). */
export interface ComputeRequest { kind: 'compute'; id: number; state: AppState; knownKeys: StageKnownKeys }
export type WorkerRequest = ComputeRequest;
export type StageTimings = Partial<Record<StageName, number>>; // ms per stage
export interface ProgressMsg { kind: 'progress'; id: number; stage: StageName }
export interface ResultOk { kind: 'result'; id: number; ok: true; delta: PipelineDelta; timings: StageTimings; totalMs: number }
export interface ResultErr { kind: 'result'; id: number; ok: false; error: string }
export type WorkerResponse = ProgressMsg | ResultOk | ResultErr;

/** Every ArrayBuffer reachable from `value`, deduped — the postMessage
 * transfer list (PERF-1). A generic walk (objects, arrays, Maps, Sets, typed
 * arrays) rather than a shape-specific enumeration of PipelineDelta, so a new
 * buffer-carrying payload field can't silently fall back to being cloned —
 * at PERF-1 scale a clone of a large buffer is an out-of-memory crash, not a
 * slowdown. Dedupe matters: a buffer listed twice makes postMessage throw,
 * and payloads do share buffers (e.g. readResult.reconstructedValues and the
 * read payload's logical-values map hold the same arrays). */
export function collectTransferables(value: unknown): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const seen = new Set<object>();
  const visit = (v: unknown): void => {
    if (v === null || typeof v !== 'object') return;
    if (seen.has(v)) return;
    seen.add(v);
    if (ArrayBuffer.isView(v)) {
      // ArrayBufferLike is ArrayBuffer | SharedArrayBuffer; the engine only
      // ever allocates plain ArrayBuffers (and SharedArrayBuffer is not
      // transferable anyway), so the instanceof is just type narrowing.
      if (v.buffer instanceof ArrayBuffer) buffers.add(v.buffer);
      return;
    }
    if (v instanceof ArrayBuffer) { buffers.add(v); return; }
    if (v instanceof Map) {
      for (const [k, val] of v) { visit(k); visit(val); }
      return;
    }
    if (v instanceof Set) {
      for (const val of v) visit(val);
      return;
    }
    if (Array.isArray(v)) {
      for (const val of v) visit(val);
      return;
    }
    for (const val of Object.values(v)) visit(val);
  };
  visit(value);
  return Array.from(buffers);
}
