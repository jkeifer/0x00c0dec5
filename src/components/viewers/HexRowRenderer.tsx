import type { ByteTrace } from '../../types/pipeline.ts';
import { byteToHex, formatOffset, byteToAscii } from './viewerUtils.ts';
import { colors, spacing } from '../../theme.ts';

interface HexRowRendererProps {
  rowIndex: number;
  byteStart: number;
  byteEnd: number;
  bytesPerRow: number;
  bytes: Uint8Array;
  traces: ByteTrace[];
  regionByByte: Uint8Array;
  regionBoundaries: Set<number>;
  offsetWidth: number;
  totalBytes: number;
  hoveredTraceId: string | null;
  hoveredChunkId: string | null;
  isCrossPane: boolean;
  chunkTraceMap?: Map<string, Set<string>>;
  onHover: (traceId: string, chunkId: string) => void;
}

export function HexRowRenderer({
  byteStart,
  byteEnd,
  bytesPerRow,
  bytes,
  traces,
  regionByByte,
  regionBoundaries,
  offsetWidth,
  totalBytes,
  hoveredTraceId,
  hoveredChunkId,
  isCrossPane,
  chunkTraceMap,
  onHover,
}: HexRowRendererProps) {
  const rowHasBoundary = byteStart > 0 && Array.from(
    { length: Math.min(bytesPerRow, byteEnd - byteStart) },
    (_, col) => regionBoundaries.has(byteStart + col),
  ).some(Boolean);

  return (
    <>
      {rowHasBoundary && (
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          borderTop: `1px solid ${colors.borderSubtle}`,
        }} />
      )}

      {/* Offset column */}
      <span style={{ color: colors.textTertiary, marginRight: spacing.sm }}>
        {formatOffset(byteStart, totalBytes).padStart(offsetWidth)}
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
          const trace = traces[byteIdx] as typeof traces[0] | undefined;
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
              onMouseEnter={trace ? () => onHover(trace.traceId, trace.chunkId) : undefined}
              style={{
                color: textColor,
                backgroundColor: isValueHovered ? 'rgba(255,255,255,0.18)' : isChunkHovered ? 'rgba(255,255,255,0.08)' : regionTint,
                borderRadius: 2,
                cursor: 'default',
                transition: 'background-color 0.1s ease',
              }}
            >
              {byteToHex(bytes[byteIdx])}
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
          const trace = traces[byteIdx] as typeof traces[0] | undefined;
          const isValueHovered = trace != null && hoveredTraceId !== null && trace.traceId === hoveredTraceId;
          const asciiChunkTraceIds = hoveredChunkId ? chunkTraceMap?.get(hoveredChunkId) : undefined;
          const isChunkHovered = !isValueHovered && trace != null && (
            (isCrossPane && hoveredChunkId !== null && hoveredChunkId !== '' && trace.chunkId === hoveredChunkId)
            || (asciiChunkTraceIds != null && asciiChunkTraceIds.has(trace.traceId))
          );

          return (
            <span
              key={col}
              onMouseEnter={trace ? () => onHover(trace.traceId, trace.chunkId) : undefined}
              style={{
                color: isValueHovered ? colors.textPrimary : isChunkHovered ? colors.textSecondary : colors.textTertiary,
                backgroundColor: isValueHovered ? 'rgba(255,255,255,0.18)' : isChunkHovered ? 'rgba(255,255,255,0.08)' : undefined,
                cursor: 'default',
                transition: 'background-color 0.1s ease',
              }}
            >
              {byteToAscii(bytes[byteIdx])}
            </span>
          );
        })}
        {'│'}
      </span>
    </>
  );
}
