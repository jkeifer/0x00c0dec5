import { useRef, useMemo, useEffect, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { PipelineStage } from '../../types/pipeline.ts';
import type { Variable } from '../../types/state.ts';
import type { DtypeKey } from '../../types/dtypes.ts';
import { getDtype } from '../../types/dtypes.ts';
import { bytesToValues, formatValue, formatLogicalValue } from '../../engine/elements.ts';
import { flatIndexToCoords } from '../../engine/chunk.ts';
import { useHover } from '../../hooks/useHover.ts';
import { useContainerWidth } from '../../hooks/useContainerWidth.ts';
import { colors, fonts, fontSizes, spacing } from '../../theme.ts';

interface TableViewProps {
  stage: PipelineStage;
  variables: Variable[];
  shape: number[];
  paneId: 'left' | 'right';
  chunkTraceMap?: Map<string, Set<string>>;
  traceChunkMap?: Map<string, string>;
  diffValues?: Map<string, number[]>;
  showDiff?: boolean;
  isLogicalValues?: boolean; // true for Values/Read stage (float64 logical values)
}

const ROW_HEIGHT = 24;
const HEADER_HEIGHT = 28;

interface ColumnData {
  variable: Variable;
  values: number[];
  dtype: DtypeKey;
}

export function TableView({ stage, variables, shape, paneId, chunkTraceMap, traceChunkMap, diffValues, showDiff, isLogicalValues }: TableViewProps) {
  const { hoveredTraceId, hoveredChunkId, hoverSource, setHover, clearHover } = useHover();
  const parentRef = useRef<HTMLDivElement>(null);

  // Reconstruct column values from the stage bytes
  // Layout: all bytes for var0, then var1, etc. (column-oriented)
  const columns = useMemo((): ColumnData[] => {
    let offset = 0;
    return variables.map((v) => {
      // For Values/Read stages (isLogicalValues), data is float64
      // For Typed stage, data is in storageDtype
      const dtype: DtypeKey = isLogicalValues ? 'float64' : v.typeAssignment.storageDtype;
      const dtypeInfo = getDtype(dtype);
      const totalElements = stage.bytes.length > 0
        ? computeVarElementCount(stage, variables, isLogicalValues)
        : 0;
      const byteLen = totalElements * dtypeInfo.size;
      const varBytes = stage.bytes.slice(offset, offset + byteLen);
      const values = bytesToValues(varBytes, dtype);
      offset += byteLen;
      return { variable: v, values, dtype };
    });
  }, [stage, variables, isLogicalValues]);

  const rowCount = columns.length > 0 ? columns[0].values.length : 0;

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    paddingStart: HEADER_HEIGHT,
  });

  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;

  // Resolve traceId → row index for auto-scroll
  const traceIdToRowIndex = useCallback((traceId: string): number | null => {
    const colonIdx = traceId.indexOf(':');
    if (colonIdx < 0) return null;
    const coordStr = traceId.slice(colonIdx + 1);
    const parts = coordStr.split(',').map(Number);
    if (parts.some(isNaN)) return null;
    let idx = 0;
    for (let d = 0; d < parts.length; d++) {
      idx = idx * (shape[d] ?? 1) + parts[d];
    }
    return idx;
  }, [shape]);

  // Scroll to hovered trace from other pane (value-level or chunk-level)
  const hoveredRowIndex = useMemo(() => {
    if (hoverSource === paneId) return null;
    // Try exact traceId first
    if (hoveredTraceId) {
      const idx = traceIdToRowIndex(hoveredTraceId);
      if (idx !== null) return idx;
    }
    // Fall back to chunk-level: find first traceId in the chunk
    if (hoveredChunkId) {
      const traceIds = chunkTraceMap?.get(hoveredChunkId);
      if (traceIds) {
        for (const tid of traceIds) {
          const idx = traceIdToRowIndex(tid);
          if (idx !== null) return idx;
        }
      }
    }
    return null;
  }, [hoveredTraceId, hoveredChunkId, hoverSource, paneId, traceIdToRowIndex, chunkTraceMap]);

  // Auto-scroll
  useEffect(() => {
    if (hoveredRowIndex !== null && hoveredRowIndex < rowCount) {
      virtualizerRef.current.scrollToIndex(hoveredRowIndex, { align: 'auto' });
    }
  }, [hoveredRowIndex, rowCount]);

  const containerWidth = useContainerWidth(parentRef);
  const availableWidth = (containerWidth > 0 ? containerWidth : 600) - 50; // subtract row index column
  const colWidth = Math.max(100, Math.floor(availableWidth / Math.max(columns.length, 1)));
  const minTableWidth = columns.length > 0 ? 50 + 100 * columns.length : undefined;

  return (
    <div
      ref={parentRef}
      onMouseLeave={clearHover}
      style={{
        height: '100%',
        overflow: 'auto',
        fontFamily: fonts.mono,
        fontSize: fontSizes.md,
      }}
    >
      {/* Sticky header */}
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 1,
          display: 'flex',
          background: colors.surface,
          borderBottom: `1px solid ${colors.border}`,
          height: HEADER_HEIGHT,
          alignItems: 'center',
          fontWeight: 600,
          fontSize: fontSizes.sm,
          minWidth: minTableWidth,
        }}
      >
        <div
          style={{
            width: 50,
            flexShrink: 0,
            textAlign: 'right',
            padding: `0 ${spacing.xs}px`,
            color: colors.textTertiary,
          }}
        >
          #
        </div>
        {columns.map((col) => (
          <div
            key={col.variable.id}
            style={{
              width: colWidth,
              flexShrink: 0,
              padding: `0 ${spacing.xs}px`,
              color: col.variable.color,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {col.variable.name}
          </div>
        ))}
      </div>

      {/* Virtual body */}
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: '100%',
          position: 'relative',
          minWidth: minTableWidth,
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const rowIdx = virtualRow.index;
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
                alignItems: 'center',
              }}
            >
              {/* Row index */}
              <div
                style={{
                  width: 50,
                  flexShrink: 0,
                  textAlign: 'right',
                  padding: `0 ${spacing.xs}px`,
                  color: colors.textTertiary,
                  fontSize: fontSizes.sm,
                }}
              >
                {rowIdx}
              </div>

              {/* Cells */}
              {columns.map((col) => {
                const coords = flatIndexToCoords(rowIdx, shape);
                const traceId = `${col.variable.name}:${coords.join(',')}`;
                const isValueHovered = hoveredTraceId !== null && hoveredTraceId === traceId;
                const tableChunkTraceIds = hoveredChunkId ? chunkTraceMap?.get(hoveredChunkId) : undefined;
                const isChunkHovered = !isValueHovered && tableChunkTraceIds != null && tableChunkTraceIds.has(traceId);
                const val = rowIdx < col.values.length ? col.values[rowIdx] : undefined;
                const chunkId = traceChunkMap?.get(traceId) ?? null;

                // Diff detection
                const origVals = showDiff && diffValues ? diffValues.get(col.variable.name) : undefined;
                const origVal = origVals && rowIdx < origVals.length ? origVals[rowIdx] : undefined;
                const hasDiff = showDiff && val !== undefined && origVal !== undefined && val !== origVal;
                const diffDelta = hasDiff ? val - origVal! : 0;
                const diffBg = hasDiff ? colors.warningDim : undefined;
                const diffTitle = hasDiff
                  ? `Original: ${formatLogicalValue(origVal!)} → Reconstructed: ${formatLogicalValue(val)} (Δ = ${diffDelta >= 0 ? '+' : ''}${diffDelta.toPrecision(4)})`
                  : undefined;

                // Format value based on whether this is logical or typed stage
                const displayValue = val !== undefined
                  ? (isLogicalValues ? formatLogicalValue(val) : formatValue(val, col.dtype))
                  : '';

                return (
                  <div
                    key={col.variable.id}
                    onMouseEnter={() => setHover(traceId, chunkId, paneId)}
                    title={diffTitle}
                    style={{
                      width: colWidth,
                      flexShrink: 0,
                      padding: `0 ${spacing.xs}px`,
                      color: colors.textPrimary,
                      backgroundColor: isValueHovered
                        ? 'rgba(255,255,255,0.16)'
                        : isChunkHovered
                          ? 'rgba(255,255,255,0.07)'
                          : diffBg,
                      cursor: 'default',
                      transition: 'background-color 0.1s ease',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {displayValue}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Compute element count for a variable in a given stage. */
function computeVarElementCount(
  stage: PipelineStage,
  variables: Variable[],
  isLogicalValues?: boolean,
): number {
  let totalBytesPerElement = 0;
  for (const v of variables) {
    const dtype: DtypeKey = isLogicalValues ? 'float64' : v.typeAssignment.storageDtype;
    totalBytesPerElement += getDtype(dtype).size;
  }
  return totalBytesPerElement > 0 ? Math.floor(stage.bytes.length / totalBytesPerElement) : 0;
}
