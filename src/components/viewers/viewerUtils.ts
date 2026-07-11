import type { ByteTrace, ChunkRegion } from '../../types/pipeline.ts';
import type { LogicalValue } from '../../types/dtypes.ts';
import { formatByteCount } from '../../engine/bytes.ts';
import type { StageLayout, ValueSources, LayoutRegion, ChunkFieldLayout, ValueArray } from '../../engine/layout.ts';
import { traceAt, regionAt, byteRangesForTrace } from '../../engine/layout.ts';

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

/** Number of FlatView rows (one per grouped trace) a region contributes —
 *  mirrors groupBytesByTrace's grouping without walking any bytes:
 *  - values (text): one group per non-empty-string element (empty strings
 *    produce zero ByteTrace entries upstream, per chunkRegionsOf's zero-width
 *    guard — see layout.ts's values branch comment).
 *  - values (fixed-width): one group per element.
 *  - chunk, value-preserving: one group per (element × field) — this is the
 *    per-value trace count within the chunk, matching linearizeChunk's byte
 *    order (column: field blocks sequential; row: records interleaved).
 *  - chunk, chunk-level / structural: the whole region is one trace. */
function regionGroupCount(r: LayoutRegion): number {
  if (r.kind === 'values') {
    if (r.offsets) {
      let n = 0;
      for (let el = 0; el < r.elementCount; el++) {
        if (r.offsets[el] !== r.offsets[el + 1]) n++;
      }
      return n;
    }
    return r.elementCount;
  }
  if (r.kind === 'chunk' && r.mode === 'value-preserving') {
    const elementCount = r.elementDims.reduce((a, b) => a * b, 1);
    return elementCount * r.fields.length;
  }
  return 1; // chunk-level or structural
}

/** Total FlatView row count for a stage's layout — O(regions), not O(bytes)
 *  (Task 9, perf plan): replaces `groupBytesByTrace(stage).length`. */
export function flatGroupCount(layout: StageLayout): number {
  let total = 0;
  for (const r of layout.regions) total += regionGroupCount(r);
  return total;
}

/** The `index`-th FlatView group (0-based, in the same order groupBytesByTrace
 *  would produce), computed directly from region-relative arithmetic — no
 *  byte-by-byte scan. Mirrors traceAt's per-region math but walks elements/
 *  fields instead of bytes, then delegates to traceAt for the actual
 *  ByteTrace once the group's start byte is known (keeping trace-shape logic
 *  — formatting, coords, etc. — in one place). */
export function flatGroupAt(
  layout: StageLayout,
  bytes: Uint8Array,
  sources: ValueSources,
  index: number,
): TraceGroup {
  let remaining = index;
  for (const r of layout.regions) {
    const count = regionGroupCount(r);
    if (remaining >= count) {
      remaining -= count;
      continue;
    }
    // remaining is this region's local group index.
    if (r.kind === 'values') {
      let startByte: number;
      let byteCount: number;
      if (r.offsets) {
        // Walk non-empty elements to find the `remaining`-th one.
        let seen = -1;
        let el = 0;
        for (; el < r.elementCount; el++) {
          if (r.offsets[el] === r.offsets[el + 1]) continue;
          seen++;
          if (seen === remaining) break;
        }
        startByte = r.start + r.offsets[el];
        byteCount = r.offsets[el + 1] - r.offsets[el];
      } else {
        const stride = r.stride!;
        startByte = r.start + remaining * stride;
        byteCount = stride;
      }
      const trace = traceAt(layout, startByte, sources)!;
      return {
        traceId: trace.traceId, variableName: trace.variableName, variableColor: trace.variableColor,
        coords: trace.coords, displayValue: trace.displayValue, dtype: trace.dtype, chunkId: trace.chunkId,
        byteOffset: startByte, byteCount, bytes: bytes.slice(startByte, startByte + byteCount),
        isChunkLevel: false,
      };
    }
    if (r.kind === 'chunk' && r.mode === 'value-preserving') {
      const fieldCount = r.fields.length;
      let elemFlat: number;
      let field: ChunkFieldLayout;
      if (r.interleaving === 'column') {
        // Field blocks sequential: elements 0..N-1 of field0, then field1, ...
        field = r.fields[Math.floor(remaining / (r.elementDims.reduce((a, b) => a * b, 1)))];
        elemFlat = remaining % r.elementDims.reduce((a, b) => a * b, 1);
      } else {
        // Records interleaved: record0's fields, record1's fields, ...
        elemFlat = Math.floor(remaining / fieldCount);
        field = r.fields[remaining % fieldCount];
      }
      const startByte = r.interleaving === 'column'
        ? r.start + field.offset + elemFlat * field.size
        : r.start + elemFlat * r.fields.reduce((a, f) => a + f.size, 0) + field.offset;
      const byteCount = field.size;
      const trace = traceAt(layout, startByte, sources)!;
      return {
        traceId: trace.traceId, variableName: trace.variableName, variableColor: trace.variableColor,
        coords: trace.coords, displayValue: trace.displayValue, dtype: trace.dtype, chunkId: trace.chunkId,
        byteOffset: startByte, byteCount, bytes: bytes.slice(startByte, startByte + byteCount),
        isChunkLevel: false,
      };
    }
    // chunk-level or structural: the whole region is one group.
    const trace = traceAt(layout, r.start, sources)!;
    return {
      traceId: trace.traceId, variableName: trace.variableName, variableColor: trace.variableColor,
      coords: trace.coords, displayValue: trace.displayValue, dtype: trace.dtype, chunkId: trace.chunkId,
      byteOffset: r.start, byteCount: r.byteLength, bytes: bytes.slice(r.start, r.start + r.byteLength),
      isChunkLevel: r.kind === 'chunk',
    };
  }
  throw new Error(`flatGroupAt: index ${index} out of range`);
}

