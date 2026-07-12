import { useMemo } from 'react';
import type { StageLayout, ValueSources } from '../../engine/layout.ts';
import { byteRangesForTrace } from '../../engine/layout.ts';

/** One section of hex-viewable bytes: a single stage's bytes, or one file's
 * bytes when a Write-stage view has multiple output files. `header` is
 * present only when the section should render a sticky name/size header
 * (multi-section mode); single-section views omit it.
 *
 * Task 8 (perf plan): carries `layout`/`sources` instead of a materialized
 * `traces` array — per-byte trace info is derived on demand via `traceAt`
 * (engine/layout.ts), called once per visible byte by HexRowRenderer, instead
 * of reading a precomputed `ByteTrace[]`. */
export interface HexSection {
  /** Stable key across renders — file name for multi-file sections, or the
   * stage name for single-section views. NOT an index (task 3.5 / UI-18: index
   * keys made every previous section's sticky header stick at the same
   * `top: 0`, so they visually stacked instead of scrolling away). */
  key: string;
  header?: { name: string; size: number };
  bytes: Uint8Array;
  layout: StageLayout;
  sources: ValueSources;
}

export interface HexSectionData {
  key: string;
  header?: { name: string; size: number };
  bytes: Uint8Array;
  layout: StageLayout;
  sources: ValueSources;
  regionByByte: Uint8Array;
  /** 1 where a region boundary starts at that byte (0 elsewhere) — a byte
   * array, not a Set<number>: at 8M+ values there's one boundary per element
   * and a Set that size costs hundreds of MB (PERF-1). */
  boundaryByByte: Uint8Array;
  rowCount: number;
  /** True when this section renders a bounded WINDOW_ROWS-row window (with a
   * FileMapStrip + offset-jump input above its rows) instead of virtualizing
   * all `rowCount` rows at once. */
  windowed: boolean;
  /** Row offset (in ROW_HEIGHT units) of this section's first row within the
   * combined virtual scroll space — i.e. sum of prior sections' header rows
   * (0 or 1) + body rows. For a windowed section, "body rows" here means the
   * windowed row count (min(rowCount, WINDOW_ROWS)), since that's all that's
   * ever mounted — see `rowOffsetExtraPx` for the strip/input height. */
  rowOffset: number;
  /** Extra pixel height (beyond `rowOffset * ROW_HEIGHT`) consumed by this
   * section's FileMapStrip + offset-jump input row, when windowed (0
   * otherwise). Downstream sections' scrollMargin must add every prior
   * section's `rowOffsetExtraPx` on top of the row-based offset — see
   * HexView.tsx's scrollMargins computation. */
  rowOffsetExtraPx: number;
}

/** Sections whose rowCount exceeds this render a bounded row window with a
 *  FileMapStrip instead of unbounded virtual scroll. 262,144 rows = 4MB at
 *  16 B/row = ~5.2M px of scroll height — comfortably under Firefox's
 *  ~17.9M px element-height cap with headroom for multi-section views. */
export const WINDOWED_SECTION_ROWS = 262_144;
/** Rows per window (65,536 rows = 1MB at 16 B/row = ~1.3M px). */
export const WINDOW_ROWS = 65_536;
/** Pixel height of the FileMapStrip (16px, STRIP_HEIGHT in FileMapStrip.tsx)
 *  + offset-jump input row rendered above a windowed section's rows. This is
 *  the single source of truth for that box's height — HexView.tsx sets the
 *  controls wrapper's inline `height` to exactly this value, so whatever
 *  fits inside is cosmetic only; rowOffset math for downstream sections
 *  staying correct just requires using this same constant in both places
 *  (see `rowOffsetExtraPx`). */
export const WINDOW_CONTROLS_HEIGHT = 52;

/** Clamp a desired window start row: aligned to whole rows, >= 0, and never
 *  leaving trailing dead space (start <= rowCount - WINDOW_ROWS). */
export function clampWindowStart(desiredStartRow: number, rowCount: number): number {
  const maxStart = Math.max(0, rowCount - WINDOW_ROWS);
  return Math.max(0, Math.min(Math.floor(desiredStartRow), maxStart));
}

/** Window start row that centers `byteOffset`'s row. */
export function windowStartForByte(byteOffset: number, bytesPerRow: number, rowCount: number): number {
  const targetRow = Math.floor(byteOffset / bytesPerRow);
  return clampWindowStart(targetRow - WINDOW_ROWS / 2, rowCount);
}

export interface HexData {
  sections: HexSectionData[];
  /** Width (character count) the offset column should reserve, based on the
   * largest section's byte count — kept uniform across sections so columns
   * align visually when scrolling between them. */
  offsetWidth: number;
  /** Total row count across all sections (including one header "row" each,
   * when headers are shown), for sizing the combined virtualizer. */
  totalRows: number;
  /** True when more than one section is present — headers only render then. */
  showHeaders: boolean;
}

