import { useMemo } from 'react';
import type { ByteTrace, ChunkRegion } from '../../types/pipeline.ts';
import { buildChunkRegions, buildTraceIndex, buildChunkIndex } from './viewerUtils.ts';

/** One section of hex-viewable bytes: a single stage's bytes, or one file's
 * bytes when a Write-stage view has multiple output files. `header` is
 * present only when the section should render a sticky name/size header
 * (multi-section mode); single-section views omit it. */
export interface HexSection {
  /** Stable key across renders — file name for multi-file sections, or the
   * stage name for single-section views. NOT an index (task 3.5 / UI-18: index
   * keys made every previous section's sticky header stick at the same
   * `top: 0`, so they visually stacked instead of scrolling away). */
  key: string;
  header?: { name: string; size: number };
  bytes: Uint8Array;
  traces: ByteTrace[];
  chunkRegions?: ChunkRegion[];
}

export interface HexSectionData {
  key: string;
  header?: { name: string; size: number };
  bytes: Uint8Array;
  traces: ByteTrace[];
  chunkRegions: ChunkRegion[];
  regionByByte: Uint8Array;
  regionBoundaries: Set<number>;
  traceIndex: Map<string, number>;
  chunkIndex: Map<string, number>;
  rowCount: number;
  /** Row offset (in ROW_HEIGHT units) of this section's first row within the
   * combined virtual scroll space — i.e. sum of prior sections' header rows
   * (0 or 1) + body rows. */
  rowOffset: number;
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

function computeRegions(bytes: Uint8Array, traces: ByteTrace[], chunkRegions?: ChunkRegion[]) {
  const regions = chunkRegions ?? buildChunkRegions(traces);
  const regionByByte = new Uint8Array(bytes.length);
  for (let r = 0; r < regions.length; r++) {
    const region = regions[r];
    for (let i = region.startByte; i < region.endByte; i++) {
      regionByByte[i] = r % 2;
    }
  }
  const regionBoundaries = new Set<number>();
  for (const region of regions) {
    if (region.startByte > 0) regionBoundaries.add(region.startByte);
  }
  return { regions, regionByByte, regionBoundaries };
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
    const sectionData: HexSectionData[] = sections.map((section) => {
      const { regions, regionByByte, regionBoundaries } = computeRegions(
        section.bytes,
        section.traces,
        section.chunkRegions,
      );
      const rowCount = Math.max(1, Math.ceil(section.bytes.length / bytesPerRow));
      const data: HexSectionData = {
        key: section.key,
        header: section.header,
        bytes: section.bytes,
        traces: section.traces,
        chunkRegions: regions,
        regionByByte,
        regionBoundaries,
        traceIndex: buildTraceIndex(section.traces),
        chunkIndex: buildChunkIndex(section.traces),
        rowCount,
        rowOffset,
      };
      rowOffset += rowCount + (showHeaders ? 1 : 0);
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
