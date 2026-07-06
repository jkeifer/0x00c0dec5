/**
 * D9 (remediation-plan.md, Phase 6.1) — data generation modes.
 *
 * The core claim these tests exist to verify: structured generation modes
 * (sorted/stepped/smooth) are compressible by the existing codec pipeline,
 * while 'random' is not — the tool's central dramatic arc ("watch structure
 * get exploited into fewer bytes") only works if this is true.
 */
import { describe, it, expect } from 'vitest';
import { generateValues } from '../../engine/generate.ts';
import { assignType } from '../../engine/typeAssign.ts';
import { runCodecPipeline, shannonEntropy } from '../../engine/codecs.ts';
import { valuesToBytes } from '../../engine/elements.ts';
import { computePipelineStages } from '../../hooks/usePipeline.ts';
import { DEFAULT_STATE } from '../../types/state.ts';
import type { AppState, GenerationMode, LogicalTypeConfig, Variable } from '../../types/state.ts';
import type { CodecStep } from '../../types/codecs.ts';
import type { DtypeKey } from '../../types/dtypes.ts';

const COUNT = 256;

function makeLogicalType(generation: GenerationMode, overrides: Partial<LogicalTypeConfig> = {}): LogicalTypeConfig {
  return { type: 'integer', min: 0, max: 1000, generation, ...overrides };
}

/** Encode raw typed bytes through a codec pipeline and return the final byte length. */
function encodedLength(bytes: Uint8Array, dtype: DtypeKey, steps: CodecStep[]): number {
  const result = runCodecPipeline(bytes, [], steps, dtype);
  return result.bytes.length;
}

