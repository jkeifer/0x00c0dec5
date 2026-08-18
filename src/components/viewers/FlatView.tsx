import { useRef, useEffect, useMemo, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { PipelineStage } from '../../types/pipeline.ts';
import { useHover } from '../../hooks/useHover.ts';
import { chunkIdForElement, type ValueSources } from '../../engine/layout.ts';
import { flatGroupCount, flatGroupAt, flatGroupIndexOf, byteToHex, scrollToIndexCentered } from './viewerUtils.ts';
import { hoverHighlightFor } from './hoverHighlight.ts';
import { colors, displayColor, fonts, fontSizes, spacing } from '../../theme.ts';
import { WINDOWED_SECTION_ROWS, WINDOW_ROWS, clampWindowStart } from './useHexData.ts';

interface FlatViewProps {
  stage: PipelineStage;
  sources: ValueSources;
  paneId: 'left' | 'right';
  chunkShape: number[];
  interleaving: 'row' | 'column';
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

export function FlatView({ stage, sources, paneId, chunkShape, interleaving }: FlatViewProps) {
  const { hoveredTraceId, hoveredChunkId, hoverSource, setHover, clearHover } = useHover();
  const parentRef = useRef<HTMLDivElement>(null);

  const layout = stage.layout;
  const groupCount = useMemo(() => flatGroupCount(layout), [layout]);

  // F9: above WINDOWED_SECTION_ROWS groups, virtualizing all of them makes a
  // scroll track tall enough to hit Firefox's ~17.9M px element-height cap
  // (same failure HexView's windowing avoids — see useHexData.ts). Mirror
  // that fix here: bound the virtualizer to a WINDOW_ROWS-sized slice of
  // groups and remap virtual row indices to real group indices by adding
  // `windowStart`.
  const windowed = groupCount > WINDOWED_SECTION_ROWS;
  const [windowStart, setWindowStart] = useState(0);
  const clampedWindowStart = windowed ? clampWindowStart(windowStart, groupCount) : 0;
  const visibleCount = windowed ? Math.min(WINDOW_ROWS, groupCount - clampedWindowStart) : groupCount;

  const virtualizer = useVirtualizer({
    count: visibleCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;

  // Cross-pane hover into a group outside the current window: change the
  // window first, then scroll once the new window's virtualizer reflects it
  // (next render) — same two-phase pendingScrollRow pattern as HexView's
  // HexSectionView (useHexData.ts's windowing).
  const pendingScrollGroup = useRef<number | null>(null);

  useEffect(() => {
    if (pendingScrollGroup.current === null) return;
    const target = pendingScrollGroup.current;
    pendingScrollGroup.current = null;
    if (target >= clampedWindowStart && target < clampedWindowStart + visibleCount) {
      scrollToIndexCentered(virtualizerRef.current, target - clampedWindowStart);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires once per windowStart landing, not per visibleCount/groupCount change
  }, [clampedWindowStart]);

  // Scroll to hovered trace from other pane — falls back to the chunkId when
  // the exact traceId has no bytes in this stage (e.g. a chunk-level hover
  // from an entropy-coded pane while this pane is pre-chunking).
  useEffect(() => {
    if (hoveredTraceId && hoverSource !== paneId) {
      let groupIdx = flatGroupIndexOf(layout, hoveredTraceId);
      if (groupIdx === undefined && hoveredChunkId) {
        groupIdx = flatGroupIndexOf(layout, hoveredChunkId);
      }
      if (groupIdx !== undefined) {
        if (windowed && (groupIdx < clampedWindowStart || groupIdx >= clampedWindowStart + visibleCount)) {
          pendingScrollGroup.current = groupIdx;
          setWindowStart(clampWindowStart(groupIdx - WINDOW_ROWS / 2, groupCount));
          return;
        }
        scrollToIndexCentered(virtualizerRef.current, groupIdx - clampedWindowStart);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clampedWindowStart/visibleCount/windowed/groupCount are derived from groupCount+windowStart, not independent triggers
  }, [hoveredTraceId, hoveredChunkId, hoverSource, paneId, layout]);

  return (
    <div
      ref={parentRef}
      onMouseLeave={clearHover}
      data-testid="flat-view"
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
          const groupIndex = clampedWindowStart + virtualRow.index;
          const group = flatGroupAt(layout, stage.bytes, sources, groupIndex);
          const prevGroup = groupIndex > 0 ? flatGroupAt(layout, stage.bytes, sources, groupIndex - 1) : null;
          const showBoundary = prevGroup !== null && prevGroup.chunkId !== group.chunkId;

          // UI-2 fix (remediation-plan.md task 4.2): Values/Typed/Read stage
          // groups carry chunkId '' (they precede chunking) but do carry
          // coords for real values — chunkIdForElement derives the chunk this
          // element WOULD belong to once linearized, the same fallback
          // TableView/GridView use, so hovering these rows still resolves a
          // real chunkId and cross-highlights post-entropy (chunk-level)
          // panes.
          const resolvedChunkId = group.chunkId
            || (group.coords.length > 0 ? chunkIdForElement(group.variableName, group.coords, chunkShape, interleaving) : '');

          const highlight = hoverHighlightFor(
            { traceId: group.traceId, chunkId: group.chunkId, coords: group.coords, variableName: group.variableName },
            { traceId: hoveredTraceId, chunkId: hoveredChunkId },
            chunkShape,
          );
          const isValueHovered = highlight === 'value';
          const isChunkHovered = highlight === 'chunk';

          // Structural traces (magic/metadata) carry no variableName/coords —
          // fall back to displayValue (e.g. "magic (start)", "metadata") so
          // these groups render a real label instead of a blank row.
          const isStructural = !group.isChunkLevel && group.variableName === '';
          const label = group.isChunkLevel
            ? `${group.chunkId} [${group.byteOffset}–${group.byteOffset + group.byteCount - 1}]`
            : isStructural
              ? `${group.displayValue} [${group.byteOffset}–${group.byteOffset + group.byteCount - 1}]`
              : `${group.variableName}${formatCoords(group.coords)}`;
          const value = group.isChunkLevel || isStructural ? '' : group.displayValue;

          return (
            <div
              key={virtualRow.key}
              onMouseEnter={() => setHover(group.traceId, resolvedChunkId, paneId)}
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
                backgroundColor: isValueHovered ? 'var(--hover-strong)' : isChunkHovered ? 'var(--hover-weak)' : undefined,
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
                  backgroundColor: group.variableColor ? displayColor(group.variableColor) : colors.textTertiary,
                  flexShrink: 0,
                }}
              />

              {/* Label */}
              <span
                style={{
                  color: group.variableColor ? displayColor(group.variableColor) : colors.textSecondary,
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
