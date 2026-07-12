import { describe, it, expect } from 'vitest';
import {
  LINEARIZATION_ORDERS,
  orderIndexOf,
  orderCoordsOf,
  orderPermutation,
  mortonKey,
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

describe('morton key overflow safety (32+ total interleaved bits)', () => {
  // Reviewer repro: 16 dims of size 3 → per-dim width 2, total 32 interleaved
  // bits. JS bitwise ops coerce to 32-bit signed ints, so the old
  // `key |= b << keyBit` implementation went negative at key bit 31 and
  // silently broke the spatial ordering. The smallest dims that trigger this
  // produce 3^16 ≈ 43M elements — too large to pin via a full permutation
  // build in the unit suite — so these tests pin the key arithmetic directly.
  // Key layout per the pinned convention: the round for coordinate bit 0
  // assigns key bits 0..15 (last dim first), the round for coordinate bit 1
  // assigns key bits 16..31.
  const dims16x3 = Array(16).fill(3) as number[];

  it('all-zero coordinate has key 0 (maps to Morton index 0)', () => {
    expect(mortonKey(Array(16).fill(0), dims16x3)).toBe(0);
  });

  it('first few Morton keys are sane (dense prefix from the last dims)', () => {
    const at = (d: number, v: number) => {
      const c = Array(16).fill(0);
      c[d] = v;
      return c;
    };
    expect(mortonKey(at(15, 1), dims16x3)).toBe(1);
    expect(mortonKey(at(14, 1), dims16x3)).toBe(2);
    const both = at(15, 1);
    both[14] = 1;
    expect(mortonKey(both, dims16x3)).toBe(3);
  });

  it('key bit 31 stays positive (old bitwise code returned negative here)', () => {
    // coords[0] = 2 → bit 1 of dim 0 → key bit 31 → 2^31, not -2^31
    const coords = Array(16).fill(0);
    coords[0] = 2;
    expect(mortonKey(coords, dims16x3)).toBe(2 ** 31);
  });

  it('all-max coordinate uses the full 32-bit key exactly', () => {
    // coord 2 = binary 10 per dim: bit 1 of every dim → key bits 16..31 set
    expect(mortonKey(Array(16).fill(2), dims16x3)).toBe(0xffff0000);
  });

  it('keys are exact through the full 53-bit ceiling', () => {
    // 53 dims of size 2 → width 1 each, total 53 bits; all-1 coords set
    // every key bit → 2^53 - 1 === Number.MAX_SAFE_INTEGER, exactly.
    const dims = Array(53).fill(2) as number[];
    expect(mortonKey(Array(53).fill(1), dims)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('throws a named error above 53 total interleaved bits', () => {
    const dims = Array(54).fill(2) as number[];
    expect(() => orderPermutation(dims, 'morton')).toThrow(
      /morton order supports up to 53 total interleaved bits/,
    );
    expect(() => orderIndexOf(Array(54).fill(0), dims, 'morton')).toThrow(
      /53 total interleaved bits/,
    );
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
