/**
 * Linearization order: the sequence in which N-D array elements (within a
 * chunk of shape `dims`) are visited when flattened to a 1-D element index.
 *
 * - 'c': row-major, last dimension fastest-varying. Identical to
 *   `chunk.ts`'s `coordsToFlatIndex`/`flatIndexToCoords`.
 * - 'fortran': column-major, first dimension fastest-varying.
 * - 'morton': Z-curve order via bit-interleaved coordinate keys, compacted
 *   to a dense [0, n) sequence. Convention (pinned — see below).
 *
 * For 1-D dims, all three orders are the identity.
 *
 * Morton convention: for dims [d0, d1, ..., d_{n-1}], each dimension d has
 * bit width w[d] = ceil(log2(dims[d])) (0 if dims[d] === 1, i.e. it
 * contributes no bits). The key is built by round-robin bit interleaving
 * starting from the LAST dimension (index n-1) and proceeding toward
 * dimension 0, taking one bit per dimension per round, LSB-first within
 * each dimension's own coordinate, and packing into the key from the key's
 * LSB upward in that same last-to-first round-robin order. This makes the
 * last dimension the fastest-varying axis at every bit-pair — matching
 * C-order's "last dim fastest" convention — and produces the classic
 * Z-curve when read as (row=dim0, col=dim1): (0,0),(0,1),(1,0),(1,1),...
 * Interleaved keys over non-power-of-two dims are never all distinct by
 * construction accident — they ARE always distinct (each element's coords
 * are a unique bit pattern, and the interleave is a bijection on bit
 * patterns) — so sorting elements by key and compacting to dense [0, n) is
 * total and bijective for arbitrary, including edge-clipped, dims.
 *
 * Ceiling: the total interleaved bit width (sum of per-dim widths) must be
 * ≤ 53. Keys are accumulated with plain arithmetic rather than JS bitwise
 * ops (which coerce to 32-bit signed ints and would silently corrupt keys
 * at ≥ 32 total bits — e.g. 16 dims of size 3), so they stay exact through
 * Float64's integer range; buildMortonPermutation throws a named Error
 * beyond 53 bits rather than corrupting silently. 53 total bits is far
 * beyond any realistic chunk (≥ 2^~42 elements at minimum).
 */

export type LinearizationOrder = 'c' | 'fortran' | 'morton';

export const LINEARIZATION_ORDERS: LinearizationOrder[] = ['c', 'fortran', 'morton'];

function bitWidth(n: number): number {
  // ceil(log2(n)), with n === 1 (and n <= 0, defensively) contributing 0 bits.
  if (n <= 1) return 0;
  return Math.ceil(Math.log2(n));
}

/**
 * Morton key for `coords` per the pinned convention above. Exported for
 * tests that pin the key arithmetic directly (the smallest dims that
 * overflow 32 bits produce ~43M elements — far too large to pin via a full
 * permutation build in the unit suite).
 *
 * Uses plain arithmetic, not bitwise ops: JS bitwise operators coerce to
 * 32-bit signed ints, which silently corrupts keys once the total
 * interleaved width reaches 32 bits (e.g. 16 dims of size 3). Arithmetic
 * keeps keys exact up to Float64's integer range — total interleaved width
 * ≤ 53 bits, guarded in buildMortonPermutation.
 */
export function mortonKey(coords: number[], dims: number[]): number {
  const ndim = dims.length;
  const widths = dims.map(bitWidth);
  const maxWidth = Math.max(0, ...widths);
  let key = 0;
  let placeValue = 1; // 2^keyBit
  for (let bit = 0; bit < maxWidth; bit++) {
    const coordBit = 2 ** bit;
    for (let d = ndim - 1; d >= 0; d--) {
      if (bit < widths[d]) {
        key += (Math.floor(coords[d] / coordBit) % 2) * placeValue;
        placeValue *= 2;
      }
    }
  }
  return key;
}

function cIndexOf(coords: number[], dims: number[]): number {
  let index = 0;
  for (let d = 0; d < dims.length; d++) {
    index = index * dims[d] + coords[d];
  }
  return index;
}

