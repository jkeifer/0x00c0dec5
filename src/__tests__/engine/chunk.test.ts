import { describe, it, expect } from 'vitest';
import {
  computeChunkGrid,
  computeChunkCount,
  enumerateChunkCoords,
  chunkData,
  coordsToFlatIndex,
  flatIndexToCoords,
} from '../../engine/chunk.ts';
import type { Variable } from '../../types/state.ts';

describe('computeChunkGrid', () => {
  it('computes grid for evenly divisible shape', () => {
    expect(computeChunkGrid([100], [10])).toEqual([10]);
  });

  it('computes grid for non-divisible shape (rounds up)', () => {
    expect(computeChunkGrid([10], [3])).toEqual([4]);
  });

  it('computes grid for 2-d shape', () => {
    expect(computeChunkGrid([100, 200], [50, 100])).toEqual([2, 2]);
  });

  it('handles chunk shape equal to data shape (single chunk)', () => {
    expect(computeChunkGrid([32], [32])).toEqual([1]);
  });

  it('clamps chunk shape larger than data shape', () => {
    expect(computeChunkGrid([10], [100])).toEqual([1]);
  });
});

describe('computeChunkCount', () => {
  it('computes total chunks for 1-d', () => {
    expect(computeChunkCount([100], [10])).toBe(10);
  });

  it('computes total chunks for 2-d', () => {
    expect(computeChunkCount([100, 200], [50, 100])).toBe(4);
  });

  it('returns 1 for single chunk', () => {
    expect(computeChunkCount([32], [32])).toBe(1);
  });
});

describe('enumerateChunkCoords', () => {
  it('enumerates 1-d chunk coords', () => {
    const coords = enumerateChunkCoords([3]);
    expect(coords).toEqual([[0], [1], [2]]);
  });

  it('enumerates 2-d chunk coords in row-major order', () => {
    const coords = enumerateChunkCoords([2, 3]);
    expect(coords).toEqual([
      [0, 0], [0, 1], [0, 2],
      [1, 0], [1, 1], [1, 2],
    ]);
  });
});

describe('coordsToFlatIndex / flatIndexToCoords roundtrip', () => {
  it('roundtrips 1-d coordinates', () => {
    const shape = [5];
    for (let i = 0; i < 5; i++) {
      const coords = flatIndexToCoords(i, shape);
      expect(coordsToFlatIndex(coords, shape)).toBe(i);
    }
  });

  it('roundtrips 2-d coordinates', () => {
    const shape = [3, 4];
    for (let i = 0; i < 12; i++) {
      const coords = flatIndexToCoords(i, shape);
      expect(coordsToFlatIndex(coords, shape)).toBe(i);
    }
  });

  it('roundtrips 3-d coordinates', () => {
    const shape = [2, 3, 4];
    for (let i = 0; i < 24; i++) {
      const coords = flatIndexToCoords(i, shape);
      expect(coordsToFlatIndex(coords, shape)).toBe(i);
    }
  });
});

describe('chunkData', () => {
  const variables: Variable[] = [
    { id: 'a', name: 'a', dtype: 'float32', color: '#f00' },
    { id: 'b', name: 'b', dtype: 'uint8', color: '#0f0' },
  ];

  it('produces a single chunk when chunkShape equals shape', () => {
    const values = new Map<string, number[]>();
    values.set('a', [1, 2, 3, 4]);
    values.set('b', [10, 20, 30, 40]);

    const chunks = chunkData([4], [4], variables, values);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].variables[0].values).toEqual([1, 2, 3, 4]);
    expect(chunks[0].variables[1].values).toEqual([10, 20, 30, 40]);
  });

  it('preserves all values across chunks (no loss, no duplication)', () => {
    const allValues = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const values = new Map<string, number[]>();
    values.set('a', allValues);
    values.set('b', allValues.map((v) => v * 10));

    const singleVar: Variable[] = [variables[0]];
    const chunks = chunkData([10], [3], singleVar, values);

    const collected = chunks.flatMap((c) => c.variables[0].values);
    expect(collected).toEqual(allValues);
  });

  it('handles non-divisible shapes correctly', () => {
    const values = new Map<string, number[]>();
    values.set('a', [1, 2, 3, 4, 5]);
    values.set('b', [10, 20, 30, 40, 50]);

    const chunks = chunkData([5], [2], variables, values);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].variables[0].values).toEqual([1, 2]);
    expect(chunks[1].variables[0].values).toEqual([3, 4]);
    expect(chunks[2].variables[0].values).toEqual([5]);
  });

  it('handles 2-d chunking', () => {
    // 4x4 data, chunk shape 2x2 → 4 chunks
    const shape = [4, 4];
    const chunkShape = [2, 2];
    const data = Array.from({ length: 16 }, (_, i) => i);

    const singleVar: Variable[] = [{ id: 'x', name: 'x', dtype: 'int32', color: '#f00' }];
    const values = new Map<string, number[]>();
    values.set('x', data);

    const chunks = chunkData(shape, chunkShape, singleVar, values);
    expect(chunks).toHaveLength(4);

    // Chunk [0,0] should contain top-left 2x2
    expect(chunks[0].variables[0].values).toEqual([0, 1, 4, 5]);
    // Chunk [0,1] should contain top-right 2x2
    expect(chunks[1].variables[0].values).toEqual([2, 3, 6, 7]);
    // Chunk [1,0] should contain bottom-left 2x2
    expect(chunks[2].variables[0].values).toEqual([8, 9, 12, 13]);
    // Chunk [1,1] should contain bottom-right 2x2
    expect(chunks[3].variables[0].values).toEqual([10, 11, 14, 15]);
  });

  it('clamps chunk shape to data shape', () => {
    const values = new Map<string, number[]>();
    values.set('a', [1, 2, 3]);
    values.set('b', [4, 5, 6]);

    const chunks = chunkData([3], [100], variables, values);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].variables[0].values).toEqual([1, 2, 3]);
  });

  it('tracks source coordinates', () => {
    const values = new Map<string, number[]>();
    values.set('a', [10, 20, 30, 40]);
    values.set('b', [1, 2, 3, 4]);

    const chunks = chunkData([4], [2], variables, values);
    expect(chunks[0].variables[0].sourceCoords).toEqual([[0], [1]]);
    expect(chunks[1].variables[0].sourceCoords).toEqual([[2], [3]]);
  });
});
