import { useRef, useEffect, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { PipelineStage } from '../../types/pipeline.ts';
import { useHover } from '../../hooks/useHover.ts';
import { groupBytesByTrace, byteToHex, type TraceGroup } from './viewerUtils.ts';
import { colors, fonts, fontSizes, spacing } from '../../theme.ts';

interface FlatViewProps {
  stage: PipelineStage;
  paneId: 'left' | 'right';
  chunkTraceMap?: Map<string, Set<string>>;
  traceChunkMap?: Map<string, string>;
}

const ROW_HEIGHT = 22;

function formatCoords(coords: number[]): string {
  if (coords.length === 0) return '';
  return `[${coords.join(',')}]`;
}

function hexSummary(bytes: Uint8Array): string {
  const hexParts: string[] = [];
  const limit = Math.min(bytes.length, 8);
  for (let i = 0; i < limit; i++) {
    hexParts.push(byteToHex(bytes[i]));
  }
  let s = hexParts.join(' ');
  if (bytes.length > limit) s += ' …';
  return s;
}

export function FlatView({ stage, paneId, chunkTraceMap }: FlatViewProps) {
  const { hoveredTraceId, hoveredChunkId, hoverSource, setHover, clearHover } = useHover();
  const parentRef = useRef<HTMLDivElement>(null);

  const traceGroups = useMemo(() => groupBytesByTrace(stage), [stage]);

  const traceGroupIndex = useMemo(() => {
    const map = new Map<string, number>();
    for (let i = 0; i < traceGroups.length; i++) {
      const id = traceGroups[i].traceId;
      if (!map.has(id)) map.set(id, i);
    }
    return map;
  }, [traceGroups]);

  const chunkGroupIndex = useMemo(() => {
    const map = new Map<string, number>();
    for (let i = 0; i < traceGroups.length; i++) {
      const id = traceGroups[i].chunkId;
      if (id && !map.has(id)) map.set(id, i);
    }
    return map;
  }, [traceGroups]);

  const virtualizer = useVirtualizer({
    count: traceGroups.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;

  const isCrossPane = hoverSource !== null && hoverSource !== paneId;

  // Scroll to hovered trace from other pane
  useEffect(() => {
    if (hoveredTraceId && hoverSource !== paneId) {
      let groupIdx = traceGroupIndex.get(hoveredTraceId);
      if (groupIdx === undefined && hoveredChunkId) {
        groupIdx = chunkGroupIndex.get(hoveredChunkId);
      }
      if (groupIdx !== undefined) {
        virtualizerRef.current.scrollToIndex(groupIdx, { align: 'auto' });
      }
    }
  }, [hoveredTraceId, hoveredChunkId, hoverSource, paneId, traceGroupIndex, chunkGroupIndex]);

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
          const group: TraceGroup = traceGroups[virtualRow.index];
          const prevGroup = virtualRow.index > 0 ? traceGroups[virtualRow.index - 1] : null;
          const showBoundary = prevGroup !== null && prevGroup.chunkId !== group.chunkId;

          const isValueHovered = hoveredTraceId !== null && group.traceId === hoveredTraceId;
          const flatChunkTraceIds = hoveredChunkId ? chunkTraceMap?.get(hoveredChunkId) : undefined;
          const isChunkHovered = !isValueHovered && (
            (isCrossPane && hoveredChunkId !== null && hoveredChunkId !== '' && group.chunkId === hoveredChunkId)
            || (flatChunkTraceIds != null && flatChunkTraceIds.has(group.traceId))
          );
          void (isValueHovered || isChunkHovered);

          const label = group.isChunkLevel
            ? `${group.chunkId} [${group.byteOffset}\u2013${group.byteOffset + group.byteCount - 1}]`
            : `${group.variableName}${formatCoords(group.coords)}`;
          const value = group.isChunkLevel ? '' : group.displayValue;

          return (
            <div
              key={virtualRow.key}
              onMouseEnter={() => setHover(group.traceId, group.chunkId, paneId)}
              style={{
                position: 'absolute',
                top: virtualRow.start,
                left: 0,
                right: 0,
                height: ROW_HEIGHT,
                display: 'flex',
                alignItems: 'center',
                gap: spacing.sm,
                padding: `0 ${spacing.sm}px`,
                backgroundColor: isValueHovered ? 'rgba(255,255,255,0.14)' : isChunkHovered ? 'rgba(255,255,255,0.06)' : undefined,
                borderTop: showBoundary ? `1px solid ${colors.borderSubtle}` : undefined,
                cursor: 'default',
                transition: 'background-color 0.1s ease',
              }}
            >
              {/* Color dot */}
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  backgroundColor: group.variableColor || colors.textTertiary,
                  flexShrink: 0,
                }}
              />

              {/* Label */}
              <span
                style={{
                  color: group.variableColor || colors.textSecondary,
                  minWidth: 120,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {label}
              </span>

              {/* Decoded value */}
              {value && (
                <span
                  style={{
                    color: colors.textPrimary,
                    minWidth: 100,
                  }}
                >
                  {value}
                </span>
              )}

              {/* Hex bytes */}
              <span
                style={{
                  color: colors.textTertiary,
                  fontSize: fontSizes.sm,
                  marginLeft: 'auto',
                  flexShrink: 0,
                }}
              >
                {hexSummary(group.bytes)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
