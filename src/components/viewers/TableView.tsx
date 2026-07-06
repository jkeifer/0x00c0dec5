import { useRef, useMemo, useEffect, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Variable } from '../../types/state.ts';
import type { DtypeKey } from '../../types/dtypes.ts';
import { formatValue, formatLogicalValue } from '../../engine/elements.ts';
import { flatIndexToCoords } from '../../engine/chunk.ts';
import { makeTraceId, parseTraceId } from '../../engine/trace.ts';
import { useHover } from '../../hooks/useHover.ts';
import { useContainerWidth } from '../../hooks/useContainerWidth.ts';
import { colors, displayColor, fonts, fontSizes, spacing } from '../../theme.ts';
import { isDiffValue, computeDiffSummary, type DiffSummary } from './viewerUtils.ts';

interface TableViewProps {
  variables: Variable[];
  shape: number[];
  paneId: 'left' | 'right';
  /**
   * D6 (remediation-plan.md, Phase 3.3): source values per variable NAME,
   * supplied by the pipeline (`logicalValues`/`typedValues`/
   * `readResult.reconstructedValues`) rather than decoded from stage bytes
   * here. TableView only ever renders the Values/Typed/Read stages (see
   * StagePane's view-mode gating), so this is always populated for it.
   */
  values: Map<string, number[]>;
  chunkTraceMap?: Map<string, Set<string>>;
  traceChunkMap?: Map<string, string>;
  diffValues?: Map<string, number[]>;
  showDiff?: boolean;
  isLogicalValues?: boolean; // true for Values/Read stage (float64 logical values) — controls display formatting only
}

const ROW_HEIGHT = 24;
const HEADER_HEIGHT = 28;
// When diff mode adds a summary line under each variable name, the sticky
// header needs extra height for it — both the header's own CSS height and
// the virtualizer's `paddingStart` (so rows don't render underneath it).
const HEADER_HEIGHT_WITH_DIFF = 42;

interface ColumnData {
  variable: Variable;
  values: number[];
  dtype: DtypeKey;
}

export function TableView({ variables, shape, paneId, values, chunkTraceMap, traceChunkMap, diffValues, showDiff, isLogicalValues }: TableViewProps) {
  const { hoveredTraceId, hoveredChunkId, hoverSource, setHover, clearHover } = useHover();
  const parentRef = useRef<HTMLDivElement>(null);

  // Look up each variable's values from the pipeline-supplied maps — no byte
  // decoding here (D6, fixes UI-9).
  const columns = useMemo((): ColumnData[] => {
    return variables.map((v) => {
      const dtype: DtypeKey = isLogicalValues ? 'float64' : v.typeAssignment.storageDtype;
      return { variable: v, values: values.get(v.name) ?? [], dtype };
    });
  }, [variables, values, isLogicalValues]);

  const rowCount = columns.length > 0 ? columns[0].values.length : 0;

  // Task 4.5 / extension-read-step.md Diff View spec: per-variable summary
  // stats (differing count / max / mean abs error), shown as a header
  // annotation when diff mode is on. Memoized so a hover-driven re-render
  // (which doesn't change values/diffValues) doesn't recompute it.
  const diffSummaries = useMemo((): Map<string, DiffSummary> => {
    const result = new Map<string, DiffSummary>();
    if (!showDiff || !diffValues) return result;
    for (const col of columns) {
      const origVals = diffValues.get(col.variable.name);
      if (!origVals) continue;
      result.set(col.variable.name, computeDiffSummary(col.values, origVals));
    }
    return result;
  }, [showDiff, diffValues, columns]);

  const hasDiffSummaries = diffSummaries.size > 0;
  const headerHeight = hasDiffSummaries ? HEADER_HEIGHT_WITH_DIFF : HEADER_HEIGHT;

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    paddingStart: headerHeight,
  });

  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;

  // Resolve traceId → row index for auto-scroll. Must check parseTraceId's
  // `kind` before treating the remainder as coordinates — a chunk-level id
  // like 'chunk:0,1' otherwise "parses" as bogus coords [0, 1] (UI-3: this
  // silently produced a wrong auto-scroll target instead of falling through
  // to the chunk-level fallback in `hoveredRowIndex` below).
  const traceIdToRowIndex = useCallback((traceId: string): number | null => {
    const parsed = parseTraceId(traceId);
    if (parsed.kind !== 'value' || parsed.coords.length === 0) return null;
    const parts = parsed.coords;
    if (parts.some((n) => Number.isNaN(n))) return null;
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
      data-testid="table-view"
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
          height: headerHeight,
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
        {columns.map((col) => {
          const summary = diffSummaries.get(col.variable.name);
          return (
            <div
              key={col.variable.id}
              data-testid={summary ? `table-diff-summary-${col.variable.name}` : undefined}
              style={{
                width: colWidth,
                flexShrink: 0,
                padding: `0 ${spacing.xs}px`,
                color: displayColor(col.variable.color),
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{col.variable.name}</div>
              {summary && (
                <div
                  style={{
                    fontSize: fontSizes.xs,
                    fontWeight: 400,
                    fontFamily: fonts.mono,
                    color: summary.count > 0 ? colors.warning : colors.textTertiary,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {summary.count === 0
                    ? 'no diffs'
                    : `${summary.count} diff / max Δ ${summary.maxAbsError.toPrecision(4)} / mean Δ ${summary.meanAbsError.toPrecision(4)}`}
                </div>
              )}
            </div>
          );
        })}
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
                const traceId = makeTraceId(col.variable.name, coords);
                const isValueHovered = hoveredTraceId !== null && hoveredTraceId === traceId;
                const tableChunkTraceIds = hoveredChunkId ? chunkTraceMap?.get(hoveredChunkId) : undefined;
                const isChunkHovered = !isValueHovered && tableChunkTraceIds != null && tableChunkTraceIds.has(traceId);
                const val = rowIdx < col.values.length ? col.values[rowIdx] : undefined;
                const chunkId = traceChunkMap?.get(traceId) ?? null;

                // Diff detection
                const origVals = showDiff && diffValues ? diffValues.get(col.variable.name) : undefined;
                const origVal = origVals && rowIdx < origVals.length ? origVals[rowIdx] : undefined;
                // Task 4.5 (fixes UI-14): NaN-aware equality — plain `!==`
                // flagged a losslessly round-tripped NaN as a diff (NaN !==
                // NaN in JS). `isDiffValue` treats NaN-vs-NaN as equal.
                const hasDiff = showDiff && val !== undefined && origVal !== undefined && isDiffValue(val, origVal);
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
                    data-testid={`table-cell-${col.variable.name}-${rowIdx}`}
                    style={{
                      width: colWidth,
                      flexShrink: 0,
                      padding: `0 ${spacing.xs}px`,
                      color: colors.textPrimary,
                      backgroundColor: isValueHovered
                        ? 'var(--hover-strong)'
                        : isChunkHovered
                          ? 'var(--hover-weak)'
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
