import { useRef, useEffect, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { PipelineStage } from '../../types/pipeline.ts';
import { useHover } from '../../hooks/useHover.ts';
import { useContainerWidth } from '../../hooks/useContainerWidth.ts';
import { byteToHex, formatOffset, byteToAscii, buildTraceIndex, buildChunkIndex } from './viewerUtils.ts';
import { colors, fonts, fontSizes, spacing } from '../../theme.ts';

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

          const rowHasBoundary = byteStart > 0 && Array.from(
            { length: Math.min(bytesPerRow, byteEnd - byteStart) },
            (_, col) => regionBoundaries.has(byteStart + col),
          ).some(Boolean);

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
                borderTop: rowHasBoundary ? `1px solid ${colors.borderSubtle}` : undefined,
              }}
            >
              {/* Offset column */}
              <span style={{ color: colors.textTertiary, marginRight: spacing.sm }}>
                {formatOffset(byteStart, stage.bytes.length).padStart(offsetWidth)}
              </span>

              {/* Hex bytes */}
              <span style={{ marginRight: spacing.sm }}>
                {Array.from({ length: bytesPerRow }, (_, col) => {
                  const byteIdx = byteStart + col;
                  if (byteIdx >= byteEnd) {
                    return (
                      <span key={col}>
                        {'   '}
                        {col === Math.floor(bytesPerRow / 2) - 1 ? ' ' : ''}
                      </span>
                    );
                  }
                  const trace = stage.traces[byteIdx] as typeof stage.traces[0] | undefined;
                  const isValueHovered = trace != null && hoveredTraceId !== null && trace.traceId === hoveredTraceId;
                  const chunkTraceIds = hoveredChunkId ? chunkTraceMap?.get(hoveredChunkId) : undefined;
                  const isChunkHovered = !isValueHovered && trace != null && (
                    (isCrossPane && hoveredChunkId !== null && hoveredChunkId !== '' && trace.chunkId === hoveredChunkId)
                    || (chunkTraceIds != null && chunkTraceIds.has(trace.traceId))
                  );
                  const textColor = trace?.variableColor || colors.textSecondary;
                  const regionTint = regionByByte[byteIdx] === 1 ? 'rgba(255,255,255,0.05)' : undefined;

                  return (
                    <span
                      key={col}
                      onMouseEnter={trace ? () => setHover(trace.traceId, trace.chunkId, paneId) : undefined}
                      style={{
                        color: textColor,
                        backgroundColor: isValueHovered ? 'rgba(255,255,255,0.18)' : isChunkHovered ? 'rgba(255,255,255,0.08)' : regionTint,
                        borderRadius: 2,
                        cursor: 'default',
                        transition: 'background-color 0.1s ease',
                      }}
                    >
                      {byteToHex(stage.bytes[byteIdx])}
                    </span>
                  );
                }).reduce<React.ReactNode[]>((acc, el, i) => {
                  acc.push(el);
                  if (i < bytesPerRow - 1) {
                    acc.push(<span key={`sep-${i}`}>{i === Math.floor(bytesPerRow / 2) - 1 ? '  ' : ' '}</span>);
                  }
                  return acc;
                }, [])}
              </span>

              {/* ASCII column */}
              <span style={{ color: colors.textTertiary }}>
                {'│'}
                {Array.from({ length: bytesPerRow }, (_, col) => {
                  const byteIdx = byteStart + col;
                  if (byteIdx >= byteEnd) return <span key={col}> </span>;
                  const trace = stage.traces[byteIdx] as typeof stage.traces[0] | undefined;
                  const isValueHovered = trace != null && hoveredTraceId !== null && trace.traceId === hoveredTraceId;
                  const asciiChunkTraceIds = hoveredChunkId ? chunkTraceMap?.get(hoveredChunkId) : undefined;
                  const isChunkHovered = !isValueHovered && trace != null && (
                    (isCrossPane && hoveredChunkId !== null && hoveredChunkId !== '' && trace.chunkId === hoveredChunkId)
                    || (asciiChunkTraceIds != null && asciiChunkTraceIds.has(trace.traceId))
                  );

                  return (
                    <span
                      key={col}
                      onMouseEnter={trace ? () => setHover(trace.traceId, trace.chunkId, paneId) : undefined}
                      style={{
                        color: isValueHovered ? colors.textPrimary : isChunkHovered ? colors.textSecondary : colors.textTertiary,
                        backgroundColor: isValueHovered ? 'rgba(255,255,255,0.18)' : isChunkHovered ? 'rgba(255,255,255,0.08)' : undefined,
                        cursor: 'default',
                        transition: 'background-color 0.1s ease',
                      }}
                    >
                      {byteToAscii(stage.bytes[byteIdx])}
                    </span>
                  );
                })}
                {'│'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
