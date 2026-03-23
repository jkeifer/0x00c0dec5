import { useMemo } from 'react';
import type { PipelineStage } from '../../types/pipeline.ts';
import { useHover } from '../../hooks/useHover.ts';
import { isChunkLevelTrace } from '../../engine/trace.ts';
import { buildTraceIndexWithCounts, buildChunkIndexWithCounts } from '../viewers/viewerUtils.ts';
import { colors, fontSizes, spacing, fonts } from '../../theme.ts';

interface HoverBarProps {
  stages: PipelineStage[];
}

function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

function formatHexOffset(offset: number): string {
  return '0x' + offset.toString(16).toUpperCase();
}

export function HoverBar({ stages }: HoverBarProps) {
  const { hoveredTraceId, hoveredChunkId } = useHover();

  // Build indices once per stage change
  const stageIndices = useMemo(() => {
    return stages.map((stage) => ({
      traceIndex: buildTraceIndexWithCounts(stage.traces),
      chunkIndex: buildChunkIndexWithCounts(stage.traces),
    }));
  }, [stages]);

  // Find the trace info from the first stage that contains this traceId
  const traceInfo = useMemo(() => {
    if (!hoveredTraceId) return null;

    for (let s = 0; s < stages.length; s++) {
      const entry = stageIndices[s].traceIndex.get(hoveredTraceId);
      if (entry) return stages[s].traces[entry.firstByte];
    }
    if (hoveredChunkId) {
      for (let s = 0; s < stages.length; s++) {
        const entry = stageIndices[s].chunkIndex.get(hoveredChunkId);
        if (entry) return stages[s].traces[entry.firstByte];
      }
    }
    return null;
  }, [hoveredTraceId, hoveredChunkId, stages, stageIndices]);

  // Compute per-stage byte counts using O(1) lookups
  const stagePresence = useMemo(() => {
    if (!hoveredTraceId) return null;

    const isChunkHover = isChunkLevelTrace(hoveredTraceId);

    return stages.map((_, i) => {
      const { traceIndex, chunkIndex } = stageIndices[i];

      if (isChunkHover) {
        // Chunk-level hover: look up by traceId first, then chunkId
        const byTrace = traceIndex.get(hoveredTraceId);
        if (byTrace) {
          return { name: stages[i].name, byteCount: byTrace.count, byteStart: byTrace.firstByte, byteEnd: byTrace.lastByte };
        }
        if (hoveredChunkId) {
          const byChunk = chunkIndex.get(hoveredChunkId);
          if (byChunk) {
            return { name: stages[i].name, byteCount: byChunk.count, byteStart: byChunk.firstByte, byteEnd: byChunk.lastByte };
          }
        }
      } else {
        // Value-level hover: look up by exact traceId
        const byTrace = traceIndex.get(hoveredTraceId);
        if (byTrace) {
          return { name: stages[i].name, byteCount: byTrace.count, byteStart: byTrace.firstByte, byteEnd: byTrace.lastByte };
        }
        // Fallback to chunkId for post-entropy stages
        if (hoveredChunkId) {
          const byChunk = chunkIndex.get(hoveredChunkId);
          if (byChunk) {
            return { name: stages[i].name, byteCount: byChunk.count, byteStart: byChunk.firstByte, byteEnd: byChunk.lastByte };
          }
        }
      }

      return { name: stages[i].name, byteCount: 0, byteStart: null, byteEnd: null };
    });
  }, [hoveredTraceId, hoveredChunkId, stages, stageIndices]);

  const barStyle: React.CSSProperties = {
    height: 24,
    display: 'flex',
    alignItems: 'center',
    padding: `0 ${spacing.md}px`,
    fontSize: fontSizes.xs,
    color: colors.textSecondary,
    background: colors.bg,
    borderBottom: `1px solid ${colors.borderSubtle}`,
    flexShrink: 0,
    fontFamily: fonts.mono,
    gap: spacing.sm,
    overflow: 'hidden',
    whiteSpace: 'nowrap' as const,
  };

  if (!hoveredTraceId || !traceInfo) {
    return <div style={barStyle}>Hover a value to trace it</div>;
  }

  const isChunk = isChunkLevelTrace(hoveredTraceId);
  const label = isChunk
    ? traceInfo.chunkId
    : `${traceInfo.variableName}${traceInfo.coords.length > 0 ? `[${traceInfo.coords.join(',')}]` : ''}`;
  const dotColor = traceInfo.variableColor || colors.textTertiary;

  return (
    <div style={barStyle}>
      {/* Color dot + label */}
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          backgroundColor: dotColor,
          flexShrink: 0,
        }}
      />
      <span style={{ color: traceInfo.variableColor || colors.textSecondary }}>
        {label}
      </span>

      {/* Decoded value */}
      {!isChunk && traceInfo.displayValue && (
        <span style={{ color: colors.textPrimary }}>
          = {traceInfo.displayValue}
        </span>
      )}

      {isChunk && (
        <span style={{ color: colors.textSecondary, fontStyle: 'italic' }}>
          (chunk-level, value detail lost)
        </span>
      )}

      {/* Stage presence */}
      {stagePresence && (
        <span style={{ marginLeft: 'auto', color: colors.textSecondary }}>
          {stagePresence
            .filter((s) => s.byteCount > 0)
            .map((s) => {
              const range = s.byteStart !== null
                ? ` @${formatHexOffset(s.byteStart)}\u2013${formatHexOffset(s.byteEnd!)}`
                : '';
              return `${s.name}: ${formatByteCount(s.byteCount)}${range}`;
            })
            .join(' → ')}
        </span>
      )}
    </div>
  );
}