/** Per-byte region shading (alternating tint) and boundary flags, derived
 * directly from the stage layout. Semantically equivalent to filling from
 * `chunkRegionsOf(layout)` — same span order, same consecutive-same-label
 * merging — but WITHOUT materializing the spans: for value-block regions
 * that's one span object plus a traceId string per ELEMENT (8.4M of each at
 * PERF-1 scale, the bulk of the oversized worker result this replaced), while
 * this is just two O(bytes) array fills. Exported for the equivalence test
 * (tests/unit/viewers/computeRegions.test.ts), which pins it against the
 * chunkRegionsOf-based reference. */
export function computeRegions(bytes: Uint8Array, layout: StageLayout) {
  const regionByByte = new Uint8Array(bytes.length);
  const boundaryByByte = new Uint8Array(bytes.length);
  let regionCount = 0; // merged-region counter — parity source, exactly chunkRegionsOf's index
  let prevLabel: string | null = null; // null = can never merge with the next span

  // One span: merges into the previous region iff labels match (values
  // elements pass null — consecutive element traceIds are always distinct,
  // so no label string is ever needed for them).
  const emit = (start: number, end: number, label: string | null) => {
    if (label === null || label !== prevLabel) {
      if (start > 0) boundaryByByte[start] = 1;
      regionCount++;
    }
    prevLabel = label;
    if ((regionCount - 1) % 2 === 1) regionByByte.fill(1, start, end);
  };

  for (const r of layout.regions) {
    if (r.kind === 'structural') {
      emit(r.start, r.start + r.byteLength, r.traceId);
    } else if (r.kind === 'chunk') {
      emit(r.start, r.start + r.byteLength, r.chunkId);
    } else if (r.offsets) {
      for (let el = 0; el < r.elementCount; el++) {
        // Zero-width text elements (empty string) emit no span — mirrors
        // chunkRegionsOf's skip, which mirrors buildLogicalValuesStage.
        if (r.offsets[el] === r.offsets[el + 1]) continue;
        emit(r.start + r.offsets[el], r.start + r.offsets[el + 1], null);
      }
    } else {
      const stride = r.stride!;
      for (let el = 0; el < r.elementCount; el++) {
        emit(r.start + el * stride, r.start + (el + 1) * stride, null);
      }
    }
  }
  return { regionByByte, boundaryByByte };
}

/** Byte offset of the first byte belonging to `traceId` (or `chunkId` as a
 * fallback) in this section's layout — replaces the old traceIndex/chunkIndex
 * Maps (task 8) with a direct `byteRangesForTrace` lookup, computed only when
 * a cross-pane hover needs to scroll to it (HexView's effect), not
 * precomputed for every section on every render. */
export function firstByteForTrace(
  layout: StageLayout,
  traceId: string | undefined,
  chunkId: string | undefined,
): number | undefined {
  if (traceId) {
    const ranges = byteRangesForTrace(layout, traceId);
    if (ranges.length > 0) return ranges[0].start;
  }
  if (chunkId) {
    const ranges = byteRangesForTrace(layout, chunkId);
    if (ranges.length > 0) return ranges[0].start;
  }
  return undefined;
}

/**
 * Shared per-section data preparation for HexView (task 3.5 — extracted from
 * the pre-merge HexView/WriteHexView duplication): region coloring, trace/
 * chunk hover indices, row counts, and cumulative row offsets so a single
 * virtualizer can span all sections contiguously.
 */
export function useHexData(sections: HexSection[], bytesPerRow: number): HexData {
  return useMemo(() => {
    const showHeaders = sections.length > 1;
    let maxBytes = 0;
    let rowOffset = 0;
    let extraPx = 0;
    const sectionData: HexSectionData[] = sections.map((section) => {
      const { regionByByte, boundaryByByte } = computeRegions(section.bytes, section.layout);
      const rowCount = Math.max(1, Math.ceil(section.bytes.length / bytesPerRow));
      const windowed = rowCount > WINDOWED_SECTION_ROWS;
      const visibleRowCount = windowed ? Math.min(rowCount, WINDOW_ROWS) : rowCount;
      const data: HexSectionData = {
        key: section.key,
        header: section.header,
        bytes: section.bytes,
        layout: section.layout,
        sources: section.sources,
        regionByByte,
        boundaryByByte,
        rowCount,
        windowed,
        rowOffset,
        rowOffsetExtraPx: extraPx,
      };
      // eslint-disable-next-line react-hooks/immutability -- local accumulator inside the memo callback, not render-scoped state
      rowOffset += visibleRowCount + (showHeaders ? 1 : 0);
      if (windowed) extraPx += WINDOW_CONTROLS_HEIGHT;
      if (section.bytes.length > maxBytes) maxBytes = section.bytes.length;
      return data;
    });

    const offsetWidth = Math.max(4, maxBytes.toString(16).length);

    return {
      sections: sectionData,
      offsetWidth,
      totalRows: rowOffset,
      showHeaders,
    };
  }, [sections, bytesPerRow]);
}
