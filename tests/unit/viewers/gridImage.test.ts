import { describe, it, expect } from 'vitest';
import { valueToColor, valueToRGB, diffToColor, diffToRGB, buildGridImage, stretchRange } from '../../../src/components/viewers/gridImage.ts';

describe('color ramp parity', () => {
  it('valueToRGB matches valueToColor string output', () => {
    for (const v of [0, 0.25, 5, 9.99, 10]) {
      const [r, g, b] = valueToRGB(v, 0, 10, '#e06c75');
      expect(valueToColor(v, 0, 10, '#e06c75')).toBe(`rgb(${r},${g},${b})`);
    }
  });
  it('diffToRGB matches diffToColor, both signs and zero maxAbsDiff', () => {
    for (const d of [-3, 0, 3]) {
      const [r, g, b] = diffToRGB(d, 3);
      expect(diffToColor(d, 3)).toBe(`rgb(${r},${g},${b})`);
    }
    expect(diffToColor(1, 0)).toBe('rgb(40,40,40)');
  });
  it('min === max returns literal baseColor hex string', () => {
    expect(valueToColor(7, 7, 7, '#61afef')).toBe('#61afef');
  });
});

describe('buildGridImage', () => {
  it('fills one RGBA px per element, row-major, transparent past end', () => {
    const img = buildGridImage({ colorValues: [0, 5, 10], min: 0, max: 10, baseColor: '#ffffff', width: 2, height: 2 });
    expect(img.length).toBe(2 * 2 * 4);
    expect([img[0], img[1], img[2], img[3]]).toEqual([20, 20, 20, 255]); // min -> dark base
    expect([img[8], img[9], img[10], img[11]]).toEqual([255, 255, 255, 255]); // max -> full color
    expect(img[15]).toBe(0); // 4th px: no element -> alpha 0
  });
  it('min === max renders the base color (single-value degenerate)', () => {
    const img = buildGridImage({ colorValues: [7, 7], min: 7, max: 7, baseColor: '#61afef', width: 2, height: 1 });
    expect([img[0], img[1], img[2]]).toEqual([0x61, 0xaf, 0xef]);
  });
  it('t is clamped to [0,1]: values outside a clipped [min,max] saturate at the end colors', () => {
    const belowRange = valueToRGB(-100, 0, 10, '#e06c75');
    const atMin = valueToRGB(0, 0, 10, '#e06c75');
    expect(belowRange).toEqual(atMin);
    const aboveRange = valueToRGB(1000, 0, 10, '#e06c75');
    const atMax = valueToRGB(10, 0, 10, '#e06c75');
    expect(aboveRange).toEqual(atMax);
  });
});

describe('stretchRange', () => {
  it('minmax passes through the absolute extent unchanged', () => {
    const values = [1, 2, 3, 4, 100];
    expect(stretchRange(values, 'minmax')).toEqual({ min: 1, max: 100 });
  });

  it('percentile clips outliers: bounds land near the 2nd/98th percentile, not the absolute extent', () => {
    // 1000 values uniformly 0..999, plus a couple of wild outliers.
    const values: number[] = [];
    for (let i = 0; i < 1000; i++) values.push(i);
    values.push(-1_000_000, 1_000_000);
    const { min, max } = stretchRange(values, 'percentile');
    // Absolute extent is [-1e6, 1e6]; the stretch should exclude it.
    expect(min).toBeGreaterThan(-1000);
    expect(max).toBeLessThan(2000);
    // Should land in the neighborhood of the 2nd/98th percentile of 0..999
    // (~20 and ~980), within one histogram-bucket's worth of slack.
    expect(min).toBeGreaterThanOrEqual(0);
    expect(min).toBeLessThan(100);
    expect(max).toBeGreaterThan(900);
    expect(max).toBeLessThanOrEqual(1_000_000);
  });

  it('skips NaN in both the extent pass and the histogram pass', () => {
    const values = [NaN, 0, 10, 20, NaN, 30, 40, NaN];
    const minmax = stretchRange(values, 'minmax');
    expect(minmax).toEqual({ min: 0, max: 40 });
    const pct = stretchRange(values, 'percentile');
    expect(Number.isFinite(pct.min)).toBe(true);
    expect(Number.isFinite(pct.max)).toBe(true);
  });

  it('skips +/-Infinity in both passes', () => {
    const values = [-Infinity, 1, 2, 3, Infinity];
    expect(stretchRange(values, 'minmax')).toEqual({ min: 1, max: 3 });
    const pct = stretchRange(values, 'percentile');
    expect(Number.isFinite(pct.min)).toBe(true);
    expect(Number.isFinite(pct.max)).toBe(true);
  });

  it('all-equal values return min === max (consistent with valueToColor baseColor fallback)', () => {
    expect(stretchRange([5, 5, 5, 5], 'minmax')).toEqual({ min: 5, max: 5 });
    expect(stretchRange([5, 5, 5, 5], 'percentile')).toEqual({ min: 5, max: 5 });
  });

  it('empty input returns a non-finite degenerate range for both modes', () => {
    expect(stretchRange([], 'minmax')).toEqual({ min: Infinity, max: -Infinity });
    expect(stretchRange([], 'percentile')).toEqual({ min: Infinity, max: -Infinity });
  });

  it('all-NaN input returns a non-finite degenerate range', () => {
    const values = [NaN, NaN, NaN];
    expect(stretchRange(values, 'minmax')).toEqual({ min: Infinity, max: -Infinity });
    expect(stretchRange(values, 'percentile')).toEqual({ min: Infinity, max: -Infinity });
  });
});