describe('generation modes — compressibility signatures', () => {
  it('sorted + delta + rle shrinks well below raw typed bytes', () => {
    // uint8 storage over a narrow range: prefix-summed, rescaled sorted data
    // produces small, frequently-repeating step-to-step diffs (many 0s/1s),
    // which is exactly what delta+RLE is built to exploit. Verified: this
    // config achieves ~0.32 (encoded/raw); asserting < 0.5 leaves headroom.
    const logicalType = makeLogicalType('sorted', { type: 'integer', min: 0, max: 20 });
    const values = generateValues('sorted-var', logicalType, COUNT);
    const { bytes: typedBytes } = assignType(values, logicalType, { storageDtype: 'uint8' });

    const steps: CodecStep[] = [
      { codec: 'delta', params: { order: 1 } },
      { codec: 'rle', params: {} },
    ];
    const finalLength = encodedLength(typedBytes, 'uint8', steps);

    const ratio = finalLength / typedBytes.length;
    expect(ratio).toBeLessThan(0.5);
  });

  it('stepped + rle shrinks well below raw typed bytes', () => {
    // uint8 storage: each of the ~32 constant-valued segments becomes one
    // long run of an identical byte, which RLE collapses to a (count, value)
    // pair. Verified: this config achieves ~0.23; asserting < 0.4 leaves
    // headroom. (uint16+ storage defeats plain RLE here — see the 'random'
    // case below for why: multi-byte values interleave lo/hi bytes, breaking
    // single-byte runs even when the underlying 16-bit values repeat. That's
    // a real lesson too, just not this test's.)
    const logicalType = makeLogicalType('stepped', { type: 'integer', min: 0, max: 255 });
    const values = generateValues('stepped-var', logicalType, COUNT);
    const { bytes: typedBytes } = assignType(values, logicalType, { storageDtype: 'uint8' });

    const steps: CodecStep[] = [{ codec: 'rle', params: {} }];
    const finalLength = encodedLength(typedBytes, 'uint8', steps);

    const ratio = finalLength / typedBytes.length;
    expect(ratio).toBeLessThan(0.4);
  });

  it('random + rle INFLATES — the warning-path contrast case', () => {
    const logicalType = makeLogicalType('random', { type: 'integer', min: 0, max: 1000 });
    const values = generateValues('random-var', logicalType, COUNT);
    const { bytes: typedBytes } = assignType(values, logicalType, { storageDtype: 'uint16' });

    const steps: CodecStep[] = [{ codec: 'rle', params: {} }];
    const finalLength = encodedLength(typedBytes, 'uint16', steps);

    // Uniform random uint16 bytes essentially never repeat run-to-run, so RLE's
    // (count, value) pair encoding doubles the byte count in the worst case and
    // never shrinks it.
    expect(finalLength).toBeGreaterThan(typedBytes.length);
  });

  it('smooth + delta reduces entropy vs raw bytes', () => {
    const logicalType = makeLogicalType('smooth', { type: 'integer', min: 0, max: 100_000 });
    const values = generateValues('smooth-var', logicalType, COUNT);
    const { bytes: typedBytes } = assignType(values, logicalType, { storageDtype: 'uint32' });

    const steps: CodecStep[] = [{ codec: 'delta', params: { order: 1 } }];
    const result = runCodecPipeline(typedBytes, [], steps, 'uint32');

    const rawEntropy = shannonEntropy(typedBytes);
    const deltaEntropy = shannonEntropy(result.bytes);
    expect(deltaEntropy).toBeLessThan(rawEntropy);
  });

  describe('determinism', () => {
    const modes: GenerationMode[] = ['random', 'smooth', 'sorted', 'stepped'];
    it.each(modes)('%s: same name+seed+mode produces identical arrays across calls', (mode) => {
      const logicalType = makeLogicalType(mode);
      const a = generateValues('det-var', logicalType, COUNT);
      const b = generateValues('det-var', logicalType, COUNT);
      expect(a).toEqual(b);
    });

    it.each(modes)('%s: different global seed produces a different array', (mode) => {
      const logicalType = makeLogicalType(mode);
      const a = generateValues('det-var', logicalType, COUNT, 1);
      const b = generateValues('det-var', logicalType, COUNT, 2);
      expect(a).not.toEqual(b);
    });
  });

  describe('range and rounding respected by every mode', () => {
    const modes: GenerationMode[] = ['random', 'smooth', 'sorted', 'stepped'];

    it.each(modes)('%s: integer values stay within [min, max] and are integers', (mode) => {
      const logicalType = makeLogicalType(mode, { type: 'integer', min: -25, max: 25 });
      const values = generateValues('int-var', logicalType, COUNT);
      for (const v of values) {
        expect(v).toBeGreaterThanOrEqual(-25);
        expect(v).toBeLessThanOrEqual(25);
        expect(Number.isInteger(v)).toBe(true);
      }
    });

    it.each(modes)('%s: decimal values respect [min, max] and decimalPlaces', (mode) => {
      const logicalType: LogicalTypeConfig = {
        type: 'decimal', min: -10, max: 10, decimalPlaces: 2, generation: mode,
      };
      const values = generateValues('dec-var', logicalType, COUNT) as number[];
      for (const v of values) {
        expect(v).toBeGreaterThanOrEqual(-10);
        expect(v).toBeLessThanOrEqual(10);
        expect(Math.round(v * 100)).toBeCloseTo(v * 100, 6);
      }
    });

    it.each(modes)('%s: continuous values respect [min, max]', (mode) => {
      const logicalType: LogicalTypeConfig = {
        type: 'continuous', min: -500, max: 500, significantFigures: 6, generation: mode,
      };
      const values = generateValues('cont-var', logicalType, COUNT);
      for (const v of values) {
        expect(v).toBeGreaterThanOrEqual(-500);
        expect(v).toBeLessThanOrEqual(500);
      }
    });
  });

  describe('mode-specific shape invariants', () => {
    it('sorted produces a monotonic non-decreasing sequence', () => {
      const logicalType = makeLogicalType('sorted', { type: 'continuous', significantFigures: 10 });
      const values = generateValues('sorted-shape', logicalType, COUNT) as number[];
      for (let i = 1; i < values.length; i++) {
        expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
      }
      // Should actually span close to the full range, not collapse to a point.
      expect(values[values.length - 1] - values[0]).toBeGreaterThan(500);
    });

    it('stepped produces a small number of distinct constant runs', () => {
      const logicalType = makeLogicalType('stepped', { type: 'continuous', significantFigures: 10 });
      const values = generateValues('stepped-shape', logicalType, COUNT);
      let runs = 1;
      for (let i = 1; i < values.length; i++) {
        if (values[i] !== values[i - 1]) runs++;
      }
      // k = max(3, floor(256/8)) = 32 segments => at most 32 runs (could be
      // fewer if two adjacent segments draw the same constant, astronomically
      // unlikely here, but never more).
      expect(runs).toBeLessThanOrEqual(32);
      expect(runs).toBeGreaterThanOrEqual(3);
    });

    it('smooth produces small step-to-step deltas relative to the full range', () => {
      const logicalType = makeLogicalType('smooth', { type: 'continuous', min: 0, max: 1000, significantFigures: 10 });
      const values = generateValues('smooth-shape', logicalType, COUNT) as number[];
      const maxStep = Math.max(...values.slice(1).map((v, i) => Math.abs(v - values[i])));
      // Step size is bounded by range/16 (~62.5); allow slack for the
      // logicalType rounding pass, still far below a uniform-random jump.
      expect(maxStep).toBeLessThan(1000 / 8);
    });
  });

  describe('round-trip invariants unaffected by generation mode', () => {
    const modes: GenerationMode[] = ['random', 'smooth', 'sorted', 'stepped'];

    function stateForMode(mode: GenerationMode): AppState {
      // Both variables use integer logicalType + an integer storage dtype
      // wide enough to hold the full range losslessly — this isolates the
      // round-trip check to "does generation mode break anything", not the
      // pre-existing, well-covered float32-decimal precision loss (see
      // roundtrip.matrix.test.ts's `expectExactRoundTrip` callers, which
      // exclude float32 decimal variables for the same reason).
      const variables: Variable[] = [
        {
          id: 'v1', name: 'v1', color: '#e06c75',
          logicalType: { type: 'integer', min: -1000, max: 1000, generation: mode },
          typeAssignment: { storageDtype: 'int32' },
        },
        {
          id: 'v2', name: 'v2', color: '#98c379',
          logicalType: { type: 'integer', min: 0, max: 1000, generation: mode },
          typeAssignment: { storageDtype: 'uint16' },
        },
      ];
      return {
        ...DEFAULT_STATE,
        shape: [32],
        chunkShape: [32],
        variables,
        fieldPipelines: { v1: [], v2: [] },
        write: { ...DEFAULT_STATE.write, includeMetadata: true },
      };
    }

    it.each(modes)('%s: lossless config round-trips exactly via computePipelineStages', (mode) => {
      const state = stateForMode(mode);
      const { readResult } = computePipelineStages(state);
      expect(readResult.success).toBe(true);
      if (!readResult.success) return;

      const totalElements = state.shape.reduce((a, b) => a * b, 1);
      for (const v of state.variables) {
        const expected = generateValues(v.name, v.logicalType, totalElements);
        const actual = readResult.reconstructedValues.get(v.name) ?? [];
        expect(actual.length).toBe(expected.length);
        expect(actual).toEqual(expected);
      }
    });
  });
});

describe('generation modes — raw byte size sanity (dtype-flow check)', () => {
  it('valuesToBytes on a sorted uint32 sequence produces the expected byte length', () => {
    const logicalType = makeLogicalType('sorted', { type: 'integer', min: 0, max: 100_000 });
    const values = generateValues('sorted-bytes', logicalType, COUNT);
    const bytes = valuesToBytes(values, 'uint32');
    expect(bytes.length).toBe(COUNT * 4);
  });
});
