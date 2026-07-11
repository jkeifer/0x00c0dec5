import { useEffect, useRef } from 'react';
import type { StageLayout } from '../../engine/layout.ts';
import { useContainerWidth } from '../../hooks/useContainerWidth.ts';
import { colors } from '../../theme.ts';
import { fileMapColors, fileMapByteAt } from './fileMap.ts';

const STRIP_HEIGHT = 16;

interface FileMapStripProps {
  layout: StageLayout;
  /** Byte range currently visible in the windowed hex view. */
  windowStart: number;
  windowEnd: number;
  onJump: (byteOffset: number) => void;
}

/** Canvas navigation strip for a stage's byte layout: one pixel column per
 *  region-owned byte range (see fileMap.ts), with a translucent overlay
 *  marking the hex view's current window and click-to-jump. */
export function FileMapStrip({ layout, windowStart, windowEnd, onJump }: FileMapStripProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const width = useContainerWidth(containerRef);

  // Draw: build a 1px-tall color row from fileMapColors and stretch it to
  // the strip's full height via drawImage (cheaper than materializing a
  // width*16 ImageData by hand — the browser does the row repeat).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const colorRow = fileMapColors(layout, width);
    const rowCanvas = document.createElement('canvas');
    rowCanvas.width = width;
    rowCanvas.height = 1;
    const rowCtx = rowCanvas.getContext('2d');
    if (!rowCtx) return;
    rowCtx.putImageData(new ImageData(colorRow as Uint8ClampedArray<ArrayBuffer>, width, 1), 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(rowCanvas, 0, 0, width, STRIP_HEIGHT);
  }, [layout, width]);

  function handleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (width <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * width);
    onJump(fileMapByteAt(layout, width, x));
  }

  const byteLength = layout.byteLength;
  const overlayLeft = byteLength > 0 ? (windowStart / byteLength) * 100 : 0;
  const overlayWidth = byteLength > 0 ? ((windowEnd - windowStart) / byteLength) * 100 : 0;

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%', height: STRIP_HEIGHT }}>
      <canvas
        ref={canvasRef}
        width={width || 1}
        height={STRIP_HEIGHT}
        data-testid="hex-overview"
        onClick={handleClick}
        style={{ width: '100%', height: STRIP_HEIGHT, display: 'block', cursor: 'pointer' }}
      />
      {byteLength > 0 && (
        <div
          data-testid="hex-overview-window"
          style={{
            position: 'absolute',
            top: 0,
            left: `${overlayLeft}%`,
            width: `${overlayWidth}%`,
            height: STRIP_HEIGHT,
            background: colors.accent,
            opacity: 0.35,
            outline: `1px solid ${colors.accent}`,
            outlineOffset: -1,
            pointerEvents: 'none',
          }}
        />
      )}
    </div>
  );
}
