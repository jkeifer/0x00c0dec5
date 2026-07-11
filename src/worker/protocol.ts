import type { AppState } from '../types/state.ts';
import type { StageName } from '../types/pipeline.ts';
import type { PipelineResult } from '../hooks/usePipeline.ts';
import type { ValueArray } from '../engine/layout.ts';

export interface ComputeRequest { kind: 'compute'; id: number; state: AppState }
export type WorkerRequest = ComputeRequest;
export type StageTimings = Partial<Record<StageName, number>>; // ms per stage
export interface ProgressMsg { kind: 'progress'; id: number; stage: StageName }
export interface ResultOk { kind: 'result'; id: number; ok: true; result: PipelineResult; timings: StageTimings; totalMs: number }
export interface ResultErr { kind: 'result'; id: number; ok: false; error: string }
export type WorkerResponse = ProgressMsg | ResultOk | ResultErr;

/** Every ArrayBuffer reachable from the result, deduped — the transfer list.
 *  Walks: stages[].bytes.buffer, files[].bytes.buffer, every Float64Array in
 *  the value maps (logicalValues/typedValues and the ValueSources maps —
 *  these may reference the SAME arrays as logicalValues/typedValues, so a
 *  Set<ArrayBuffer> is what makes that safe to transfer), and every
 *  Uint32Array offsets in every layout's ValueBlockRegions (text variables). */
export function collectTransferables(result: PipelineResult): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();

  // TypedArray#buffer is typed ArrayBufferLike (ArrayBuffer | SharedArrayBuffer);
  // every buffer this engine allocates is a plain ArrayBuffer (`new
  // Uint8Array(n)` etc. never produce a SharedArrayBuffer), so this guard is
  // just narrowing the type, not handling a real runtime case.
  const isArrayBuffer = (b: ArrayBufferLike): b is ArrayBuffer => b instanceof ArrayBuffer;
  const add = (b: ArrayBufferLike) => { if (isArrayBuffer(b)) buffers.add(b); };

  const addLayout = (layout: { regions: { kind: string; offsets?: Uint32Array }[] } | undefined) => {
    if (!layout) return;
    for (const region of layout.regions) {
      if (region.kind === 'values' && region.offsets) add(region.offsets.buffer);
    }
  };

  const addValueMap = (values: Map<string, ValueArray> | undefined) => {
    if (!values) return;
    for (const arr of values.values()) {
      if (arr instanceof Float64Array) add(arr.buffer);
    }
  };

  for (const stage of result.stages) {
    add(stage.bytes.buffer);
    addLayout(stage.layout);
  }
  for (const file of result.files) {
    add(file.bytes.buffer);
    addLayout(file.layout);
  }

  addValueMap(result.logicalValues);
  addValueMap(result.typedValues);
  for (const sources of result.stageSources.values()) {
    addValueMap(sources.values);
  }

  return Array.from(buffers);
}
