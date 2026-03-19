import { getDtype } from '../types/dtypes.ts';
import type { DtypeKey } from '../types/dtypes.ts';

const DEFAULT_GLOBAL_SEED = 0xc0dec5;

/** FNV-1a hash producing a 32-bit unsigned integer. */
export function hashSeed(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Mulberry32 PRNG. Returns a function that produces values in [0, 1). */
export function createPRNG(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate deterministic values for a variable.
 * Integer types: uniform across full type range.
 * Float types: uniform in [-1000, 1000].
 */
export function generateValues(
  variableName: string,
  dtype: DtypeKey,
  count: number,
  globalSeed: number = DEFAULT_GLOBAL_SEED,
): number[] {
  const seed = hashSeed(variableName + ':' + globalSeed);
  const rng = createPRNG(seed);
  const info = getDtype(dtype);
  const values: number[] = new Array(count);

  if (info.float) {
    for (let i = 0; i < count; i++) {
      values[i] = rng() * 2000 - 1000;
    }
  } else {
    const range = info.max - info.min + 1;
    for (let i = 0; i < count; i++) {
      values[i] = Math.floor(rng() * range) + info.min;
    }
  }

  return values;
}
