import type { LogicalTypeConfig, GenerationMode, WordSetKey } from '../types/state.ts';
import type { LogicalValue } from '../types/dtypes.ts';

const DEFAULT_GLOBAL_SEED = 0xc0dec5;

// ─── Word sets for text variables ───────────────────────────────────────────
//
// All four sets are ASCII-transliterated and sorted lexicographically (JS
// default sort), with no trailing spaces (the charN write path space-pads to
// width, so a trailing space would break the write→read roundtrip). Sorted
// order is what makes every generation mode meaningful for free: random =
// random draws, sorted = lexicographically non-decreasing, stepped =
// constant categorical runs (the RLE payoff), smooth = drifting between
// alphabetical neighbors.

// 81 entries, longest 9 chars — given names spanning East/South Asian,
// African, European, Latin American, Middle Eastern, and Pacific origins.
const NAMES: string[] = [
  'Aarav', 'Abebe', 'Adaeze', 'Aditi', 'Ahmed', 'Aiko', 'Akira', 'Alejandro', 'Amara', 'Amina',
  'Ananya', 'Anders', 'Arjun', 'Aroha', 'Astrid', 'Ayo', 'Bjorn', 'Camila', 'Carlos', 'Chen',
  'Chiara', 'Chinwe', 'Daiyu', 'Dev', 'Diego', 'Dmitri', 'Elena', 'Fatima', 'Femi', 'Freya',
  'Gabriela', 'Giulia', 'Hana', 'Hans', 'Haruto', 'Hassan', 'Hiroshi', 'Ingrid', 'Isabela', 'Ivan',
  'Jia', 'Jun', 'Katarzyna', 'Kavya', 'Keanu', 'Kofi', 'Kwame', 'Lakshmi', 'Lars', 'Layla', 'Luca',
  'Magnus', 'Mateo', 'Mei', 'Minjun', 'Moana', 'Nadia', 'Nia', 'Nisha', 'Omar', 'Oskar', 'Priya',
  'Rafael', 'Raj', 'Rohan', 'Sakura', 'Samira', 'Sanjay', 'Sekou', 'Sofia', 'Sven', 'Takeshi',
  'Tariq', 'Thandiwe', 'Valentina', 'Wei', 'Ximena', 'Yasmin', 'Yuki', 'Zainab', 'Zuri',
];

// 100 entries, longest 13 chars — world cities.
const CITIES: string[] = [
  'Abidjan', 'Accra', 'Addis Ababa', 'Amsterdam', 'Athens', 'Auckland', 'Bangkok', 'Barcelona',
  'Beijing', 'Beirut', 'Bengaluru', 'Berlin', 'Bogota', 'Brasilia', 'Bucharest', 'Buenos Aires',
  'Cairo', 'Cape Town', 'Caracas', 'Casablanca', 'Chengdu', 'Chicago', 'Colombo', 'Copenhagen',
  'Dakar', 'Dar es Salaam', 'Delhi', 'Dubai', 'Dublin', 'Fukuoka', 'Geneva', 'Hanoi', 'Harare',
  'Havana', 'Helsinki', 'Ho Chi Minh', 'Honolulu', 'Istanbul', 'Jakarta', 'Johannesburg',
  'Karachi', 'Kathmandu', 'Kigali', 'Kinshasa', 'Kolkata', 'Kuala Lumpur', 'Kyiv', 'Lagos', 'Lima',
  'Lisbon', 'London', 'Los Angeles', 'Luanda', 'Lusaka', 'Madrid', 'Manila', 'Maputo', 'Melbourne',
  'Mexico City', 'Mombasa', 'Montevideo', 'Montreal', 'Moscow', 'Mumbai', 'Nairobi', 'New York',
  'Osaka', 'Oslo', 'Panama City', 'Paris', 'Prague', 'Quito', 'Reykjavik', 'Riyadh', 'Rome',
  'Santiago', 'Sao Paulo', 'Sapporo', 'Seattle', 'Seoul', 'Shanghai', 'Singapore', 'Sofia',
  'Stockholm', 'Sydney', 'Taipei', 'Tallinn', 'Tashkent', 'Tbilisi', 'Tehran', 'Tokyo', 'Toronto',
  'Ulaanbaatar', 'Vancouver', 'Vienna', 'Warsaw', 'Wellington', 'Yerevan', 'Zagreb', 'Zurich',
];

