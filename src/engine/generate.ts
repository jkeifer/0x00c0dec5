import type { LogicalTypeConfig, GenerationMode } from '../types/state.ts';

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
 *
 * D9: the raw (pre-rounding) [min, max] sequence is produced by
 * `logicalType.generation`'s algorithm; every mode uses the same seeded
 * `rng` (variable name + global seed), so results stay fully deterministic.
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
  const mode = logicalType.generation ?? 'random';

  switch (logicalType.type) {
    case 'integer': {
      const range = logicalType.max - logicalType.min + 1;
      const uniform01 = generateUniform01(rng, mode, count);
      for (let i = 0; i < count; i++) {
        values[i] = Math.floor(uniform01[i] * range) + logicalType.min;
      }
      break;
    }
    case 'decimal': {
      const places = logicalType.decimalPlaces ?? 1;
      const factor = Math.pow(10, places);
      const minScaled = Math.round(logicalType.min * factor);
      const maxScaled = Math.round(logicalType.max * factor);
      const range = maxScaled - minScaled + 1;
      const uniform01 = generateUniform01(rng, mode, count);
      for (let i = 0; i < count; i++) {
        const scaled = Math.floor(uniform01[i] * range) + minScaled;
        values[i] = scaled / factor;
      }
      break;
    }
    case 'continuous': {
      const sigFigs = logicalType.significantFigures ?? 6;
      const range = logicalType.max - logicalType.min;
      const uniform01 = generateUniform01(rng, mode, count);
      for (let i = 0; i < count; i++) {
        const raw = uniform01[i] * range + logicalType.min;
        values[i] = Number(raw.toPrecision(sigFigs));
      }
      break;
    }
  }

  return values;
}

/**
 * D9 (remediation-plan.md, Phase 6.1): produce `count` values in [0, 1)
 * shaped by `mode`, using the caller's seeded `rng`. `generateValues` then
 * maps this [0, 1) sequence into the logicalType's [min, max] domain and
 * applies its rounding rule — exactly the same final step regardless of
 * mode, so every mode inherits integer/decimal/continuous precision
 * handling uniformly.
 *
 * - 'random': `rng()` directly, unchanged from the pre-D9 behavior (each
 *   value here maps 1:1 to the original `rng() * range + min` computation).
 * - 'smooth': bounded random walk starting at the midpoint (0.5); each step
 *   perturbs by `(rng() - 0.5) / 16` (i.e. +/- range/16 once scaled to
 *   [min, max]), clamped back into [0, 1).
 * - 'sorted': `count` uniform-positive draws, prefix-summed, then rescaled
 *   so the sequence spans exactly [0, 1) — monotonic non-decreasing.
 * - 'stepped': `k = max(3, floor(count/8))` segments with PRNG-chosen
 *   (sorted, deduplicated) boundaries; each segment is one uniform-random
 *   constant in [0, 1).
 */
// Values downstream (generateValues' integer/decimal paths) treat this
// range as half-open [0, 1) — `Math.floor(uniform01[i] * range)` must never
// see exactly 1, or it lands one slot past the valid index range. Clamp the
// closed-interval algorithms below (smooth's walk, sorted's rescale) to
// this ceiling instead of 1.
const UPPER_BOUND = 1 - Number.EPSILON;

function generateUniform01(rng: () => number, mode: GenerationMode, count: number): number[] {
  const out: number[] = new Array(count);

  switch (mode) {
    case 'smooth': {
      let v = 0.5;
      for (let i = 0; i < count; i++) {
        if (i > 0) {
          v = Math.min(UPPER_BOUND, Math.max(0, v + (rng() - 0.5) / 16));
        }
        out[i] = v;
      }
      break;
    }
    case 'sorted': {
      if (count === 0) break;
      const draws: number[] = new Array(count);
      for (let i = 0; i < count; i++) {
        // Uniform positive draw; the tiny floor keeps a run of near-zero
        // rng() outputs from collapsing the prefix sum's early denominator.
        draws[i] = rng() + 1e-9;
      }
      if (count === 1) {
        out[0] = 0;
        break;
      }
      const prefix: number[] = new Array(count);
      let running = 0;
      for (let i = 0; i < count; i++) {
        running += draws[i];
        prefix[i] = running;
      }
      const first = prefix[0];
      const denom = prefix[count - 1] - first;
      for (let i = 0; i < count; i++) {
        out[i] = denom > 0 ? Math.min(UPPER_BOUND, (prefix[i] - first) / denom) : 0;
      }
      break;
    }
    case 'stepped': {
      if (count === 0) break;
      const k = Math.max(3, Math.floor(count / 8));
      // PRNG-chosen boundaries: draw k-1 cut points in [1, count), dedupe,
      // and sort — segments are the resulting contiguous runs.
      const cutsSet = new Set<number>();
      for (let i = 0; i < k - 1; i++) {
        cutsSet.add(1 + Math.floor(rng() * (count - 1)));
      }
      const cuts = Array.from(cutsSet).sort((a, b) => a - b);
      const boundaries = [0, ...cuts, count];
      for (let seg = 0; seg < boundaries.length - 1; seg++) {
        const constant = rng();
        for (let i = boundaries[seg]; i < boundaries[seg + 1]; i++) {
          out[i] = constant;
        }
      }
      break;
    }
    case 'random':
    default: {
      for (let i = 0; i < count; i++) {
        out[i] = rng();
      }
      break;
    }
  }

  return out;
}
