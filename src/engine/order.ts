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
 */

export type LinearizationOrder = 'c' | 'fortran' | 'morton';

export const LINEARIZATION_ORDERS: LinearizationOrder[] = ['c', 'fortran', 'morton'];

function bitWidth(n: number): number {
  // ceil(log2(n)), with n === 1 (and n <= 0, defensively) contributing 0 bits.
  if (n <= 1) return 0;
  return Math.ceil(Math.log2(n));
}

function mortonKey(coords: number[], dims: number[]): number {
  const ndim = dims.length;
  const widths = dims.map(bitWidth);
  const maxWidth = Math.max(0, ...widths);
  let key = 0;
  let keyBit = 0;
  for (let bit = 0; bit < maxWidth; bit++) {
    for (let d = ndim - 1; d >= 0; d--) {
      if (bit < widths[d]) {
        const b = (coords[d] >> bit) & 1;
        key |= b << keyBit;
        keyBit++;
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

function buildFortranPermutation(dims: number[]): Permutation {
  const n = dims.reduce((a, b) => a * b, 1);
  const perm = new Uint32Array(n);
  const inv = new Uint32Array(n);
  for (let linearIndex = 0; linearIndex < n; linearIndex++) {
    const coords = fortranCoordsOf(linearIndex, dims);
    const cFlat = cIndexOf(coords, dims);
    perm[linearIndex] = cFlat;
    inv[cFlat] = linearIndex;
  }
  return { perm, inv };
}

/**
 * Memoized permutation pair for one dims/order combination:
 * perm[linearIndex] = cOrderFlatIndex, inv[cOrderFlatIndex] = linearIndex.
 * Cache keyed by `${order}:${dims.join(',')}`, capped at 32 entries (chunk
 * dims repeat across chunks; edge-clipped variants add a few). Returns null
 * for 'c' (identity — callers use closed-form math and skip the arrays).
 */
export function orderPermutation(
  dims: number[],
  order: LinearizationOrder,
): Permutation | null {
  if (order === 'c') return null;

  const key = `${order}:${dims.join(',')}`;
  const cached = permutationCache.get(key);
  if (cached) return cached;

  const result = order === 'morton' ? buildMortonPermutation(dims) : buildFortranPermutation(dims);
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
