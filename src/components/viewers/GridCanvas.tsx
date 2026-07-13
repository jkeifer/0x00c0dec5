import { useEffect, useMemo, useRef, useState } from 'react';
import { flatIndexToCoords } from '../../engine/chunk.ts';
import { makeTraceId, parseTraceId } from '../../engine/trace.ts';
import { formatLogicalValue } from '../../engine/elements.ts';
import { elementInChunk, chunkIdForElement, type ValueArray } from '../../engine/layout.ts';
import { useHover } from '../../hooks/useHover.ts';
import { colors, fonts, fontSizes, spacing } from '../../theme.ts';
import { buildGridImage } from './gridImage.ts';

interface GridCanvasProps {
  rows: number;
  cols: number;
  values: ValueArray;
  colorValues: ArrayLike<number>;
  min: number;
  max: number;
  variable: { name: string; color: string };
  chunkShape: number[];
  interleaving: 'row' | 'column';
  paneId: 'left' | 'right';
  shape: number[];
  diffs?: { diffs: Float64Array; diffActive: Uint8Array; maxAbsDiff: number };
}

/** Parse a chunkId's trailing chunk-coordinate list (mirrors
 *  elementInChunk's own parsing — layout.ts has no standalone exported
 *  parser for just the coords, only the membership check). Returns null for
 *  ids that don't carry the expected 'chunk:' prefix. */
function parseChunkCoords(chunkId: string): number[] | null {
  if (!chunkId.startsWith('chunk:')) return null;
  const rest = chunkId.slice('chunk:'.length);
  const parts = rest.split(':');
  const coordsPart = parts.length === 2 ? parts[1] : parts[0];
  if (coordsPart === '') return [];
  return coordsPart.split(',').map(Number);
}

