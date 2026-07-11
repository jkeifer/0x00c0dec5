import { useRef, useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useHover } from '../../hooks/useHover.ts';
import { useContainerWidth } from '../../hooks/useContainerWidth.ts';
import { formatByteCount } from '../../engine/bytes.ts';
import { HexRowRenderer } from './HexRowRenderer.tsx';
import {
  useHexData,
  firstByteForTrace,
  clampWindowStart,
  windowStartForByte,
  WINDOW_ROWS,
  WINDOW_CONTROLS_HEIGHT,
  type HexSection,
  type HexSectionData,
} from './useHexData.ts';
import { FileMapStrip } from './FileMapStrip.tsx';
import { colors, fonts, fontSizes, spacing } from '../../theme.ts';

export type { HexSection };

interface HexViewProps {
  sections: HexSection[];
  paneId: 'left' | 'right';
  chunkShape: number[];
  interleaving: 'row' | 'column';
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
  chunkShape: number[];
  interleaving: 'row' | 'column';
  onHover: (traceId: string, chunkId: string) => void;
  showHeader: boolean;
  windowStart: number;
  onWindowStartChange: (newStart: number) => void;
}

/** Parses an offset-jump input value: `0x`-prefixed or bare hex. Returns
 *  undefined for anything that doesn't parse (edge-case philosophy — invalid
 *  input is ignored, not an error). */
function parseHexOffset(raw: string): number | undefined {
  const trimmed = raw.trim();
  const hexPart = trimmed.toLowerCase().startsWith('0x') ? trimmed.slice(2) : trimmed;
  if (hexPart === '' || !/^[0-9a-f]+$/i.test(hexPart)) return undefined;
  const value = parseInt(hexPart, 16);
  return Number.isFinite(value) ? value : undefined;
}

interface HexWindowControlsProps {
  layout: HexSectionData['layout'];
  windowStart: number;
  windowEnd: number;
  bytesPerRow: number;
  onJump: (byteOffset: number) => void;
}

/** FileMapStrip + offset-jump input rendered above a windowed section's rows
 *  (WINDOW_CONTROLS_HEIGHT tall — kept in sync with useHexData.ts's constant
 *  so downstream sections' scrollMargin math lines up). */
