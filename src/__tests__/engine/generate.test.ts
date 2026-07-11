import { describe, it, expect } from 'vitest';
import { createPRNG, hashSeed, generateValues, WORD_SETS, wordSetMaxLength } from '../../engine/generate.ts';
import type { LogicalTypeConfig, WordSetKey } from '../../types/state.ts';

describe('createPRNG', () => {
  it('produces deterministic output for the same seed', () => {
    const rng1 = createPRNG(42);
    const rng2 = createPRNG(42);
    for (let i = 0; i < 100; i++) {
      expect(rng1()).toBe(rng2());
    }
  });

  it('produces values in [0, 1)', () => {
    const rng = createPRNG(12345);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('produces different sequences for different seeds', () => {
    const rng1 = createPRNG(1);
    const rng2 = createPRNG(2);
    const seq1 = Array.from({ length: 10 }, () => rng1());
    const seq2 = Array.from({ length: 10 }, () => rng2());
    expect(seq1).not.toEqual(seq2);
  });
});

describe('hashSeed', () => {
  it('produces the same hash for the same string', () => {
    expect(hashSeed('test')).toBe(hashSeed('test'));
  });

  it('produces different hashes for different strings', () => {
    expect(hashSeed('temperature')).not.toBe(hashSeed('pressure'));
  });

  it('produces a 32-bit unsigned integer', () => {
    const h = hashSeed('anything');
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
    expect(Number.isInteger(h)).toBe(true);
  });
});

describe('generateValues', () => {
  const floatType: LogicalTypeConfig = { type: 'continuous', min: -1000, max: 1000, significantFigures: 6, generation: 'random' };
  const intType: LogicalTypeConfig = { type: 'integer', min: 0, max: 100, generation: 'random' };
  const decType: LogicalTypeConfig = { type: 'decimal', min: -50, max: 50, decimalPlaces: 1, generation: 'random' };

  it('produces the correct number of values', () => {
    const values = generateValues('test', floatType, 100);
    expect(values).toHaveLength(100);
  });

  it('is deterministic across calls', () => {
    const a = generateValues('temperature', decType, 50);
    const b = generateValues('temperature', decType, 50);
    expect(a).toEqual(b);
  });

  it('produces different data for different variable names', () => {
    const a = generateValues('temperature', decType, 50);
    const b = generateValues('pressure', decType, 50);
    expect(a).not.toEqual(b);
  });

  it('produces different data for different seeds', () => {
    const a = generateValues('temp', decType, 50, 1);
    const b = generateValues('temp', decType, 50, 2);
    expect(a).not.toEqual(b);
  });

  it('produces continuous values in range', () => {
    const values = generateValues('test', floatType, 10000);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(-1000);
      expect(v).toBeLessThanOrEqual(1000);
    }
  });

  it('produces integer values in range', () => {
    const values = generateValues('test', intType, 5000);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('produces decimal values with correct precision', () => {
    const values = generateValues('test', decType, 1000) as number[];
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(-50);
      expect(v).toBeLessThanOrEqual(50);
      // Check exactly 1 decimal place: v * 10 should be integer
      expect(Number.isInteger(Math.round(v * 10))).toBe(true);
      expect(v * 10).toBeCloseTo(Math.round(v * 10), 10);
    }
  });

  it('handles count of 0', () => {
    const values = generateValues('test', intType, 0);
    expect(values).toHaveLength(0);
  });

  // Task 11 (perf plan): numeric logical types return Float64Array (compact,
  // transferable in Task 12), not a plain LogicalValue[].
  it.each([
    ['integer', intType],
    ['decimal', decType],
    ['continuous', floatType],
  ] as const)('returns a Float64Array for %s logical type', (_label, logicalType) => {
    const values = generateValues('test', logicalType, 10);
    expect(values).toBeInstanceOf(Float64Array);
  });
});

describe('text generation', () => {
  function textType(wordSet: WordSetKey, generation: LogicalTypeConfig['generation']): LogicalTypeConfig {
    return { type: 'text', min: 0, max: 0, wordSet, generation };
  }

  it('is deterministic for the same variable name', () => {
    const a = generateValues('station', textType('cities', 'random'), 64);
    const b = generateValues('station', textType('cities', 'random'), 64);
    expect(a).toEqual(b);
  });

  // Task 11 (perf plan): text stays a plain string[] — only numeric logical
  // types migrate to Float64Array.
  it('returns a plain string[], not a Float64Array', () => {
    const values = generateValues('station', textType('cities', 'random'), 10);
    expect(Array.isArray(values)).toBe(true);
    expect(values).not.toBeInstanceOf(Float64Array);
  });

  it('draws every value from the configured word set', () => {
    for (const key of Object.keys(WORD_SETS) as WordSetKey[]) {
      const values = generateValues('v', textType(key, 'random'), 200);
      const set = new Set(WORD_SETS[key]);
      for (const v of values) {
        expect(set.has(v as string)).toBe(true);
      }
    }
  });

  it('defaults to the names set when wordSet is missing', () => {
    const values = generateValues('v', { type: 'text', min: 0, max: 0, generation: 'random' }, 50);
    const set = new Set(WORD_SETS.names);
    for (const v of values) expect(set.has(v as string)).toBe(true);
  });

  it('sorted mode yields lexicographically non-decreasing words', () => {
    const values = generateValues('v', textType('countries', 'sorted'), 128) as string[];
    for (let i = 1; i < values.length; i++) {
      expect(values[i] >= values[i - 1]).toBe(true);
    }
  });

  it('stepped mode yields constant categorical runs', () => {
    const values = generateValues('v', textType('cities', 'stepped'), 256) as string[];
    let runs = 1;
    for (let i = 1; i < values.length; i++) {
      if (values[i] !== values[i - 1]) runs++;
    }
    // k = max(3, floor(256/8)) = 32 segments => at most 32 runs.
    expect(runs).toBeLessThanOrEqual(32);
  });

  it('handles count 0 and 1', () => {
    expect(generateValues('v', textType('names', 'random'), 0)).toEqual([]);
    const one = generateValues('v', textType('names', 'sorted'), 1);
    expect(one.length).toBe(1);
    expect(typeof one[0]).toBe('string');
  });

  it('bundled word sets are sorted, ASCII-only, and free of trailing spaces', () => {
    for (const key of Object.keys(WORD_SETS) as WordSetKey[]) {
      const words = WORD_SETS[key];
      expect(words.length).toBeGreaterThanOrEqual(60);
      for (let i = 0; i < words.length; i++) {
        const w = words[i];
        // Roundtrip invariant: charN padding is spaces, so a trailing space
        // in a bundled word would not survive write -> read.
        expect(w).toBe(w.trimEnd());
        expect(/^[\x20-\x7e]+$/.test(w)).toBe(true);
        if (i > 0) expect(words[i] >= words[i - 1]).toBe(true);
      }
      expect(wordSetMaxLength(key)).toBe(Math.max(...words.map((w) => w.length)));
      // All bundled sets fit char16 losslessly.
      expect(wordSetMaxLength(key)).toBeLessThanOrEqual(16);
    }
  });
});
