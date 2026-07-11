import type { StageLayout } from '../../engine/layout.ts';
import { regionAt } from '../../engine/layout.ts';

// ponytail: canvas pixels need raw RGB numbers, not the CSS-var tokens in
// theme.ts (those resolve in the DOM, not an ImageData buffer) — literal
// hex here mirrors gridImage.ts's own literal fallback ([40, 40, 40]).
const MAGIC_GRAY: [number, number, number] = [220, 220, 220]; // bright
const METADATA_GRAY: [number, number, number] = [130, 130, 130]; // mid
const STRUCTURAL_GRAY: [number, number, number] = [90, 90, 90]; // other structural (e.g. chunk index)
const NEUTRAL_ALT: [[number, number, number], [number, number, number]] = [
  [70, 70, 70],
  [100, 100, 100],
];

function hexToRGB(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/** Color for the region owning a byte, keyed by region index for the
 *  fallback alternating grays (values/chunk regions with no variableColor,
 *  e.g. shared multi-variable chunks). */
function colorForRegion(layout: StageLayout, regionIndex: number): [number, number, number] {
  const r = layout.regions[regionIndex];
  if (r.kind === 'values' || r.kind === 'chunk') {
    if (r.variableColor) return hexToRGB(r.variableColor);
    return NEUTRAL_ALT[regionIndex % 2];
  }
  // structural
  if (r.traceId === 'magic:start' || r.traceId === 'magic:end') return MAGIC_GRAY;
  if (r.traceId === 'metadata') return METADATA_GRAY;
  return STRUCTURAL_GRAY;
}

/** The byte a strip column samples: the byte under the column's center.
 * This is the single sampling rule for the strip — fileMapColors renders
 * column x with this byte's region color, and fileMapByteAt returns this
 * same byte for a click on column x, so a click always jumps to the byte
 * whose color the user saw. (Note: the naive round-trip identity
 * floor(byte/byteLength*width) === x is deliberately NOT the contract —
 * that expression finds the column containing a byte's left edge, which
 * differs from center sampling whenever byteLength/width isn't integral.) */
export function columnByte(byteLength: number, width: number, x: number): number {
  if (byteLength === 0) return 0;
  const byte = Math.floor(((x + 0.5) / width) * byteLength);
  return Math.max(0, Math.min(byteLength - 1, byte));
}

/** One RGBA px-column per horizontal pixel: each column colored by the
 *  region owning the byte at that column's center (columnByte). values/chunk
 *  regions -> the region's variableColor (fallback: alternate neutral grays
 *  when variableColor is ''); structural regions -> fixed distinct grays
 *  (magic bright, metadata mid). Returns width*4 RGBA; empty layout -> fully
 *  transparent. */
export function fileMapColors(layout: StageLayout, width: number): Uint8ClampedArray {
  const buffer = new Uint8ClampedArray(width * 4);
  if (layout.byteLength === 0 || layout.regions.length === 0) return buffer;

  for (let x = 0; x < width; x++) {
    const byteIndex = columnByte(layout.byteLength, width, x);
    const region = regionAt(layout, byteIndex);
    const o = x * 4;
    if (!region) continue; // leave transparent (shouldn't happen for a contiguous layout)
    const regionIndex = layout.regions.indexOf(region);
    const [r, g, b] = colorForRegion(layout, regionIndex);
    buffer[o] = r;
    buffer[o + 1] = g;
    buffer[o + 2] = b;
    buffer[o + 3] = 255;
  }
  return buffer;
}

/** Byte offset at pixel x: the same center-sampled byte fileMapColors used
 *  to color column x (columnByte). 0 for empty layouts. */
export function fileMapByteAt(layout: StageLayout, width: number, x: number): number {
  return columnByte(layout.byteLength, width, x);
}
