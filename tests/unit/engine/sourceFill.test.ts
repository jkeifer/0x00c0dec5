import { describe, it, expect } from 'vitest';
import { fillFromSource } from '../../../src/engine/sourceFill.ts';

describe('fillFromSource', () => {
  it('exact fit: source matches schema shape exactly', () => {
    const source = new Float64Array([1, 2, 3, 4]);
    const result = fillFromSource(source, [2, 2], [2, 2]);
    expect(Array.from(result as Float64Array)).toEqual([1, 2, 3, 4]);
  });

  it('crop: source 4x4 cropped to schema 2x2 takes the top-left block', () => {
    const source = new Float64Array(Array.from({ length: 16 }, (_, i) => i));
    const result = fillFromSource(source, [4, 4], [2, 2]);
    expect(Array.from(result as Float64Array)).toEqual([0, 1, 4, 5]);
  });

  it('tile 1-D: source length 3 tiled to schema length 7', () => {
    const source = new Float64Array([7, 8, 9]);
    const result = fillFromSource(source, [3], [7]);
    expect(Array.from(result as Float64Array)).toEqual([7, 8, 9, 7, 8, 9, 7]);
  });

  it('tile 2-D: source 2x2 tiled to schema 3x3', () => {
    const source = new Float64Array([1, 2, 3, 4]); // a,b,c,d
    const result = fillFromSource(source, [2, 2], [3, 3]);
    expect(Array.from(result as Float64Array)).toEqual([
      1, 2, 1,
      3, 4, 3,
      1, 2, 1,
    ]);
  });

  it('broadcast leading dim: source 2x2 broadcast to schema 2x2x2', () => {
    const source = new Float64Array([1, 2, 3, 4]);
    const result = fillFromSource(source, [2, 2], [2, 2, 2]);
    expect(Array.from(result as Float64Array)).toEqual([1, 2, 3, 4, 1, 2, 3, 4]);
  });

  it('fewer schema dims: source 2x3 cropped down to schema [2] (row 0)', () => {
    const source = new Float64Array(Array.from({ length: 6 }, (_, i) => i));
    const result = fillFromSource(source, [2, 3], [2]);
    expect(Array.from(result as Float64Array)).toEqual([0, 1]);
  });

  it('text values: source of 2 strings tiled to schema length 5, stays a plain array', () => {
    const source = ['x', 'y'];
    const result = fillFromSource(source, [2], [5]);
    expect(Array.isArray(result)).toBe(true);
    expect(result as string[]).toEqual(['x', 'y', 'x', 'y', 'x']);
  });

  it('degenerate: schema with a zero dim returns empty output without throwing', () => {
    const source = new Float64Array([1, 2, 3, 4]);
    const result = fillFromSource(source, [2, 2], [0, 5]);
    expect(result.length).toBe(0);
  });

  it('length-mismatch guard: throws when source length != naturalShape product', () => {
    const source = new Float64Array([1, 2, 3]);
    expect(() => fillFromSource(source, [2, 2], [2, 2])).toThrow(
      /fillFromSource: source length 3 != natural shape product 4/,
    );
  });
});
