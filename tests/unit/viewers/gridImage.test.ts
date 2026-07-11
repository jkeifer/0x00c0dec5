import { describe, it, expect } from 'vitest';
import { valueToColor, valueToRGB, diffToColor, diffToRGB, buildGridImage } from '../../../src/components/viewers/gridImage.ts';

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
});
