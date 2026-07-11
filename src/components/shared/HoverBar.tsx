import { useMemo } from 'react';
import type { PipelineStage, StageName, ByteTrace } from '../../types/pipeline.ts';
import { STAGE_ORDER } from '../../types/pipeline.ts';
import type { ValueSources } from '../../engine/layout.ts';
import { byteRangesForTrace, traceAt } from '../../engine/layout.ts';
import { useHover } from '../../hooks/useHover.ts';
import { isChunkLevelTrace } from '../../engine/trace.ts';
import { colors, displayColor, fontSizes, spacing, fonts } from '../../theme.ts';
import { formatByteCount } from '../../engine/bytes.ts';

interface HoverBarProps {
  stages: PipelineStage[];
  stageSources: Map<StageName, ValueSources>;
}

function formatHexOffset(offset: number): string {
  return '0x' + offset.toString(16).toUpperCase();
}

/** Resolve a ByteTrace for `id` (traceId, or chunkId as fallback) within one
 *  stage, via that stage's own layout — replaces the old traceIndex/
 *  chunkIndex Maps built from stage.traces (Task 9, perf plan). */
function resolveTrace(stage: PipelineStage, sources: ValueSources | undefined, id: string): ByteTrace | null {
  if (!sources) return null;
  const ranges = byteRangesForTrace(stage.layout, id);
  if (ranges.length === 0) return null;
  return traceAt(stage.layout, ranges[0].start, sources);
}

export function HoverBar({ stages, stageSources }: HoverBarProps) {
  const { hoveredTraceId, hoveredChunkId } = useHover();

  // Find the trace info from the first stage that contains this traceId (or
  // hoveredChunkId as a fallback) — direct layout lookups, no per-stage index
  // materialized up front.
  const traceInfo = useMemo(() => {
    if (!hoveredTraceId) return null;

    for (let s = 0; s < stages.length; s++) {
      const sources = stageSources.get(STAGE_ORDER[s]);
      const trace = resolveTrace(stages[s], sources, hoveredTraceId);
      if (trace) return trace;
    }
    if (hoveredChunkId) {
      for (let s = 0; s < stages.length; s++) {
        const sources = stageSources.get(STAGE_ORDER[s]);
        const trace = resolveTrace(stages[s], sources, hoveredChunkId);
        if (trace) return trace;
      }
    }
    return null;
  }, [hoveredTraceId, hoveredChunkId, stages, stageSources]);

  // Compute per-stage byte counts/ranges via byteRangesForTrace — replaces
  // the old traceIndex/chunkIndex O(1)-lookup Maps built from stage.traces.
  const stagePresence = useMemo(() => {
    if (!hoveredTraceId) return null;

    return stages.map((stage) => {
      const name = stage.name;
      const byTrace = byteRangesForTrace(stage.layout, hoveredTraceId);
      if (byTrace.length > 0) {
        const byteCount = byTrace.reduce((sum, r) => sum + (r.end - r.start), 0);
        const byteStart = byTrace[0].start;
        const byteEnd = byTrace[byTrace.length - 1].end - 1;
        return { name, byteCount, byteStart, byteEnd };
      }
      // Fallback to chunkId (value-level hover on a post-entropy/chunk-level
      // stage, or vice versa).
      if (hoveredChunkId) {
        const byChunk = byteRangesForTrace(stage.layout, hoveredChunkId);
        if (byChunk.length > 0) {
          const byteCount = byChunk.reduce((sum, r) => sum + (r.end - r.start), 0);
          const byteStart = byChunk[0].start;
          const byteEnd = byChunk[byChunk.length - 1].end - 1;
          return { name, byteCount, byteStart, byteEnd };
        }
      }
      return { name, byteCount: 0, byteStart: null, byteEnd: null };
    });
  }, [hoveredTraceId, hoveredChunkId, stages]);

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
    return <div data-testid="hover-bar" style={barStyle}>Hover a value to trace it</div>;
  }

  const isChunk = isChunkLevelTrace(hoveredTraceId);
  // Structural traces (write-stage magic bytes and the metadata block) carry
  // no variable identity — `variableName`/`variableColor` are both `''`
  // (see makeMagicTraces/makeMetadataTraces in src/engine/write.ts, traceIds
  // 'magic:start' / 'magic:end' / 'metadata'). Render a meaningful label and
  // a neutral dot instead of the blank/colorless default (UI-16).
  const isStructural = traceInfo.traceId === 'magic:start'
    || traceInfo.traceId === 'magic:end'
    || traceInfo.traceId === 'metadata';
  const label = isStructural
    ? (traceInfo.traceId === 'metadata' ? 'metadata' : 'magic number')
    : isChunk
      ? traceInfo.chunkId
      : `${traceInfo.variableName}${traceInfo.coords.length > 0 ? `[${traceInfo.coords.join(',')}]` : ''}`;
  const dotColor = traceInfo.variableColor || colors.textTertiary;

  return (
    <div data-testid="hover-bar" style={barStyle}>
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
      <span style={{ color: isStructural ? colors.textTertiary : (traceInfo.variableColor ? displayColor(traceInfo.variableColor) : colors.textSecondary) }}>
        {label}
      </span>

      {/* Decoded value — suppressed for structural traces (their
          displayValue, e.g. "magic (start)"/"metadata", just repeats the
          label above; nothing to decode for these byte ranges). */}
      {!isChunk && !isStructural && traceInfo.displayValue && (
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
                ? ` @${formatHexOffset(s.byteStart)}–${formatHexOffset(s.byteEnd!)}`
                : '';
              return `${s.name}: ${formatByteCount(s.byteCount)}${range}`;
            })
            .join(' → ')}
        </span>
      )}
    </div>
  );
}
