import { useRef, useEffect, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { PipelineStage } from '../../types/pipeline.ts';
import { useHover } from '../../hooks/useHover.ts';
import { byteToHex, formatOffset, byteToAscii, buildTraceIndex } from './viewerUtils.ts';
import { colors, fonts, fontSizes, spacing } from '../../theme.ts';

interface HexViewProps {
  stage: PipelineStage;
  paneId: 'left' | 'right';
}

const BYTES_PER_ROW = 16;
const ROW_HEIGHT = 20;

export function HexView({ stage, paneId }: HexViewProps) {
  const { hoveredTraceId, hoverSource, setHover, clearHover } = useHover();
  const parentRef = useRef<HTMLDivElement>(null);

  const rowCount = Math.ceil(stage.bytes.length / BYTES_PER_ROW);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  const traceIndex = useMemo(() => buildTraceIndex(stage.traces), [stage.traces]);

  // Scroll to hovered trace when hover comes from the other pane
  useEffect(() => {
    if (hoveredTraceId && hoverSource !== paneId) {
      const byteIdx = traceIndex.get(hoveredTraceId);
      if (byteIdx !== undefined) {
        const rowIdx = Math.floor(byteIdx / BYTES_PER_ROW);
        virtualizer.scrollToIndex(rowIdx, { align: 'auto' });
      }
    }
  }, [hoveredTraceId, hoverSource, paneId, traceIndex, virtualizer]);

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
          const byteStart = rowIndex * BYTES_PER_ROW;
          const byteEnd = Math.min(byteStart + BYTES_PER_ROW, stage.bytes.length);

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
              {/* Offset column */}
              <span style={{ color: colors.textTertiary, marginRight: spacing.sm }}>
                {formatOffset(byteStart, stage.bytes.length).padStart(offsetWidth)}
              </span>

              {/* Hex bytes */}
              <span style={{ marginRight: spacing.sm }}>
                {Array.from({ length: BYTES_PER_ROW }, (_, col) => {
                  const byteIdx = byteStart + col;
                  if (byteIdx >= byteEnd) {
                    return (
                      <span key={col}>
                        {'   '}
                        {col === 7 ? ' ' : ''}
                      </span>
                    );
                  }
                  const trace = stage.traces[byteIdx];
                  const isHovered = hoveredTraceId !== null && trace.traceId === hoveredTraceId;
                  const textColor = trace.variableColor || colors.textSecondary;

                  return (
                    <span
                      key={col}
                      onMouseEnter={() => setHover(trace.traceId, paneId)}
                      style={{
                        color: textColor,
                        backgroundColor: isHovered ? 'rgba(255,255,255,0.1)' : undefined,
                        borderRadius: 2,
                        cursor: 'default',
                      }}
                    >
                      {byteToHex(stage.bytes[byteIdx])}
                    </span>
                  );
                }).reduce<React.ReactNode[]>((acc, el, i) => {
                  acc.push(el);
                  if (i < BYTES_PER_ROW - 1) {
                    acc.push(<span key={`sep-${i}`}>{i === 7 ? '  ' : ' '}</span>);
                  }
                  return acc;
                }, [])}
              </span>

              {/* ASCII column */}
              <span style={{ color: colors.textTertiary }}>
                {'│'}
                {Array.from({ length: BYTES_PER_ROW }, (_, col) => {
                  const byteIdx = byteStart + col;
                  if (byteIdx >= byteEnd) return <span key={col}> </span>;
                  const trace = stage.traces[byteIdx];
                  const isHovered = hoveredTraceId !== null && trace.traceId === hoveredTraceId;

                  return (
                    <span
                      key={col}
                      onMouseEnter={() => setHover(trace.traceId, paneId)}
                      style={{
                        color: isHovered ? colors.textPrimary : colors.textTertiary,
                        backgroundColor: isHovered ? 'rgba(255,255,255,0.1)' : undefined,
                        cursor: 'default',
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
