import { describe, it, expect } from 'vitest';
import { createPRNG, hashSeed, generateValues } from '../../engine/generate.ts';
import type { LogicalTypeConfig } from '../../types/state.ts';

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
  const floatType: LogicalTypeConfig = { type: 'continuous', min: -1000, max: 1000, significantFigures: 6 };
  const intType: LogicalTypeConfig = { type: 'integer', min: 0, max: 100 };
  const decType: LogicalTypeConfig = { type: 'decimal', min: -50, max: 50, decimalPlaces: 1 };

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
    const values = generateValues('test', decType, 1000);
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
});
