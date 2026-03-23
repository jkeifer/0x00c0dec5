import type { PipelineStage, ByteTrace, ChunkRegion } from '../../types/pipeline.ts';
import { isChunkLevelTrace } from '../../engine/trace.ts';

export interface TraceGroup {
  traceId: string;
  variableName: string;
  variableColor: string;
  coords: number[];
  displayValue: string;
  dtype: string;
  chunkId: string;
  byteOffset: number;
  byteCount: number;
  bytes: Uint8Array;
  isChunkLevel: boolean;
}

/** Group consecutive bytes sharing the same traceId into TraceGroup objects. */
export function groupBytesByTrace(stage: PipelineStage): TraceGroup[] {
  const groups: TraceGroup[] = [];
  if (stage.traces.length === 0) return groups;

  let currentId = stage.traces[0].traceId;
  let startOffset = 0;

  for (let i = 1; i <= stage.traces.length; i++) {
    const traceId = i < stage.traces.length ? stage.traces[i].traceId : null;
    if (traceId !== currentId) {
      const trace = stage.traces[startOffset];
      groups.push({
        traceId: trace.traceId,
        variableName: trace.variableName,
        variableColor: trace.variableColor,
        coords: trace.coords,
        displayValue: trace.displayValue,
        dtype: trace.dtype,
        chunkId: trace.chunkId,
        byteOffset: startOffset,
        byteCount: i - startOffset,
        bytes: stage.bytes.slice(startOffset, i),
        isChunkLevel: isChunkLevelTrace(trace.traceId),
      });
      if (i < stage.traces.length) {
        currentId = traceId!;
        startOffset = i;
      }
    }
  }

  return groups;
}

/** Format a byte as 2-digit uppercase hex string. */
export function byteToHex(b: number): string {
  return b.toString(16).toUpperCase().padStart(2, '0');
}

/** Format an offset as hex with leading zeros based on totalBytes. */
export function formatOffset(offset: number, totalBytes: number): string {
  const width = Math.max(4, totalBytes.toString(16).length);
  return offset.toString(16).toUpperCase().padStart(width, '0');
}

/** Convert a byte to printable ASCII or '.' */
export function byteToAscii(b: number): string {
  return b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.';
}

/** Build a Map from traceId to the first byte index for O(1) hover lookups. */
export function buildTraceIndex(traces: ByteTrace[]): Map<string, number> {
  const index = new Map<string, number>();
  for (let i = 0; i < traces.length; i++) {
    const id = traces[i].traceId;
    if (!index.has(id)) {
      index.set(id, i);
    }
  }
  return index;
}

/** Build chunk regions by scanning traces for contiguous regions with the same identity. */
export function buildChunkRegions(traces: ByteTrace[]): ChunkRegion[] {
  if (traces.length === 0) return [];

  const regions: ChunkRegion[] = [];
  let currentLabel = getRegionLabel(traces[0]);
  let startByte = 0;

  for (let i = 1; i <= traces.length; i++) {
    const label = i < traces.length ? getRegionLabel(traces[i]) : null;
    if (label !== currentLabel) {
      regions.push({
        label: currentLabel,
        startByte,
        endByte: i,
        byteCount: i - startByte,
      });
      if (label !== null) {
        currentLabel = label;
        startByte = i;
      }
    }
  }

  return regions;
}

function getRegionLabel(trace: ByteTrace): string {
  if (trace.traceId === 'magic:start' || trace.traceId === 'magic:end' || trace.traceId === 'metadata') {
    return trace.traceId;
  }
  return trace.chunkId || trace.traceId;
}

/** Build a Map from traceId to { firstByte, lastByte, count } for O(1) hover lookups. */
export function buildTraceIndexWithCounts(
  traces: ByteTrace[],
): Map<string, { firstByte: number; lastByte: number; count: number }> {
  const index = new Map<string, { firstByte: number; lastByte: number; count: number }>();
  for (let i = 0; i < traces.length; i++) {
    const id = traces[i].traceId;
    const existing = index.get(id);
    if (existing) {
      existing.lastByte = i;
      existing.count++;
    } else {
      index.set(id, { firstByte: i, lastByte: i, count: 1 });
    }
  }
  return index;
}

/** Build a Map from chunkId to { firstByte, lastByte, count } for O(1) chunk hover lookups. */
export function buildChunkIndexWithCounts(
  traces: ByteTrace[],
): Map<string, { firstByte: number; lastByte: number; count: number }> {
  const index = new Map<string, { firstByte: number; lastByte: number; count: number }>();
  for (let i = 0; i < traces.length; i++) {
    const id = traces[i].chunkId;
    if (!id) continue;
    const existing = index.get(id);
    if (existing) {
      existing.lastByte = i;
      existing.count++;
    } else {
      index.set(id, { firstByte: i, lastByte: i, count: 1 });
    }
  }
  return index;
}

/** Build a Map from chunkId to the first byte index for chunk-level hover fallback. */
export function buildChunkIndex(traces: ByteTrace[]): Map<string, number> {
  const index = new Map<string, number>();
  for (let i = 0; i < traces.length; i++) {
    const id = traces[i].chunkId;
    if (id && !index.has(id)) {
      index.set(id, i);
    }
  }
  return index;
}
