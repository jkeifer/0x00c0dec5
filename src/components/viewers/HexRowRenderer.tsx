import type { StageLayout, ValueSources } from '../../engine/layout.ts';
import { traceAt, elementInChunk, chunkIdForElement } from '../../engine/layout.ts';
import { byteToHex, formatOffset, byteToAscii } from './viewerUtils.ts';
import { colors, displayColor, spacing } from '../../theme.ts';

interface HexRowRendererProps {
  rowIndex: number;
  byteStart: number;
  byteEnd: number;
  bytesPerRow: number;
  bytes: Uint8Array;
  layout: StageLayout;
  sources: ValueSources;
  regionByByte: Uint8Array;
  regionBoundaries: Set<number>;
  offsetWidth: number;
  totalBytes: number;
  hoveredTraceId: string | null;
  hoveredChunkId: string | null;
  isCrossPane: boolean;
  chunkShape: number[];
  interleaving: 'row' | 'column';
  onHover: (traceId: string, chunkId: string) => void;
}

export function HexRowRenderer({
  byteStart,
  byteEnd,
  bytesPerRow,
  bytes,
  layout,
  sources,
  regionByByte,
  regionBoundaries,
  offsetWidth,
  totalBytes,
  hoveredTraceId,
  hoveredChunkId,
  isCrossPane,
  chunkShape,
  interleaving,
  onHover,
}: HexRowRendererProps) {
  const rowHasBoundary = byteStart > 0 && Array.from(
    { length: Math.min(bytesPerRow, byteEnd - byteStart) },
    (_, col) => regionBoundaries.has(byteStart + col),
  ).some(Boolean);

  // Task 8 (perf plan): per-byte trace info for this row (at most
  // `bytesPerRow` bytes) via windowed traceAt lookups instead of reading a
  // materialized ByteTrace[] — cheap enough to recompute per row since a row
  // is only 8-16 bytes.
  const rowTraces = Array.from(
    { length: Math.min(bytesPerRow, byteEnd - byteStart) },
    (_, col) => traceAt(layout, byteStart + col, sources),
  );

  // UI-2 fix (remediation-plan.md task 4.2): Values/Typed/Read stage traces
  // carry chunkId '' (they precede chunking). Fall back to chunkIdForElement
  // — the chunk this element WOULD belong to once linearized — so hovering
  // these stages' hex bytes still resolves a real chunkId and cross-highlights
  // post-entropy (chunk-level) panes (replaces the old traceChunkMap lookup).
  function resolvedChunkId(trace: { chunkId: string; variableName: string; coords: number[] }): string {
    if (trace.chunkId) return trace.chunkId;
    if (trace.coords.length === 0) return '';
    return chunkIdForElement(trace.variableName, trace.coords, chunkShape, interleaving);
  }

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
            // Two spaces = same width as two hex digits; the reduce separator
            // below supplies the inter-column gap uniformly for all columns,
            // so the ASCII column stays aligned on partial final rows (UI-1).
            return <span key={col}>{'  '}</span>;
          }
          const trace = rowTraces[col];
          const isValueHovered = trace != null && hoveredTraceId !== null && trace.traceId === hoveredTraceId;
          const isChunkHovered = !isValueHovered && trace != null && (
            (isCrossPane && hoveredChunkId !== null && hoveredChunkId !== '' && trace.chunkId === hoveredChunkId)
            || (hoveredChunkId != null && hoveredChunkId !== '' && trace.coords.length > 0
              && elementInChunk(hoveredChunkId, trace.variableName, trace.coords, chunkShape))
          );
          const textColor = trace?.variableColor ? displayColor(trace.variableColor) : colors.textSecondary;
          const regionTint = regionByByte[byteIdx] === 1 ? 'var(--region-tint)' : undefined;

          return (
            <span
              key={col}
              onMouseEnter={trace ? () => onHover(trace.traceId, resolvedChunkId(trace)) : undefined}
              data-testid={`hex-byte-${byteIdx}`}
              style={{
                color: textColor,
                backgroundColor: isValueHovered ? 'var(--hover-strong)' : isChunkHovered ? 'var(--hover-weak)' :regionTint,
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
          const trace = rowTraces[col];
          const isValueHovered = trace != null && hoveredTraceId !== null && trace.traceId === hoveredTraceId;
          const isChunkHovered = !isValueHovered && trace != null && (
            (isCrossPane && hoveredChunkId !== null && hoveredChunkId !== '' && trace.chunkId === hoveredChunkId)
            || (hoveredChunkId != null && hoveredChunkId !== '' && trace.coords.length > 0
              && elementInChunk(hoveredChunkId, trace.variableName, trace.coords, chunkShape))
          );

          return (
            <span
              key={col}
              onMouseEnter={trace ? () => onHover(trace.traceId, resolvedChunkId(trace)) : undefined}
              style={{
                color: isValueHovered ? colors.textPrimary : isChunkHovered ? colors.textSecondary : colors.textTertiary,
                backgroundColor: isValueHovered ? 'var(--hover-strong)' : isChunkHovered ? 'var(--hover-weak)' :undefined,
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