function cCoordsOf(index: number, dims: number[]): number[] {
  const coords: number[] = new Array(dims.length);
  let remaining = index;
  for (let d = dims.length - 1; d >= 0; d--) {
    coords[d] = remaining % dims[d];
    remaining = Math.floor(remaining / dims[d]);
  }
  return coords;
}

function fortranIndexOf(coords: number[], dims: number[]): number {
  let index = 0;
  for (let d = dims.length - 1; d >= 0; d--) {
    index = index * dims[d] + coords[d];
  }
  return index;
}

function fortranCoordsOf(index: number, dims: number[]): number[] {
  const coords: number[] = new Array(dims.length);
  let remaining = index;
  for (let d = 0; d < dims.length; d++) {
    coords[d] = remaining % dims[d];
    remaining = Math.floor(remaining / dims[d]);
  }
  return coords;
}

type Permutation = { perm: Uint32Array; inv: Uint32Array };

// ponytail: plain Map with insertion-order eviction covers the "cap at 32,
// chunk dims repeat" requirement; reach for an LRU lib only if access
// patterns stop being insertion-order-ish.
const PERMUTATION_CACHE_CAP = 32;
const permutationCache = new Map<string, Permutation>();

function buildMortonPermutation(dims: number[]): Permutation {
  const totalBits = dims.reduce((sum, d) => sum + bitWidth(d), 0);
  if (totalBits > 53) {
    throw new Error(
      `morton order supports up to 53 total interleaved bits; ` +
        `dims [${dims.join(', ')}] need ${totalBits}`,
    );
  }
  const n = dims.reduce((a, b) => a * b, 1);
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const keys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    keys[i] = mortonKey(cCoordsOf(i, dims), dims);
  }
  const sorted = Array.from(order).sort((a, b) => keys[a] - keys[b]);

  const perm = new Uint32Array(n);
  const inv = new Uint32Array(n);
  for (let linearIndex = 0; linearIndex < n; linearIndex++) {
    const cFlat = sorted[linearIndex];
    perm[linearIndex] = cFlat;
    inv[cFlat] = linearIndex;
  }
  return { perm, inv };
}

/**
 * Memoized permutation pair for one dims/morton combination:
 * perm[linearIndex] = cOrderFlatIndex, inv[cOrderFlatIndex] = linearIndex.
 * Cache keyed by `dims.join(',')`, capped at 32 entries (chunk dims repeat
 * across chunks; edge-clipped variants add a few). Returns null for 'c' and
 * 'fortran' — both have closed-form index/coord math (`cIndexOf`/
 * `cCoordsOf`, `fortranIndexOf`/`fortranCoordsOf`) and never need a
 * materialized permutation; only 'morton' does, since its index depends on a
 * sort over interleaved bit keys with no closed form.
 */
export function orderPermutation(
  dims: number[],
  order: LinearizationOrder,
): Permutation | null {
  if (order !== 'morton') return null;

  const key = dims.join(',');
  const cached = permutationCache.get(key);
  if (cached) return cached;

  const result = buildMortonPermutation(dims);
  setCached(key, result);
  return result;
}

function setCached(key: string, value: Permutation): void {
  if (permutationCache.size >= PERMUTATION_CACHE_CAP) {
    const oldest = permutationCache.keys().next().value;
    if (oldest !== undefined) permutationCache.delete(oldest);
  }
  permutationCache.set(key, value);
}

/**
 * Position of element `coords` (within a chunk of `dims`) in the linearized
 * element sequence. Bijective over [0, product(dims)).
 */
export function orderIndexOf(coords: number[], dims: number[], order: LinearizationOrder): number {
  if (dims.length <= 1 || order === 'c') return cIndexOf(coords, dims);
  if (order === 'fortran') return fortranIndexOf(coords, dims);
  // morton
  const cFlat = cIndexOf(coords, dims);
  const { inv } = orderPermutation(dims, order)!;
  return inv[cFlat];
}

/** Inverse of orderIndexOf. */
export function orderCoordsOf(index: number, dims: number[], order: LinearizationOrder): number[] {
  if (dims.length <= 1 || order === 'c') return cCoordsOf(index, dims);
  if (order === 'fortran') return fortranCoordsOf(index, dims);
  // morton
  const { perm } = orderPermutation(dims, order)!;
  return cCoordsOf(perm[index], dims);
}
