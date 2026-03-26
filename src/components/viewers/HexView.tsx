import { useRef, useEffect, useMemo, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { PipelineStage } from '../../types/pipeline.ts';
import { useHover } from '../../hooks/useHover.ts';
import { useContainerWidth } from '../../hooks/useContainerWidth.ts';
import { formatOffset, buildTraceIndex, buildChunkIndex } from './viewerUtils.ts';
import { HexRowRenderer } from './HexRowRenderer.tsx';
import { fonts, fontSizes, spacing } from '../../theme.ts';

interface HexViewProps {
  stage: PipelineStage;
  paneId: 'left' | 'right';
  chunkTraceMap?: Map<string, Set<string>>;
  traceChunkMap?: Map<string, string>;
}

const NARROW_BREAKPOINT = 500;
const ROW_HEIGHT = 20;

export function HexView({ stage, paneId, chunkTraceMap, traceChunkMap: _traceChunkMap }: HexViewProps) {
  const { hoveredTraceId, hoveredChunkId, hoverSource, setHover, clearHover } = useHover();
  const parentRef = useRef<HTMLDivElement>(null);
  const containerWidth = useContainerWidth(parentRef);
  const bytesPerRow = containerWidth > 0 && containerWidth < NARROW_BREAKPOINT ? 8 : 16;

  const rowCount = Math.ceil(stage.bytes.length / bytesPerRow);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;

  const traceIndex = useMemo(() => buildTraceIndex(stage.traces), [stage.traces]);
  const chunkIndex = useMemo(() => buildChunkIndex(stage.traces), [stage.traces]);

  const regionByByte = useMemo(() => {
    const map = new Uint8Array(stage.bytes.length);
    for (let r = 0; r < stage.chunkRegions.length; r++) {
      const region = stage.chunkRegions[r];
      for (let i = region.startByte; i < region.endByte; i++) {
        map[i] = r % 2;
      }
    }
    return map;
  }, [stage.chunkRegions, stage.bytes.length]);

  const regionBoundaries = useMemo(() => {
    const set = new Set<number>();
    for (const region of stage.chunkRegions) {
      if (region.startByte > 0) set.add(region.startByte);
    }
    return set;
  }, [stage.chunkRegions]);

  const isCrossPane = hoverSource !== null && hoverSource !== paneId;

  // Scroll to hovered trace when hover comes from the other pane
  useEffect(() => {
    if (hoveredTraceId && hoverSource !== paneId) {
      let byteIdx = traceIndex.get(hoveredTraceId);
      if (byteIdx === undefined && hoveredChunkId) {
        byteIdx = chunkIndex.get(hoveredChunkId);
      }
      if (byteIdx !== undefined) {
        const rowIdx = Math.floor(byteIdx / bytesPerRow);
        virtualizerRef.current.scrollToIndex(rowIdx, { align: 'auto' });
      }
    }
  }, [hoveredTraceId, hoveredChunkId, hoverSource, paneId, traceIndex, chunkIndex, bytesPerRow]);

  const offsetWidth = formatOffset(0, stage.bytes.length).length;

  const handleHover = useCallback(
    (traceId: string, chunkId: string) => setHover(traceId, chunkId, paneId),
    [setHover, paneId],
  );

  return (
    <div
      ref={parentRef}
      onMouseLeave={clearHover}
      style={{
        height: '100%',
        overflow: 'auto',
        fontFamily: fonts.mono,
        fontSize: fontSizes.md,
        lineHeight: `${ROW_HEIGHT}px`,
      }}
    >
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const rowIndex = virtualRow.index;
          const byteStart = rowIndex * bytesPerRow;
          const byteEnd = Math.min(byteStart + bytesPerRow, stage.bytes.length);

          return (
            <div
              key={virtualRow.key}
              style={{
                position: 'absolute',
                top: virtualRow.start,
                left: 0,
                right: 0,
                height: ROW_HEIGHT,
                display: 'flex',
                whiteSpace: 'pre',
                padding: `0 ${spacing.sm}px`,
              }}
            >
              <HexRowRenderer
                rowIndex={rowIndex}
                byteStart={byteStart}
                byteEnd={byteEnd}
                bytesPerRow={bytesPerRow}
                bytes={stage.bytes}
                traces={stage.traces}
                regionByByte={regionByByte}
                regionBoundaries={regionBoundaries}
                offsetWidth={offsetWidth}
                totalBytes={stage.bytes.length}
                hoveredTraceId={hoveredTraceId}
                hoveredChunkId={hoveredChunkId}
                isCrossPane={isCrossPane}
                chunkTraceMap={chunkTraceMap}
                onHover={handleHover}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
