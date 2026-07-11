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
