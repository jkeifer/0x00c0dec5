import { useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useHover } from '../../hooks/useHover.ts';
import { useContainerWidth } from '../../hooks/useContainerWidth.ts';
import { formatByteCount } from '../../engine/bytes.ts';
import { HexRowRenderer } from './HexRowRenderer.tsx';
import { useHexData, type HexSection, type HexSectionData } from './useHexData.ts';
import { colors, fonts, fontSizes, spacing } from '../../theme.ts';

export type { HexSection };

interface HexViewProps {
  sections: HexSection[];
  paneId: 'left' | 'right';
  chunkTraceMap?: Map<string, Set<string>>;
}

const NARROW_BREAKPOINT = 500;
const ROW_HEIGHT = 20;
const HEADER_HEIGHT = 28;

interface HexSectionHandle {
  scrollToRow: (rowIndex: number) => void;
}

interface HexSectionViewProps {
  sectionData: HexSectionData;
  sectionIndex: number;
  scrollElementRef: React.RefObject<HTMLDivElement | null>;
  scrollMargin: number;
  bytesPerRow: number;
  offsetWidth: number;
  hoveredTraceId: string | null;
  hoveredChunkId: string | null;
  isCrossPane: boolean;
  chunkTraceMap?: Map<string, Set<string>>;
  onHover: (traceId: string, chunkId: string) => void;
  showHeader: boolean;
}

/**
 * Renders one section's rows behind its own `useVirtualizer` call, scrolling
 * within the shared scroll container via `scrollMargin`. Each section owns
 * its sticky header (`position: sticky; top: 0`) *inside a wrapper the height
 * of just that section's content* — the header can only stick while its own
 * rows are in view, then scrolls away as the next section's wrapper begins.
 * This is the UI-18 fix: the pre-merge WriteHexView instead put every
 * section's header at the containing scroller's `top: 0` with no such
 * per-section scoping, so earlier headers stacked beneath the current one.
 */
const HexSectionView = forwardRef<HexSectionHandle, HexSectionViewProps>(
  function HexSectionView(
    {
      sectionData,
      sectionIndex,
      scrollElementRef,
      scrollMargin,
      bytesPerRow,
      offsetWidth,
      hoveredTraceId,
      hoveredChunkId,
      isCrossPane,
      chunkTraceMap,
      onHover,
      showHeader,
    },
    ref,
  ) {
    const virtualizer = useVirtualizer({
      count: sectionData.rowCount,
      getScrollElement: () => scrollElementRef.current,
      estimateSize: () => ROW_HEIGHT,
      overscan: 10,
      scrollMargin,
    });

    useImperativeHandle(ref, () => ({
      scrollToRow: (rowIndex: number) => {
        virtualizer.scrollToIndex(rowIndex, { align: 'auto' });
      },
    }));

    return (
      <div style={{ position: 'relative' }}>
        {showHeader && sectionData.header && (
          <div
            style={{
              position: 'sticky',
              top: 0,
              zIndex: 1,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: `${spacing.xs}px ${spacing.sm}px`,
              background: colors.surfaceHover,
              borderTop: sectionIndex > 0 ? `1px solid ${colors.border}` : undefined,
              borderBottom: `1px solid ${colors.borderSubtle}`,
              fontSize: fontSizes.sm,
              lineHeight: `${HEADER_HEIGHT - spacing.xs * 2}px`,
              height: HEADER_HEIGHT,
              boxSizing: 'border-box',
            }}
          >
            <span style={{ color: colors.textPrimary }}>{sectionData.header.name}</span>
            <span style={{ color: colors.textTertiary, marginLeft: spacing.sm }}>
              {formatByteCount(sectionData.header.size)}
            </span>
          </div>
        )}
        <div
          style={{
            height: virtualizer.getTotalSize(),
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const rowIndex = virtualRow.index;
            const byteStart = rowIndex * bytesPerRow;
            const byteEnd = Math.min(byteStart + bytesPerRow, sectionData.bytes.length);

            return (
              <div
                key={virtualRow.key}
                style={{
                  position: 'absolute',
                  top: virtualRow.start - virtualizer.options.scrollMargin,
                  left: 0,
                  right: 0,
                  height: ROW_HEIGHT,
                  display: 'flex',
                  whiteSpace: 'pre',
                  padding: `0 ${spacing.sm}px`,
                }}
              >
                <HexRowRenderer
                  rowIndex={rowIndex}
                  byteStart={byteStart}
                  byteEnd={byteEnd}
                  bytesPerRow={bytesPerRow}
                  bytes={sectionData.bytes}
                  traces={sectionData.traces}
                  regionByByte={sectionData.regionByByte}
                  regionBoundaries={sectionData.regionBoundaries}
                  offsetWidth={offsetWidth}
                  totalBytes={sectionData.bytes.length}
                  hoveredTraceId={hoveredTraceId}
                  hoveredChunkId={hoveredChunkId}
                  isCrossPane={isCrossPane}
                  chunkTraceMap={chunkTraceMap}
                  onHover={onHover}
                />
              </div>
            );
          })}
        </div>
      </div>
    );
  },
);