export function GridCanvas({
  rows, cols, values, colorValues, min, max, variable, chunkShape, interleaving, paneId, shape, diffs,
}: GridCanvasProps) {
  const { hoveredTraceId, hoveredChunkId, hoverSource, setHover, clearHover } = useHover();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [localHoverIdx, setLocalHoverIdx] = useState<number | null>(null);
  // CSS scale factor (displayed px per source element) — recomputed on
  // resize so overlay/hover math stays correct if the pane is resized.
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || cols <= 0) return;
    const update = () => setScale(el.clientWidth / cols);
    update();
    const obs = new ResizeObserver(update);
    obs.observe(el);
    return () => obs.disconnect();
  }, [cols]);

  // Draw: one px per element via ImageData, keyed on every image input.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || cols <= 0 || rows <= 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const buffer = buildGridImage({
      colorValues, min, max, baseColor: variable.color, width: cols, height: rows,
      diffs: diffs?.diffs, diffActive: diffs?.diffActive, maxAbsDiff: diffs?.maxAbsDiff,
    });
    // ponytail: TS 5.9's lib.dom types Uint8ClampedArray's buffer as
    // ArrayBufferLike (which includes SharedArrayBuffer); ImageData's
    // constructor wants the narrower ArrayBuffer-backed form. buildGridImage
    // always allocates a plain `new Uint8ClampedArray(n)` (never a
    // SharedArrayBuffer view), so this cast is safe, not a real risk.
    ctx.putImageData(new ImageData(buffer as Uint8ClampedArray<ArrayBuffer>, cols, rows), 0, 0);
  }, [colorValues, min, max, variable.color, cols, rows, diffs]);

  function coordsFromEvent(e: React.MouseEvent<HTMLCanvasElement>): { row: number; col: number; idx: number } | null {
    const rect = e.currentTarget.getBoundingClientRect();
    const col = Math.floor(((e.clientX - rect.left) / rect.width) * cols);
    const row = Math.floor(((e.clientY - rect.top) / rect.height) * rows);
    if (col < 0 || col >= cols || row < 0 || row >= rows) return null;
    const idx = row * cols + col;
    if (idx >= values.length) return null;
    return { row, col, idx };
  }

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const hit = coordsFromEvent(e);
    if (!hit) return;
    setLocalHoverIdx(hit.idx);
    const coords = flatIndexToCoords(hit.idx, shape);
    const traceId = makeTraceId(variable.name, coords);
    const chunkId = chunkIdForElement(variable.name, coords, chunkShape, interleaving);
    setHover(traceId, chunkId, paneId);
  }

  function handleMouseLeave() {
    setLocalHoverIdx(null);
    clearHover();
  }

  // Cross-pane scroll: bring the hovered row into view when the hover
  // originated in the other pane and belongs to this variable.
  useEffect(() => {
    if (!hoveredTraceId || hoverSource === paneId || !containerRef.current) return;
    const parsed = parseTraceId(hoveredTraceId);
    if (parsed.kind !== 'value' || parsed.coords.length === 0) return;
    if (parsed.variableName !== variable.name) return;
    const parts = parsed.coords;
    if (parts.some((n) => Number.isNaN(n))) return;
    let idx = 0;
    for (let d = 0; d < parts.length; d++) idx = idx * (shape[d] ?? 1) + parts[d];
    const row = Math.floor(idx / cols);
    const viewport = containerRef.current;
    const cellTop = row * scale;
    const cellBottom = cellTop + scale;
    if (cellTop < viewport.scrollTop || cellBottom > viewport.scrollTop + viewport.clientHeight) {
      // Not fully visible: CENTER the target row (nearest-edge scrolling
      // parked it at the extreme top/bottom). The browser clamps scrollTop
      // assignments to the valid range, so no explicit clamping needed.
      viewport.scrollTop = cellTop - (viewport.clientHeight - scale) / 2;
    }
  }, [hoveredTraceId, hoverSource, paneId, variable.name, shape, cols, scale]);

  // Local hover element (this pane's own mouse position) plus the
  // cross-pane hover (when it's this pane that must show the overlay).
  const overlay = useMemo(() => {
    // Prefer the locally-hovered element (this pane owns the mouse).
    if (hoverSource === paneId && localHoverIdx !== null) {
      const row = Math.floor(localHoverIdx / cols);
      const col = localHoverIdx % cols;
      return { kind: 'value' as const, row, col };
    }
    if (!hoveredTraceId && !hoveredChunkId) return null;
    if (hoveredTraceId) {
      const parsed = parseTraceId(hoveredTraceId);
      if (parsed.kind === 'value' && parsed.variableName === variable.name && parsed.coords.length > 0) {
        const coords = parsed.coords;
        if (!coords.some((n) => Number.isNaN(n))) {
          let idx = 0;
          for (let d = 0; d < coords.length; d++) idx = idx * (shape[d] ?? 1) + coords[d];
          return { kind: 'value' as const, row: Math.floor(idx / cols), col: idx % cols };
        }
      }
    }
    if (hoveredChunkId) {
      const chunkCoords = parseChunkCoords(hoveredChunkId);
      if (chunkCoords && chunkCoords.length > 0) {
        // Only draw the chunk-bounds rect when the chunk membership check
        // agrees this variable/coords combo actually falls in that chunk —
        // reuse elementInChunk on the chunk's own origin element.
        const origin = chunkCoords.map((cc, d) => cc * (chunkShape[d] ?? 1));
        if (origin.length >= 1 && elementInChunk(hoveredChunkId, variable.name, origin, chunkShape)) {
          return { kind: 'chunk' as const, chunkCoords };
        }
      }
    }
    return null;
  }, [hoverSource, paneId, localHoverIdx, hoveredTraceId, hoveredChunkId, variable.name, shape, cols, chunkShape]);

  // Pixel bounds (in source-element units, pre-scale) of a chunk's
  // intersection with the 2D grid, from its chunk coords. The grid always
  // has exactly 2 axes (row, col) regardless of the dataset's own
  // dimensionality — flatIndexToCoords/shape define coords, but this view
  // only ever maps them onto a row-major rows*cols raster (see GridView's
  // `rows`/`cols` derivation: shape[0]/shape[1], or shape[0]/1 for 1D). The
  // chunk's row-chunk coordinate is chunkCoords[0]; its col-chunk coordinate
  // is chunkCoords' last entry (both are the same index in the common 2D
  // case; 1D data has a single chunk-coord axis mapped onto cols with the
  // row axis pinned to chunk 0).
  function chunkPixelBounds(chunkCoords: number[]) {
    const rowChunkSize = shape.length >= 2 ? (chunkShape[0] ?? rows) : rows;
    const colChunkSize = shape.length >= 2 ? (chunkShape[chunkShape.length - 1] ?? cols) : (chunkShape[0] ?? cols);
    const rowChunkCoord = shape.length >= 2 ? (chunkCoords[0] ?? 0) : 0;
    const colChunkCoord = shape.length >= 2 ? (chunkCoords[chunkCoords.length - 1] ?? 0) : (chunkCoords[0] ?? 0);
    const top = rowChunkCoord * rowChunkSize;
    const left = colChunkCoord * colChunkSize;
    const height = Math.min(rowChunkSize, rows - top);
    const width = Math.min(colChunkSize, cols - left);
    return { top, left, width, height };
  }

  // Status line content (canvas has no per-cell title).
  const statusText = useMemo(() => {
    if (localHoverIdx === null) return null;
    const row = Math.floor(localHoverIdx / cols);
    const col = localHoverIdx % cols;
    const val = values[localHoverIdx];
    const isDiffActive = diffs && diffs.diffActive[localHoverIdx] && typeof val === 'number';
    if (isDiffActive) {
      const diff = diffs.diffs[localHoverIdx];
      // Mirrors GridView.tsx's diff tooltip copy; origVal isn't separately
      // available here, so it's recovered from val - diff.
      const origVal = (val as number) - diff;
      return `Original: ${formatLogicalValue(origVal)}, Reconstructed: ${formatLogicalValue(val)}, Δ = ${(diff >= 0 ? '+' : '') + diff.toPrecision(4)}`;
    }
    return `${variable.name}[${rows <= 1 ? col : `${row},${col}`}] = ${formatLogicalValue(val)}`;
  }, [localHoverIdx, cols, rows, values, diffs, variable.name]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div
        ref={containerRef}
        style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', position: 'relative', padding: spacing.sm }}
      >
        <div style={{ position: 'relative', width: '100%' }}>
          <canvas
            ref={canvasRef}
            width={cols}
            height={rows}
            data-testid="grid-canvas"
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            style={{
              width: '100%',
              height: 'auto',
              display: 'block',
              imageRendering: 'pixelated',
              cursor: 'default',
            }}
          />
          {overlay && overlay.kind === 'value' && (
            <div
              style={{
                position: 'absolute',
                left: overlay.col * scale,
                top: overlay.row * scale,
                width: scale,
                height: scale,
                outline: `2px solid ${colors.textPrimary}`,
                outlineOffset: -1,
                pointerEvents: 'none',
              }}
            />
          )}
          {overlay && overlay.kind === 'chunk' && (() => {
            const b = chunkPixelBounds(overlay.chunkCoords);
            return (
              <div
                style={{
                  position: 'absolute',
                  left: b.left * scale,
                  top: b.top * scale,
                  width: b.width * scale,
                  height: b.height * scale,
                  outline: '1px solid var(--chunk-outline)',
                  outlineOffset: -1,
                  pointerEvents: 'none',
                }}
              />
            );
          })()}
        </div>
      </div>
      <div
        data-testid="grid-canvas-status"
        style={{
          padding: `${spacing.xs}px ${spacing.sm}px`,
          fontSize: fontSizes.xs,
          fontFamily: fonts.mono,
          color: colors.textSecondary,
          borderTop: `1px solid ${colors.borderSubtle}`,
          flexShrink: 0,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {statusText ?? ' '}
      </div>
    </div>
  );
}
