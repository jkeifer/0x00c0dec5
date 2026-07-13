export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function diffToRGB(diff: number, maxAbsDiff: number): [number, number, number] {
  if (maxAbsDiff === 0) return [40, 40, 40];
  const t = Math.max(-1, Math.min(1, diff / maxAbsDiff));
  // Diverging: negative = blue, zero = neutral gray, positive = red
  if (t >= 0) {
    const r = Math.round(lerp(40, 224, t));
    const g = Math.round(lerp(40, 108, t));
    const b = Math.round(lerp(40, 117, t));
    return [r, g, b];
  } else {
    const at = -t;
    const r = Math.round(lerp(40, 97, at));
    const g = Math.round(lerp(40, 175, at));
    const b = Math.round(lerp(40, 239, at));
    return [r, g, b];
  }
}

export function diffToColor(diff: number, maxAbsDiff: number): string {
  const [r, g, b] = diffToRGB(diff, maxAbsDiff);
  return `rgb(${r},${g},${b})`;
}

// ponytail: heatmap fills stay dark-based in both themes — the lerp math needs
// literal hex (Variable.color), and a dark-to-color ramp reads fine on a light
// page. Add a light ramp only if a real complaint surfaces.
export function valueToRGB(value: number, min: number, max: number, baseColor: string): [number, number, number] {
  if (min === max) {
    const r = parseInt(baseColor.slice(1, 3), 16);
    const g = parseInt(baseColor.slice(3, 5), 16);
    const b = parseInt(baseColor.slice(5, 7), 16);
    return [r, g, b];
  }
  const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
  // Blend from dark to the variable color based on intensity
  const r = parseInt(baseColor.slice(1, 3), 16);
  const g = parseInt(baseColor.slice(3, 5), 16);
  const b = parseInt(baseColor.slice(5, 7), 16);
  const outR = Math.round(lerp(20, r, t));
  const outG = Math.round(lerp(20, g, t));
  const outB = Math.round(lerp(20, b, t));
  return [outR, outG, outB];
}

export function valueToColor(value: number, min: number, max: number, baseColor: string): string {
  if (min === max) return baseColor;
  const [r, g, b] = valueToRGB(value, min, max, baseColor);
  return `rgb(${r},${g},${b})`;
}

/**
 * Compute the {min, max} color-ramp range for a numeric value array, either
 * as the plain absolute extent ('minmax') or clipped to the 2nd–98th
 * percentile ('percentile') so a small number of outliers (e.g. an ocean
 * trench in a DEM) doesn't compress the rest of the ramp to near-uniform.
 *
 * 'percentile' does NOT sort the input (that's O(n log n) and needless for
 * an approximate stretch): it makes one pass for the absolute min/max, bins
 * values into a 1024-bucket histogram in a second pass, then walks the
 * cumulative counts to find the buckets holding the 2% and 98% marks. The
 * result is the *edge* of those buckets, not the exact percentile value —
 * an approximation of bounded error (one bucket width, i.e. range/1024) that
 * is more than good enough for a color ramp.
 *
 * NaN and ±Infinity are skipped in both passes so a single bad value can't
 * poison the histogram or the range.
 */
export function stretchRange(values: ArrayLike<number>, mode: 'minmax' | 'percentile'): { min: number; max: number } {
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  // Degenerate: empty, all-NaN/Infinity, or a single distinct value. Fall
  // back to the same {min, max} valueToColor already special-cases (min ===
  // max renders literal baseColor).
  if (!Number.isFinite(mn) || !Number.isFinite(mx) || mn === mx) {
    return { min: mn, max: mx };
  }
  if (mode === 'minmax') return { min: mn, max: mx };

  const BINS = 1024;
  const counts = new Uint32Array(BINS);
  const range = mx - mn;
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    let bin = Math.floor(((v - mn) / range) * BINS);
    if (bin >= BINS) bin = BINS - 1;
    if (bin < 0) bin = 0;
    counts[bin]++;
    total++;
  }

  const lowTarget = total * 0.02;
  const highTarget = total * 0.98;
  let cum = 0;
  let loBin = 0;
  let hiBin = BINS - 1;
  for (let b = 0; b < BINS; b++) {
    cum += counts[b];
    if (cum >= lowTarget) { loBin = b; break; }
  }
  cum = 0;
  for (let b = 0; b < BINS; b++) {
    cum += counts[b];
    if (cum >= highTarget) { hiBin = b; break; }
  }
  const stretchedMin = mn + (loBin / BINS) * range;
  const stretchedMax = mn + ((hiBin + 1) / BINS) * range;
  // A near-uniform distribution can land both bounds in the same bucket —
  // fall back to the absolute extent rather than a zero-width range.
  if (stretchedMin >= stretchedMax) return { min: mn, max: mx };
  return { min: stretchedMin, max: stretchedMax };
}

export function buildGridImage(opts: {
  colorValues: ArrayLike<number>;
  min: number; max: number; baseColor: string;
  width: number; height: number;
  diffs?: Float64Array; diffActive?: Uint8Array; maxAbsDiff?: number;
}): Uint8ClampedArray {
  const { colorValues, min, max, baseColor, width, height, diffs, diffActive, maxAbsDiff } = opts;
  const totalPixels = width * height;
  const buffer = new Uint8ClampedArray(totalPixels * 4);

  for (let i = 0; i < totalPixels; i++) {
    const offset = i * 4;

    if (i < colorValues.length) {
      let r: number, g: number, b: number;

      // Use diff mode if diffs provided and this pixel is active
      if (diffs && diffActive && maxAbsDiff !== undefined && diffActive[i]) {
        [r, g, b] = diffToRGB(diffs[i], maxAbsDiff);
      } else {
        [r, g, b] = valueToRGB(colorValues[i], min, max, baseColor);
      }

      buffer[offset] = r;
      buffer[offset + 1] = g;
      buffer[offset + 2] = b;
      buffer[offset + 3] = 255; // alpha
    } else {
      // Past end: transparent
      buffer[offset] = 0;
      buffer[offset + 1] = 0;
      buffer[offset + 2] = 0;
      buffer[offset + 3] = 0;
    }
  }

  return buffer;
}
