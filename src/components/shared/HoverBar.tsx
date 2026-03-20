import { useMemo } from 'react';
import type { PipelineStage } from '../../types/pipeline.ts';
import { useHover } from '../../hooks/useHover.ts';
import { isChunkLevelTrace } from '../../engine/trace.ts';
import { colors, fontSizes, spacing, fonts } from '../../theme.ts';

interface HoverBarProps {
  stages: PipelineStage[];
}

function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

export function HoverBar({ stages }: HoverBarProps) {
  const { hoveredTraceId } = useHover();

  // Find the trace info from the first stage that contains this traceId
  const traceInfo = useMemo(() => {
    if (!hoveredTraceId) return null;

    // Search in Values stage first, then others
    for (const stage of stages) {
      const trace = stage.traces.find((t) => t.traceId === hoveredTraceId);
      if (trace) return trace;
    }
    return null;
  }, [hoveredTraceId, stages]);

  // Compute per-stage byte counts for the hovered traceId
  const stagePresence = useMemo(() => {
    if (!hoveredTraceId) return null;

    return stages.map((stage) => {
      let count = 0;
      for (const t of stage.traces) {
        if (t.traceId === hoveredTraceId) count++;
      }
      return { name: stage.name, byteCount: count };
    });
  }, [hoveredTraceId, stages]);

  const barStyle: React.CSSProperties = {
    height: 24,
    display: 'flex',
    alignItems: 'center',
    padding: `0 ${spacing.md}px`,
    fontSize: fontSizes.xs,
    color: colors.textTertiary,
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
        <span style={{ color: colors.textTertiary, fontStyle: 'italic' }}>
          (chunk-level, value detail lost)
        </span>
      )}

      {/* Stage presence */}
      {stagePresence && (
        <span style={{ marginLeft: 'auto', color: colors.textTertiary }}>
          {stagePresence
            .filter((s) => s.byteCount > 0)
            .map((s) => `${s.name}: ${formatByteCount(s.byteCount)}`)
            .join(' → ')}
        </span>
      )}
    </div>
  );
}
