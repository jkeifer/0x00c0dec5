import { describe, it, expect } from 'vitest';
import { roundToSigFigs, createPRNG, generateValues } from '../../../src/engine/generate.ts';
import type { LogicalTypeConfig } from '../../../src/types/state.ts';

describe('roundToSigFigs', () => {
  it('handles exact cases', () => {
    expect(roundToSigFigs(0, 6)).toBe(0);
    expect(roundToSigFigs(123.456789, 6)).toBe(Number((123.456789).toPrecision(6)));
    expect(roundToSigFigs(-0.000123456, 3)).toBe(Number((-0.000123456).toPrecision(3)));
    expect(roundToSigFigs(1000, 2)).toBe(1000);
    expect(roundToSigFigs(999.999, 3)).toBe(Number((999.999).toPrecision(3))); // magnitude-boundary rounding
  });

  it('matches toPrecision within 1 ulp over a large seeded sample, exactly in >=99% of cases', () => {
    const rng = createPRNG(0xc0dec5);
    let exact = 0;
    const N = 100_000;
    for (let i = 0; i < N; i++) {
      // Cover the generation domains: magnitudes from ~1e-6 to ~1e6, both signs
      const mag = (rng() - 0.5) * 12;
      const x = (rng() - 0.5) * 2 * Math.pow(10, mag);
      const sig = 1 + Math.floor(rng() * 9);
      const fast = roundToSigFigs(x, sig);
      const ref = Number(x.toPrecision(sig));
      if (fast === ref) { exact++; continue; }
      // tolerance: within 1 ulp of the reference
      const ulp = Math.abs(ref) * Number.EPSILON * 2 + Number.MIN_VALUE;
      expect(Math.abs(fast - ref), `x=${x} sig=${sig}`).toBeLessThanOrEqual(ulp);
    }
    expect(exact / N).toBeGreaterThan(0.99);
  });

  it('generateValues stays deterministic (same seed, same values)', () => {
    const cfg: LogicalTypeConfig = { type: 'continuous', min: -20, max: 40, significantFigures: 6, generation: 'random' };
    const a = generateValues('temperature', cfg, 1000);
    const b = generateValues('temperature', cfg, 1000);
    expect(Array.from(a as Float64Array)).toEqual(Array.from(b as Float64Array));
  });
});
