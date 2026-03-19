import { describe, it, expect } from 'vitest';
import { createPRNG, hashSeed, generateValues } from '../../engine/generate.ts';
import { DTYPE_KEYS, getDtype } from '../../types/dtypes.ts';
import type { DtypeKey } from '../../types/dtypes.ts';

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
  it('produces the correct number of values', () => {
    const values = generateValues('test', 'float32', 100);
    expect(values).toHaveLength(100);
  });

  it('is deterministic across calls', () => {
    const a = generateValues('temperature', 'float32', 50);
    const b = generateValues('temperature', 'float32', 50);
    expect(a).toEqual(b);
  });

  it('produces different data for different variable names', () => {
    const a = generateValues('temperature', 'float32', 50);
    const b = generateValues('pressure', 'float32', 50);
    expect(a).not.toEqual(b);
  });

  it('produces different data for different seeds', () => {
    const a = generateValues('temp', 'float32', 50, 1);
    const b = generateValues('temp', 'float32', 50, 2);
    expect(a).not.toEqual(b);
  });

  it('produces float values in [-1000, 1000]', () => {
    const values = generateValues('test', 'float64', 10000);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(-1000);
      expect(v).toBeLessThanOrEqual(1000);
    }
  });

  it.each(
    DTYPE_KEYS.filter((k) => !getDtype(k).float) as DtypeKey[],
  )('produces %s values within type range', (dtype) => {
    const info = getDtype(dtype);
    const values = generateValues('test', dtype, 5000);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(info.min);
      expect(v).toBeLessThanOrEqual(info.max);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('handles count of 0', () => {
    const values = generateValues('test', 'float32', 0);
    expect(values).toHaveLength(0);
  });
});