function HexWindowControls({ layout, windowStart, windowEnd, bytesPerRow, onJump }: HexWindowControlsProps) {
  const [offsetInput, setOffsetInput] = useState('');

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    const byteOffset = parseHexOffset(offsetInput);
    if (byteOffset === undefined) return;
    onJump(byteOffset);
  }

  return (
    <div style={{ height: WINDOW_CONTROLS_HEIGHT, boxSizing: 'border-box', overflow: 'hidden', padding: `${spacing.xs}px ${spacing.sm}px` }}>
      <FileMapStrip
        layout={layout}
        windowStart={windowStart * bytesPerRow}
        windowEnd={windowEnd * bytesPerRow}
        onJump={onJump}
      />
      <input
        type="text"
        data-testid="hex-offset-input"
        placeholder="jump to offset (hex)"
        value={offsetInput}
        onChange={(e) => setOffsetInput(e.target.value)}
        onKeyDown={handleKeyDown}
        style={{
          marginTop: spacing.xs,
          width: '100%',
          boxSizing: 'border-box',
          background: colors.surface,
          color: colors.textPrimary,
          border: `1px solid ${colors.border}`,
          borderRadius: 2,
          fontFamily: fonts.mono,
          fontSize: fontSizes.sm,
          padding: `1px ${spacing.xs}px`,
        }}
      />
    </div>
  );
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
      chunkShape,
      interleaving,
      onHover,
      showHeader,
      windowStart,
      onWindowStartChange,
    },
    ref,
  ) {
    const { windowed, rowCount } = sectionData;
    // Clamp against the CURRENT rowCount before any derived math: windowStart
    // comes from parent state keyed by section key, which persists across a
    // shape shrink. An unclamped stale value here can exceed rowCount, making
    // visibleCount negative (useVirtualizer count negative; cross-pane
    // scrollToRow mis-targets). clampWindowStart is shrink-safe (see
    // useHexData.ts) — use its output everywhere below, not the raw prop.
    const clampedWindowStart = windowed ? clampWindowStart(windowStart, rowCount) : windowStart;
    const visibleCount = windowed ? Math.min(WINDOW_ROWS, rowCount - clampedWindowStart) : rowCount;

    const virtualizer = useVirtualizer({
      count: visibleCount,
      getScrollElement: () => scrollElementRef.current,
      estimateSize: () => ROW_HEIGHT,
      overscan: 10,
      scrollMargin,
    });

    // Cross-pane hover into a row outside the current window: change the
    // window first, then scroll once the new window's virtualizer reflects
    // it (next render). pendingScrollRow holds the true row index we owe a
    // scroll to; the effect below fires after windowStart lands.
    const pendingScrollRow = useRef<number | null>(null);

    useImperativeHandle(ref, () => ({
      scrollToRow: (rowIndex: number) => {
        if (windowed && (rowIndex < clampedWindowStart || rowIndex >= clampedWindowStart + visibleCount)) {
          pendingScrollRow.current = rowIndex;
          onWindowStartChange(clampWindowStart(windowStartForByte(rowIndex * bytesPerRow, bytesPerRow, rowCount), rowCount));
          return;
        }
        virtualizer.scrollToIndex(rowIndex - clampedWindowStart, { align: 'auto' });
      },
    }));

    useEffect(() => {
      if (pendingScrollRow.current === null) return;
      const target = pendingScrollRow.current;
      pendingScrollRow.current = null;
      if (target >= clampedWindowStart && target < clampedWindowStart + visibleCount) {
        virtualizer.scrollToIndex(target - clampedWindowStart, { align: 'auto' });
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [clampedWindowStart]);

    function handleJump(byteOffset: number) {
      onWindowStartChange(clampWindowStart(windowStartForByte(byteOffset, bytesPerRow, rowCount), rowCount));
    }

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
        {windowed && (
          <HexWindowControls
            layout={sectionData.layout}
            windowStart={clampedWindowStart}
            windowEnd={clampedWindowStart + visibleCount}
            bytesPerRow={bytesPerRow}
            onJump={handleJump}
          />
        )}
        <div
          style={{
            height: virtualizer.getTotalSize(),
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const rowIndex = windowed ? clampedWindowStart + virtualRow.index : virtualRow.index;
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
                  layout={sectionData.layout}
                  sources={sectionData.sources}
                  regionByByte={sectionData.regionByByte}
                  regionBoundaries={sectionData.regionBoundaries}
                  offsetWidth={offsetWidth}
                  totalBytes={sectionData.bytes.length}
                  hoveredTraceId={hoveredTraceId}
                  hoveredChunkId={hoveredChunkId}
                  isCrossPane={isCrossPane}
                  chunkShape={chunkShape}
                  interleaving={interleaving}
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
export function HexView({ sections, paneId, chunkShape, interleaving }: HexViewProps) {
  const { hoveredTraceId, hoveredChunkId, hoverSource, setHover, clearHover } = useHover();
  const parentRef = useRef<HTMLDivElement>(null);
  const containerWidth = useContainerWidth(parentRef);
  const bytesPerRow = containerWidth > 0 && containerWidth < NARROW_BREAKPOINT ? 8 : 16;

  const sectionRefs = useRef<(HexSectionHandle | null)[]>([]);

  const hexData = useHexData(sections, bytesPerRow);

  // Per-section window start row (only meaningful for windowed sections),
  // keyed by section key so it survives across renders as sections change.
  // Below WINDOWED_SECTION_ROWS a section never reads this — it's always 0
  // and unused, preserving today's unbounded-virtualizer behavior exactly.
  const [windowStarts, setWindowStarts] = useState<Record<string, number>>({});

  const isCrossPane = hoverSource !== null && hoverSource !== paneId;

  // HexRowRenderer already resolves the chunkId (falling back to
  // chunkIdForElement for Values/Typed/Read stage bytes — UI-2 fix,
  // remediation-plan.md task 4.2) before calling onHover, so this just
  // forwards it into hover state.
  const handleHover = (traceId: string, chunkId: string) => {
    setHover(traceId, chunkId, paneId);
  };

  // Compute each section's scrollMargin (its rowOffset already accounts for
  // headers, so the byte offset is simply rowOffset * ROW_HEIGHT — plus any
  // prior windowed sections' FileMapStrip/offset-input height, which isn't
  // row-shaped so it's tracked separately as rowOffsetExtraPx and added in
  // raw pixels).
  const scrollMargins = hexData.sections.map((s) => s.rowOffset * ROW_HEIGHT + s.rowOffsetExtraPx);

  // Cross-pane scroll sync: find the hovered trace/chunk across all sections.
  useEffect(() => {
    if (hoveredTraceId && hoverSource !== paneId) {
      for (let si = 0; si < hexData.sections.length; si++) {
        const sd = hexData.sections[si];
        const byteIdx = firstByteForTrace(sd.layout, hoveredTraceId, hoveredChunkId ?? undefined);
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
          chunkShape={chunkShape}
          interleaving={interleaving}
          onHover={handleHover}
          showHeader={hexData.showHeaders}
          windowStart={windowStarts[sd.key] ?? 0}
          onWindowStartChange={(newStart) => setWindowStarts((prev) => ({ ...prev, [sd.key]: newStart }))}
        />
      ))}
    </div>
  );
}
