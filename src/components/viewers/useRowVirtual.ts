import { useState, useLayoutEffect, useCallback, type RefObject } from 'react';

/** Browsers clamp any element's height to ~2^24 px (Firefox is a touch higher;
 *  Chrome hit 2^24 in practice). A virtual list whose spacer is
 *  `rowCount × rowHeight` past this is silently truncated — the tail becomes
 *  unreachable. We cap the spacer here (with headroom) and, above the cap,
 *  switch to a compressed scroll space: one native scrollbar still spans the
 *  whole dataset, but each scrollbar pixel maps to more than one row. */
export const MAX_SCROLL_PX = 15_000_000;

export interface VirtualRow {
  index: number;
  /** Top offset within the spacer div, in px. */
  top: number;
}

export interface RowVirtual {
  /** Height for the body spacer div (drives the native scrollbar). */
  totalHeight: number;
  /** True once the dataset exceeds the pixel cap and scroll is compressed. */
  compressed: boolean;
  /** Rows to render this frame, each with its spacer-local `top`. */
  rows: VirtualRow[];
  /** Scroll an absolute row index into view (centered by default). */
  scrollToIndex: (index: number, align?: 'center' | 'start') => void;
}

/**
 * A minimal fixed-row-height virtualizer with scroll compression. Below
 * MAX_SCROLL_PX it behaves like an ordinary 1:1 virtual list; above it, the
 * spacer is capped and row selection/positioning is derived from the scroll
 * fraction so a single scrollbar reaches every row (see MAX_SCROLL_PX).
 *
 * `headerPx` accounts for a sticky header occupying the top of the same scroll
 * container (the table's column header) so rows aren't positioned under it.
 */
export function useRowVirtual({
  scrollRef,
  rowCount,
  rowHeight,
  headerPx = 0,
  overscan = 8,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  rowCount: number;
  rowHeight: number;
  headerPx?: number;
  overscan?: number;
}): RowVirtual {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const sync = () => { setScrollTop(el.scrollTop); setViewportH(el.clientHeight); };
    sync();
    el.addEventListener('scroll', sync, { passive: true });
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    return () => { el.removeEventListener('scroll', sync); ro.disconnect(); };
  }, [scrollRef]);

  const natural = rowCount * rowHeight;
  const compressed = natural > MAX_SCROLL_PX;
  const totalHeight = compressed ? MAX_SCROLL_PX : natural;
  const bodyViewport = Math.max(0, viewportH - headerPx);
  const rowsInView = Math.max(1, Math.ceil(bodyViewport / rowHeight));

  const rows: VirtualRow[] = [];
  if (rowCount > 0 && viewportH > 0) {
    if (!compressed) {
      // Header is a normal-flow sibling above the spacer, so the header offset
      // cancels out of the first-row math: a row at spacer-local `a*rowHeight`
      // clears the sticky header exactly when a >= scrollTop/rowHeight.
      const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
      const last = Math.min(rowCount - 1, Math.ceil((scrollTop + viewportH) / rowHeight) + overscan);
      for (let a = first; a <= last; a++) rows.push({ index: a, top: a * rowHeight });
    } else {
      const scrollRange = headerPx + totalHeight - viewportH;
      const denom = Math.max(1, rowCount - rowsInView);
      const frac = scrollRange > 0 ? Math.min(1, Math.max(0, scrollTop / scrollRange)) : 0;
      const firstRow = Math.round(frac * denom);
      const first = Math.max(0, firstRow - overscan);
      const last = Math.min(rowCount - 1, firstRow + rowsInView + overscan);
      // Position rows relative to the current scroll offset so the compressed
      // slice tracks the scrollbar (rows always align to the viewport top).
      for (let a = first; a <= last; a++) rows.push({ index: a, top: scrollTop + (a - firstRow) * rowHeight });
    }
  }

  const scrollToIndex = useCallback((index: number, align: 'center' | 'start' = 'center') => {
    const el = scrollRef.current;
    if (!el || index < 0 || index >= rowCount) return;
    const bodyV = Math.max(0, el.clientHeight - headerPx);
    const riv = Math.max(1, Math.ceil(bodyV / rowHeight));
    if (rowCount * rowHeight <= MAX_SCROLL_PX) {
      const target = align === 'center' ? index * rowHeight - (bodyV - rowHeight) / 2 : index * rowHeight;
      el.scrollTop = Math.max(0, target);
    } else {
      const scrollRange = headerPx + MAX_SCROLL_PX - el.clientHeight;
      const denom = Math.max(1, rowCount - riv);
      const firstRow = align === 'center' ? index - Math.floor(riv / 2) : index;
      const frac = Math.min(1, Math.max(0, firstRow / denom));
      el.scrollTop = Math.max(0, Math.round(frac * scrollRange));
    }
  }, [scrollRef, rowCount, rowHeight, headerPx]);

  return { totalHeight, compressed, rows, scrollToIndex };
}