/**
 * Hex viewer for one or more byte sections (task 3.5, remediation-plan.md
 * Phase 3): a single-element `sections` array reproduces the pre-merge
 * HexView behavior (one stage's bytes); a multi-element array (one per
 * output file) reproduces the pre-merge WriteHexView behavior (sticky
 * per-file headers). `HexRowRenderer` remains the single row renderer for
 * both cases — its padding/alignment logic (UI-1) is untouched here; Phase 4
 * fixes that separately.
 */
export function HexView({ sections, paneId, chunkTraceMap }: HexViewProps) {
  const { hoveredTraceId, hoveredChunkId, hoverSource, setHover, clearHover } = useHover();
  const parentRef = useRef<HTMLDivElement>(null);
  const containerWidth = useContainerWidth(parentRef);
  const bytesPerRow = containerWidth > 0 && containerWidth < NARROW_BREAKPOINT ? 8 : 16;

  const sectionRefs = useRef<(HexSectionHandle | null)[]>([]);

  const hexData = useHexData(sections, bytesPerRow);

  const isCrossPane = hoverSource !== null && hoverSource !== paneId;

  const handleHover = useCallback(
    (traceId: string, chunkId: string) => setHover(traceId, chunkId, paneId),
    [setHover, paneId],
  );

  // Compute each section's scrollMargin (its rowOffset already accounts for
  // headers, so the byte offset is simply rowOffset * ROW_HEIGHT).
  const scrollMargins = hexData.sections.map((s) => s.rowOffset * ROW_HEIGHT);

  // Cross-pane scroll sync: find the hovered trace/chunk across all sections.
  useEffect(() => {
    if (hoveredTraceId && hoverSource !== paneId) {
      for (let si = 0; si < hexData.sections.length; si++) {
        const sd = hexData.sections[si];
        let byteIdx = sd.traceIndex.get(hoveredTraceId);
        if (byteIdx === undefined && hoveredChunkId) {
          byteIdx = sd.chunkIndex.get(hoveredChunkId);
        }
        if (byteIdx !== undefined) {
          const rowIdx = Math.floor(byteIdx / bytesPerRow);
          sectionRefs.current[si]?.scrollToRow(rowIdx);
          return;
        }
      }
    }
  }, [hoveredTraceId, hoveredChunkId, hoverSource, paneId, hexData.sections, bytesPerRow]);

  return (
    <div
      ref={parentRef}
      onMouseLeave={clearHover}
      data-testid={hexData.showHeaders ? 'write-hex-view' : 'hex-view'}
      style={{
        height: '100%',
        overflow: 'auto',
        fontFamily: fonts.mono,
        fontSize: fontSizes.md,
        lineHeight: `${ROW_HEIGHT}px`,
      }}
    >
      {hexData.sections.map((sd, si) => (
        <HexSectionView
          key={sd.key}
          ref={(handle) => { sectionRefs.current[si] = handle; }}
          sectionData={sd}
          sectionIndex={si}
          scrollElementRef={parentRef}
          scrollMargin={scrollMargins[si]}
          bytesPerRow={bytesPerRow}
          offsetWidth={hexData.offsetWidth}
          hoveredTraceId={hoveredTraceId}
          hoveredChunkId={hoveredChunkId}
          isCrossPane={isCrossPane}
          chunkTraceMap={chunkTraceMap}
          onHover={handleHover}
          showHeader={hexData.showHeaders}
        />
      ))}
    </div>
  );
}