// 100 entries, longest 12 chars — countries worldwide.
const COUNTRIES: string[] = [
  'Algeria', 'Angola', 'Argentina', 'Australia', 'Austria', 'Bangladesh', 'Belgium', 'Bolivia',
  'Botswana', 'Brazil', 'Bulgaria', 'Cambodia', 'Cameroon', 'Canada', 'Chile', 'China', 'Colombia',
  'Croatia', 'Czechia', 'Denmark', 'Ecuador', 'Egypt', 'Estonia', 'Ethiopia', 'Finland', 'France',
  'Georgia', 'Germany', 'Ghana', 'Greece', 'Guatemala', 'Honduras', 'Hungary', 'Iceland', 'India',
  'Indonesia', 'Iran', 'Iraq', 'Ireland', 'Israel', 'Italy', 'Jamaica', 'Japan', 'Jordan',
  'Kazakhstan', 'Kenya', 'Latvia', 'Lebanon', 'Lithuania', 'Madagascar', 'Malaysia', 'Mexico',
  'Mongolia', 'Morocco', 'Mozambique', 'Myanmar', 'Namibia', 'Nepal', 'Netherlands', 'New Zealand',
  'Nicaragua', 'Nigeria', 'Norway', 'Pakistan', 'Panama', 'Paraguay', 'Peru', 'Philippines',
  'Poland', 'Portugal', 'Romania', 'Rwanda', 'Saudi Arabia', 'Senegal', 'Serbia', 'Singapore',
  'Slovakia', 'Slovenia', 'Somalia', 'South Africa', 'South Korea', 'Spain', 'Sri Lanka', 'Sudan',
  'Sweden', 'Switzerland', 'Taiwan', 'Tanzania', 'Thailand', 'Tunisia', 'Turkey', 'Uganda',
  'Ukraine', 'Uruguay', 'Uzbekistan', 'Venezuela', 'Vietnam', 'Yemen', 'Zambia', 'Zimbabwe',
];

// 64 entries, longest 9 chars — synthetic prefix-heavy station IDs (the LZ
// demo: shared 'WX-0…' prefixes are exactly what back-references eat up).
const STATIONS: string[] = [
  'WX-0007-A', 'WX-0007-B', 'WX-0014-A', 'WX-0014-B', 'WX-0021-A', 'WX-0021-B', 'WX-0028-A',
  'WX-0028-B', 'WX-0035-A', 'WX-0035-B', 'WX-0042-A', 'WX-0042-B', 'WX-0049-A', 'WX-0049-B',
  'WX-0056-A', 'WX-0056-B', 'WX-0063-A', 'WX-0063-B', 'WX-0070-A', 'WX-0070-B', 'WX-0077-A',
  'WX-0077-B', 'WX-0084-A', 'WX-0084-B', 'WX-0091-A', 'WX-0091-B', 'WX-0098-A', 'WX-0098-B',
  'WX-0105-A', 'WX-0105-B', 'WX-0112-A', 'WX-0112-B', 'WX-0119-A', 'WX-0119-B', 'WX-0126-A',
  'WX-0126-B', 'WX-0133-A', 'WX-0133-B', 'WX-0140-A', 'WX-0140-B', 'WX-0147-A', 'WX-0147-B',
  'WX-0154-A', 'WX-0154-B', 'WX-0161-A', 'WX-0161-B', 'WX-0168-A', 'WX-0168-B', 'WX-0175-A',
  'WX-0175-B', 'WX-0182-A', 'WX-0182-B', 'WX-0189-A', 'WX-0189-B', 'WX-0196-A', 'WX-0196-B',
  'WX-0203-A', 'WX-0203-B', 'WX-0210-A', 'WX-0210-B', 'WX-0217-A', 'WX-0217-B', 'WX-0224-A',
  'WX-0224-B',
];

export const WORD_SETS: Record<WordSetKey, string[]> = {
  names: NAMES,
  cities: CITIES,
  countries: COUNTRIES,
  stations: STATIONS,
};

/** Length of the longest word in a set — the SchemaEditor's "longest word: K
 * chars" hint and the natural char-width guidance. */
export function wordSetMaxLength(key: WordSetKey): number {
  return WORD_SETS[key].reduce((max, w) => Math.max(max, w.length), 0);
}

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
): LogicalValue[] {
  const seed = hashSeed(variableName + ':' + globalSeed);
  const rng = createPRNG(seed);
  const values: LogicalValue[] = new Array(count);
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
    case 'text': {
      // Words drawn from a sorted set: the same [0, 1) sequence machinery
      // maps every generation mode onto categorical data for free (see the
      // WORD_SETS comment above). min/max are ignored for text.
      const words = WORD_SETS[logicalType.wordSet ?? 'names'];
      const uniform01 = generateUniform01(rng, mode, count);
      for (let i = 0; i < count; i++) {
        values[i] = words[Math.min(words.length - 1, Math.floor(uniform01[i] * words.length))];
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
