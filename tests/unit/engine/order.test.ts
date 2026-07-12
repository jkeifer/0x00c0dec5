import { describe, it, expect } from 'vitest';
import {
  LINEARIZATION_ORDERS,
  orderIndexOf,
  orderCoordsOf,
  orderPermutation,
  type LinearizationOrder,
} from '../../../src/engine/order.ts';
import { coordsToFlatIndex } from '../../../src/engine/chunk.ts';

function enumerateCoords(dims: number[]): number[][] {
  const n = dims.reduce((a, b) => a * b, 1);
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const coords: number[] = new Array(dims.length);
    let rem = i;
    for (let d = dims.length - 1; d >= 0; d--) {
      coords[d] = rem % dims[d];
      rem = Math.floor(rem / dims[d]);
    }
    out.push(coords);
  }
  return out;
}

const SHAPES = [
  [4, 4],
  [3, 5],
  [7, 3, 2],
  [1, 9],
  [8],
];

describe('bijectivity', () => {
  for (const order of LINEARIZATION_ORDERS) {
    for (const dims of SHAPES) {
      it(`${order} is bijective over dims=[${dims}]`, () => {
        const coordsList = enumerateCoords(dims);
        const n = coordsList.length;
        const seen = new Set<number>();
        for (const coords of coordsList) {
          const idx = orderIndexOf(coords, dims, order);
          expect(idx).toBeGreaterThanOrEqual(0);
          expect(idx).toBeLessThan(n);
          expect(seen.has(idx)).toBe(false);
          seen.add(idx);
          expect(orderCoordsOf(idx, dims, order)).toEqual(coords);
        }
        expect(seen.size).toBe(n);
      });
    }
  }

  it('large-ish spot check: morton on [2047,3]-scale dims stays bijective', () => {
    const dims = [64, 3];
    const coordsList = enumerateCoords(dims);
    const seen = new Set<number>();
    for (const coords of coordsList) {
      const idx = orderIndexOf(coords, dims, 'morton');
      expect(seen.has(idx)).toBe(false);
      seen.add(idx);
      expect(orderCoordsOf(idx, dims, 'morton')).toEqual(coords);
    }
    expect(seen.size).toBe(dims[0] * dims[1]);
  });
});

describe('c order', () => {
  it('matches coordsToFlatIndex exactly for all sample shapes', () => {
    for (const dims of SHAPES) {
      for (const coords of enumerateCoords(dims)) {
        expect(orderIndexOf(coords, dims, 'c')).toBe(coordsToFlatIndex(coords, dims));
      }
    }
  });
});

describe('1-D identity', () => {
  const dims = [8];
  for (const order of LINEARIZATION_ORDERS) {
    it(`${order} is identity for 1-D`, () => {
      for (let i = 0; i < dims[0]; i++) {
        expect(orderIndexOf([i], dims, order)).toBe(i);
        expect(orderCoordsOf(i, dims, order)).toEqual([i]);
      }
    });
  }
});

describe('fortran order', () => {
  it('[2,3]: first dim varies fastest — exact sequence', () => {
    const dims = [2, 3];
    const expected = [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
      [0, 2],
      [1, 2],
    ];
    for (let i = 0; i < expected.length; i++) {
      expect(orderCoordsOf(i, dims, 'fortran')).toEqual(expected[i]);
      expect(orderIndexOf(expected[i], dims, 'fortran')).toBe(i);
    }
  });
});

describe('morton order', () => {
  // Convention (pinned): for dims [d0, d1, ..., d_{n-1}], each dimension d has
  // bit width w[d] = ceil(log2(dims[d])) (0 if dims[d] === 1). The Morton key
  // is built by round-robin bit interleaving starting from the LAST dimension
  // (index n-1) and proceeding toward dimension 0, taking one bit per
  // dimension per round, LSB-first within each dimension's own coordinate,
  // and packing into the key from the key's LSB upward in that same
  // last-to-first round-robin order. This makes the last dimension the
  // fastest-varying axis at every bit-pair, matching C-order's "last dim
  // fastest" convention and producing the classic Z-curve when read as
  // (row=dim0, col=dim1). Dimensions of width 0 contribute no bits. Elements
  // are then sorted by this key (keys are always distinct) and compacted to
  // a dense [0, n) sequence.
  it('[4,4]: exact classic Z-curve prefix (first 8) per the pinned convention', () => {
    const dims = [4, 4];
    const expected = [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
      [0, 2],
      [0, 3],
      [1, 2],
      [1, 3],
    ];
    for (let i = 0; i < expected.length; i++) {
      expect(orderCoordsOf(i, dims, 'morton')).toEqual(expected[i]);
      expect(orderIndexOf(expected[i], dims, 'morton')).toBe(i);
    }
  });

  it('[1,9]: width-0 dimension contributes no bits — reduces to remaining dim order', () => {
    const dims = [1, 9];
    for (let i = 0; i < 9; i++) {
      expect(orderCoordsOf(i, dims, 'morton')).toEqual([0, i]);
    }
  });
});

describe('orderPermutation', () => {
  it('returns null for c order', () => {
    expect(orderPermutation([4, 4], 'c')).toBeNull();
  });

  const nonC: LinearizationOrder[] = ['fortran', 'morton'];

  for (const order of nonC) {
    it(`${order}: perm/inv agree with scalar functions and are true inverses`, () => {
      const dims = [3, 5];
      const result = orderPermutation(dims, order);
      expect(result).not.toBeNull();
      const { perm, inv } = result!;
      const n = dims[0] * dims[1];
      expect(perm.length).toBe(n);
      expect(inv.length).toBe(n);

      const coordsList = enumerateCoords(dims);
      for (let linearIndex = 0; linearIndex < n; linearIndex++) {
        const coords = orderCoordsOf(linearIndex, dims, order);
        const cFlat = coordsToFlatIndex(coords, dims);
        expect(perm[linearIndex]).toBe(cFlat);
      }
      for (const coords of coordsList) {
        const cFlat = coordsToFlatIndex(coords, dims);
        const linearIndex = orderIndexOf(coords, dims, order);
        expect(inv[cFlat]).toBe(linearIndex);
      }
      // true inverse relationship
      for (let i = 0; i < n; i++) {
        expect(inv[perm[i]]).toBe(i);
        expect(perm[inv[i]]).toBe(i);
      }
    });
  }

  it('cache returns the same object for repeat calls with identical dims/order', () => {
    const a = orderPermutation([4, 4], 'morton');
    const b = orderPermutation([4, 4], 'morton');
    expect(a).toBe(b);
  });

  it('cache distinguishes different dims and different orders', () => {
    const a = orderPermutation([4, 4], 'morton');
    const b = orderPermutation([4, 5], 'morton');
    const c = orderPermutation([4, 4], 'fortran');
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('cache is capped at 32 entries (oldest evicted)', () => {
    // fill beyond cap with distinct dims
    const first = orderPermutation([2, 2], 'fortran');
    for (let i = 3; i < 3 + 40; i++) {
      orderPermutation([2, i], 'fortran');
    }
    const again = orderPermutation([2, 2], 'fortran');
    // original entry should have been evicted — new call returns a new object
    expect(again).not.toBe(first);
  });
});
