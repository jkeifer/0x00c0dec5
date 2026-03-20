import { useRef, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { PipelineStage } from '../../types/pipeline.ts';
import type { Variable } from '../../types/state.ts';
import { getDtype } from '../../types/dtypes.ts';
import { bytesToValues, formatValue } from '../../engine/elements.ts';
import { useHover } from '../../hooks/useHover.ts';
import { colors, fonts, fontSizes, spacing } from '../../theme.ts';

interface TableViewProps {
  stage: PipelineStage;
  variables: Variable[];
  paneId: 'left' | 'right';
}

const ROW_HEIGHT = 24;
const HEADER_HEIGHT = 28;

interface ColumnData {
  variable: Variable;
  values: number[];
}

export function TableView({ stage, variables, paneId }: TableViewProps) {
  const { hoveredTraceId, hoverSource, setHover, clearHover } = useHover();
  const parentRef = useRef<HTMLDivElement>(null);

  // Reconstruct column values from the Values stage bytes
  // Layout: all bytes for var0, then var1, etc. (column-oriented)
  const columns = useMemo((): ColumnData[] => {
    let offset = 0;
    return variables.map((v) => {
      const dtypeInfo = getDtype(v.dtype);
      const totalElements = stage.bytes.length > 0
        ? computeVarElementCount(stage, variables, v)
        : 0;
      const byteLen = totalElements * dtypeInfo.size;
      const varBytes = stage.bytes.slice(offset, offset + byteLen);
      const values = bytesToValues(varBytes, v.dtype);
      offset += byteLen;
      return { variable: v, values };
    });
  }, [stage, variables]);

  const rowCount = columns.length > 0 ? columns[0].values.length : 0;

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    paddingStart: HEADER_HEIGHT,
  });

  // Scroll to hovered trace from other pane
  // traceId format for values stage: "{varName}:{flatIndex}"
  const hoveredRowIndex = useMemo(() => {
    if (!hoveredTraceId || hoverSource === paneId) return null;
    const colonIdx = hoveredTraceId.lastIndexOf(':');
    if (colonIdx < 0) return null;
    const idx = parseInt(hoveredTraceId.slice(colonIdx + 1), 10);
    return isNaN(idx) ? null : idx;
  }, [hoveredTraceId, hoverSource, paneId]);

  // Auto-scroll
  useMemo(() => {
    if (hoveredRowIndex !== null && hoveredRowIndex < rowCount) {
      virtualizer.scrollToIndex(hoveredRowIndex, { align: 'auto' });
    }
  }, [hoveredRowIndex, rowCount, virtualizer]);

  const colWidth = Math.max(100, Math.floor(600 / Math.max(columns.length, 1)));

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
                const traceId = `${col.variable.name}:${rowIdx}`;
                const isHovered = hoveredTraceId !== null && hoveredTraceId === traceId;
                const val = rowIdx < col.values.length ? col.values[rowIdx] : undefined;

                return (
                  <div
                    key={col.variable.id}
                    onMouseEnter={() => setHover(traceId, paneId)}
                    style={{
                      width: colWidth,
                      flexShrink: 0,
                      padding: `0 ${spacing.xs}px`,
                      color: colors.textPrimary,
                      backgroundColor: isHovered ? 'rgba(255,255,255,0.08)' : undefined,
                      cursor: 'default',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {val !== undefined ? formatValue(val, col.variable.dtype) : ''}
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

/** Compute element count for a variable in the Values stage. */
function computeVarElementCount(
  stage: PipelineStage,
  variables: Variable[],
  targetVar: Variable,
): number {
  // Total bytes / total bytes-per-element across all variables = elements per variable
  // But variables can have different dtypes, so we compute from total byte budget
  let totalBytesPerElement = 0;
  for (const v of variables) {
    totalBytesPerElement += getDtype(v.dtype).size;
  }
  const totalElements = Math.floor(stage.bytes.length / totalBytesPerElement);
  // Verify: for this specific variable
  void targetVar; // all variables have the same element count in the Values stage
  return totalElements;
}
