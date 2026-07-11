import type { PipelineStage, ByteTrace, ChunkRegion } from '../../types/pipeline.ts';
import type { LogicalValue } from '../../types/dtypes.ts';
import { isChunkLevelTrace } from '../../engine/trace.ts';
import { formatByteCount } from '../../engine/bytes.ts';
import type { StageLayout, ValueSources } from '../../engine/layout.ts';
import { traceAt } from '../../engine/layout.ts';

export { formatByteCount };

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

/**
 * TraceGroups intersecting [startByte, endByte) — the layout-based
 * replacement for `groupBytesByTrace` used by the hex row renderer (task 8):
 * walks `traceAt` only across the visible window (~16 bytes/row * visible
 * rows) instead of materializing every stage's `traces` array up front.
 *
 * Groups are window-local: a run of same-traceId bytes that extends before
 * `startByte` or after `endByte` is clipped to the window, so `byteOffset`/
 * `byteCount`/`bytes` describe only the portion inside [startByte, endByte) —
 * unlike `groupBytesByTrace`, which sees the whole stage and never clips.
 * This is safe because the only consumer, HexRowRenderer, reads groups
 * strictly per-row (one row's worth of bytes at a time) and never relies on a
 * group's extent reaching beyond the row it's rendering.
 */
export function traceGroupsInRange(
  layout: StageLayout,
  bytes: Uint8Array,
  sources: ValueSources,
  startByte: number,
  endByte: number,
): TraceGroup[] {
  const groups: TraceGroup[] = [];
  const end = Math.min(endByte, layout.byteLength, bytes.length);
  if (startByte >= end) return groups;

  let current: ByteTrace | null = null;
  let groupStart = startByte;

  for (let i = startByte; i <= end; i++) {
    const trace = i < end ? traceAt(layout, i, sources) : null;
    const traceId = trace?.traceId ?? null;
    const currentId = current?.traceId ?? null;
    if (traceId !== currentId) {
      if (current) {
        groups.push({
          traceId: current.traceId,
          variableName: current.variableName,
          variableColor: current.variableColor,
          coords: current.coords,
          displayValue: current.displayValue,
          dtype: current.dtype,
          chunkId: current.chunkId,
          byteOffset: groupStart,
          byteCount: i - groupStart,
          bytes: bytes.slice(groupStart, i),
          isChunkLevel: isChunkLevelTrace(current.traceId),
        });
      }
      current = trace;
      groupStart = i;
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

/**
 * NaN-aware, display-oriented value equality for diff detection (task 4.5,
 * fixes UI-14). Plain `!==` flags NaN vs NaN as a diff (NaN !== NaN in JS),
 * which is wrong for the pedagogical diff view: a losslessly round-tripped
 * NaN should not be highlighted as an error. `-0` vs `0` is also not a
 * meaningful diff for display, so plain `===` (which already treats them as
 * equal) covers that case without needing `Object.is`. Strings (text
 * variables) compare with plain `===` — `Number.isNaN` is false for them.
 */
export function isDiffValue(val: LogicalValue, origVal: LogicalValue): boolean {
  return !(
    val === origVal ||
    (typeof val === 'number' && typeof origVal === 'number' &&
      Number.isNaN(val) && Number.isNaN(origVal))
  );
}

export interface DiffSummary {
  count: number;      // number of differing values
  maxAbsError: number; // max |val - orig| across differing values
  meanAbsError: number; // mean |val - orig| across differing values (0 when count is 0)
}

const EMPTY_DIFF_SUMMARY: DiffSummary = { count: 0, maxAbsError: 0, meanAbsError: 0 };

/**
 * Per-variable diff summary stats (task 4.5 / extension-read-step.md's Diff
 * View spec): differing count, max absolute error, mean absolute error.
 * Guards length mismatches (a reconstructed array shorter/longer than the
 * original) by only comparing indices present in both arrays — no NaN
 * reaches the result from an out-of-range read. Skips NaN-vs-NaN pairs per
 * `isDiffValue` so lossless NaN round-trips don't inflate the error stats.
 */
export function computeDiffSummary(values: LogicalValue[], origValues: LogicalValue[]): DiffSummary {
  const n = Math.min(values.length, origValues.length);
  let count = 0;
  let sumAbsError = 0;
  let maxAbsError = 0;
  for (let i = 0; i < n; i++) {
    const val = values[i];
    const orig = origValues[i];
    if (!isDiffValue(val, orig)) continue;
    count++;
    // String mismatches (text variables) count as diffs but have no numeric
    // magnitude — only number pairs contribute to the abs-error stats.
    if (typeof val !== 'number' || typeof orig !== 'number') continue;
    const absError = Math.abs(val - orig);
    sumAbsError += absError;
    if (absError > maxAbsError) maxAbsError = absError;
  }
  if (count === 0) return EMPTY_DIFF_SUMMARY;
  return { count, maxAbsError, meanAbsError: sumAbsError / count };
}

/**
 * Max absolute difference across two same-variable value arrays, for
 * GridView's diverging color scale. Guards length mismatches the same way
 * as `computeDiffSummary` — indices without a matching original are simply
 * excluded rather than producing NaN, which previously reached `rgb(NaN,
 * NaN, NaN)` in the cell color (UI-5). NaN-vs-NaN pairs are excluded too
 * (they are not diffs) so a NaN-heavy variable doesn't poison the scale.
 */
export function computeMaxAbsDiff(values: LogicalValue[], origValues: LogicalValue[]): number {
  const n = Math.min(values.length, origValues.length);
  let maxAbsDiff = 0;
  for (let i = 0; i < n; i++) {
    const val = values[i];
    const orig = origValues[i];
    if (!isDiffValue(val, orig)) continue;
    // Number pairs only — string diffs have no numeric magnitude.
    if (typeof val !== 'number' || typeof orig !== 'number') continue;
    const absDiff = Math.abs(val - orig);
    if (absDiff > maxAbsDiff) maxAbsDiff = absDiff;
  }
  return maxAbsDiff;
}

/**
 * Row/column for a flat cell index in GridView's fixed-size CSS grid, and
 * the scroll offset needed to bring that cell into view within a viewport
 * of the given size. Used to replace the `querySelector('[data-cell-idx]')`
 * DOM-ref pattern (UI-19, CLAUDE.md pitfall 2) with pure arithmetic: cells
 * are fixed-size (`cellSize` including the grid gap) in a CSS grid, so the
 * scroll position is derivable directly from the index without touching the
 * DOM at all.
 */
export function cellIndexToRowCol(index: number, cols: number): { row: number; col: number } {
  if (cols <= 0) return { row: 0, col: 0 };
  return { row: Math.floor(index / cols), col: index % cols };
}

/**
 * Compute the scroll offset (top/left) that brings the cell at `index` into
 * view, mimicking `Element.scrollIntoView({ block: 'nearest', inline:
 * 'nearest' })` without needing a DOM node for the cell itself — only the
 * viewport's current scroll position and size are needed.
 */
export function scrollOffsetForCell(
  index: number,
  cols: number,
  cellSize: number,
  viewport: { scrollTop: number; scrollLeft: number; clientWidth: number; clientHeight: number },
): { scrollTop: number; scrollLeft: number } {
  const { row, col } = cellIndexToRowCol(index, cols);
  const cellTop = row * cellSize;
  const cellBottom = cellTop + cellSize;
  const cellLeft = col * cellSize;
  const cellRight = cellLeft + cellSize;

  let scrollTop = viewport.scrollTop;
  if (cellTop < viewport.scrollTop) {
    scrollTop = cellTop;
  } else if (cellBottom > viewport.scrollTop + viewport.clientHeight) {
    scrollTop = cellBottom - viewport.clientHeight;
  }

  let scrollLeft = viewport.scrollLeft;
  if (cellLeft < viewport.scrollLeft) {
    scrollLeft = cellLeft;
  } else if (cellRight > viewport.scrollLeft + viewport.clientWidth) {
    scrollLeft = cellRight - viewport.clientWidth;
  }

  return { scrollTop, scrollLeft };
}