/** Inverse of `flatGroupAt`: the FlatView group index containing `id` (a
 *  value traceId or a chunk/structural id), or undefined if `id` has no
 *  bytes in this layout. Used for cross-pane scroll-to-hover — a rare event
 *  (not per-row), so an O(regions) walk to the target region plus an
 *  O(elements-in-region) scan for the text-offsets case is cheap relative to
 *  materializing every group up front. */
export function flatGroupIndexOf(layout: StageLayout, id: string): number | undefined {
  const ranges = byteRangesForTrace(layout, id);
  if (ranges.length === 0) return undefined;
  const byteIndex = ranges[0].start;
  const target = regionAt(layout, byteIndex);
  if (!target) return undefined;

  let base = 0;
  for (const r of layout.regions) {
    if (r === target) break;
    base += regionGroupCount(r);
  }

  if (target.kind === 'values') {
    const rel = byteIndex - target.start;
    if (target.offsets) {
      // Count non-empty elements before the one containing `rel`.
      let el = 0;
      while (el < target.elementCount && !(target.offsets[el] <= rel && rel < target.offsets[el + 1])) el++;
      let localIdx = 0;
      for (let i = 0; i < el; i++) {
        if (target.offsets[i] !== target.offsets[i + 1]) localIdx++;
      }
      return base + localIdx;
    }
    const stride = target.stride!;
    return base + Math.floor(rel / stride);
  }
  if (target.kind === 'chunk' && target.mode === 'value-preserving') {
    const rel = byteIndex - target.start;
    const elementCount = target.elementDims.reduce((a, b) => a * b, 1);
    if (target.interleaving === 'column') {
      let f = target.fields.length - 1;
      while (f > 0 && rel < target.fields[f].offset) f--;
      const field = target.fields[f];
      const elemFlat = Math.floor((rel - field.offset) / field.size);
      return base + f * elementCount + elemFlat;
    }
    const recordSize = target.fields.reduce((a, f) => a + f.size, 0);
    const elemFlat = Math.floor(rel / recordSize);
    const inRecord = rel % recordSize;
    let f = target.fields.length - 1;
    while (f > 0 && inRecord < target.fields[f].offset) f--;
    return base + elemFlat * target.fields.length + f;
  }
  // chunk-level or structural: the whole region is group `base`.
  return base;
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
export function computeDiffSummary(values: ValueArray, origValues: ValueArray): DiffSummary {
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
export function computeMaxAbsDiff(values: ValueArray, origValues: ValueArray): number {
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
