import type { LogicalTypeConfig } from '../types/state.ts';

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
 * Generate deterministic logical values for a variable.
 * Returns JS numbers with exact logical precision (no binary dtype artifacts).
 *
 * - integer: random integers in [min, max]
 * - decimal: numbers with exactly `decimalPlaces` fractional digits in [min, max]
 * - continuous: float64 numbers in [min, max] with up to `significantFigures` digits
 */
export function generateValues(
  variableName: string,
  logicalType: LogicalTypeConfig,
  count: number,
  globalSeed: number = DEFAULT_GLOBAL_SEED,
): number[] {
  const seed = hashSeed(variableName + ':' + globalSeed);
  const rng = createPRNG(seed);
  const values: number[] = new Array(count);

  switch (logicalType.type) {
    case 'integer': {
      const range = logicalType.max - logicalType.min + 1;
      for (let i = 0; i < count; i++) {
        values[i] = Math.floor(rng() * range) + logicalType.min;
      }
      break;
    }
    case 'decimal': {
      const places = logicalType.decimalPlaces ?? 1;
      const factor = Math.pow(10, places);
      const minScaled = Math.round(logicalType.min * factor);
      const maxScaled = Math.round(logicalType.max * factor);
      const range = maxScaled - minScaled + 1;
      for (let i = 0; i < count; i++) {
        const scaled = Math.floor(rng() * range) + minScaled;
        values[i] = scaled / factor;
      }
      break;
    }
    case 'continuous': {
      const sigFigs = logicalType.significantFigures ?? 6;
      const range = logicalType.max - logicalType.min;
      for (let i = 0; i < count; i++) {
        const raw = rng() * range + logicalType.min;
        values[i] = Number(raw.toPrecision(sigFigs));
      }
      break;
    }
  }

  return values;
}
