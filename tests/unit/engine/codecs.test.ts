import { describe, it, expect } from 'vitest';
import {
  activeSteps,
  CODEC_REGISTRY,
  runCodecPipeline,
  shannonEntropy,
  outputDtypeFor,
  stepWarnings,
  pipelineOutputDtype,
  encodedByteLength,
} from '../../../src/engine/codecs.ts';
import { reverseCodecPipeline } from '../../../src/engine/decode.ts';
import { valuesToBytes, bytesToValues } from '../../../src/engine/elements.ts';
import type { CodecStep, CodecDefinition } from '../../../src/types/codecs.ts';

describe('codec registry', () => {
  it('contains quantize, bitround, scale-offset, delta, zigzag, byte-shuffle, bit-shuffle, dictionary, rle, and the pyodide-backed real codecs', () => {
    const keys = Object.keys(CODEC_REGISTRY).sort();
    expect(keys).toEqual(['bit-shuffle', 'bitround', 'byte-shuffle', 'deflate', 'delta', 'dictionary', 'gzip', 'quantize', 'rle', 'scale-offset', 'zigzag', 'zstd']);
  });
});

describe('zigzag codec', () => {
  it('is applicable to signed ints only', () => {
    const z = CODEC_REGISTRY['zigzag'];
    expect(z.category).toBe('reordering');
    expect(z.applicableTo('int16')).toBe(true);
    expect(z.applicableTo('int32')).toBe(true);
    expect(z.applicableTo('uint16')).toBe(false);
    expect(z.applicableTo('float32')).toBe(false);
  });
  it('maps small magnitudes to small unsigned values and round-trips exactly', () => {
    const values = [0, -1, 1, -2, 2, -100, 100, -32768, 32767];
    const bytes = valuesToBytes(values, 'int16');
    const enc = CODEC_REGISTRY['zigzag'].encode(bytes, 'int16', {});
    expect(enc.outputDtype).toBe('int16'); // dtype-preserving (stride unchanged)
    // zigzag(0)=0, zigzag(-1)=1, zigzag(1)=2, zigzag(-2)=3, zigzag(2)=4
    const encVals = bytesToValues(enc.bytes, 'uint16');
    expect(Array.from(encVals as Float64Array).slice(0, 5)).toEqual([0, 1, 2, 3, 4]);
    const dec = CODEC_REGISTRY['zigzag'].decode(enc.bytes, 'int16', {});
    expect(Array.from(bytesToValues(dec.bytes, 'int16') as Float64Array)).toEqual(values);
  });
  it('isLossy false for signed ints', () => {
    expect(CODEC_REGISTRY['zigzag'].isLossy('int16')).toBe(false);
  });
});

describe('bit-shuffle codec', () => {
  it('round-trips exactly for every multi-byte dtype and elementSize', () => {
    for (const dtype of ['int16', 'int32', 'float32', 'float64'] as const) {
      const values = Array.from({ length: 64 }, (_, i) => i - 32);
      const bytes = valuesToBytes(values, dtype);
      const enc = CODEC_REGISTRY['bit-shuffle'].encode(bytes, dtype, {});
      expect(enc.bytes.length).toBe(bytes.length); // size-preserving
      expect(enc.outputDtype).toBe(dtype);
      const dec = CODEC_REGISTRY['bit-shuffle'].decode(enc.bytes, dtype, {});
      expect(Array.from(dec.bytes)).toEqual(Array.from(bytes));
    }
  });
  it('groups same-position bits: constant data becomes all-0xFF/0x00 planes', () => {
    // 32 identical int16 values of 1 => bit plane 0 is all ones, rest zeros
    const bytes = valuesToBytes(new Array(32).fill(1), 'int16');
    const enc = CODEC_REGISTRY['bit-shuffle'].encode(bytes, 'int16', {});
    const counts = new Map<number, number>();
    for (const b of enc.bytes) counts.set(b, (counts.get(b) ?? 0) + 1);
    // Only two byte values appear (0x00 and 0xFF): perfect plane separation
    expect([...counts.keys()].sort()).toEqual([0, 255]);
  });
  it('handles trailing bytes not filling a whole element block (passes them through)', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]); // int16 stride 2 -> 1 leftover byte
    const enc = CODEC_REGISTRY['bit-shuffle'].encode(bytes, 'int16', {});
    const dec = CODEC_REGISTRY['bit-shuffle'].decode(enc.bytes, 'int16', {});
    expect(Array.from(dec.bytes)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('curation', () => {
  it('registry has the exact curated order (picker order source of truth)', () => {
    const keys = Object.keys(CODEC_REGISTRY);
    const expectOrder = ['delta', 'zigzag', 'byte-shuffle', 'bit-shuffle', 'dictionary', 'rle', 'deflate', 'gzip', 'zstd'];
    expect(keys.filter((k) => expectOrder.includes(k))).toEqual(expectOrder);
  });
  it('lz and blosc are gone', () => {
    expect(CODEC_REGISTRY['lz']).toBeUndefined();
    expect(CODEC_REGISTRY['blosc']).toBeUndefined();
  });
  it('no label contains "(real)"', () => {
    for (const c of Object.values(CODEC_REGISTRY)) expect(c.label).not.toContain('(real)');
  });
});

// ─── isLossy (task 2.6) ────────────────────────────────────────────────
//
// isLossy is a predicate over the *input* dtype (see the comment on
// CodecDefinition.isLossy in src/types/codecs.ts). Delta is a plain modular
// integer transform, so it is exact for every dtype — float and char included,
// where it differences raw bit patterns: meaningless, but reversibly so.

describe('delta codec — isLossy', () => {
  const codec = CODEC_REGISTRY['delta'];

  it('is false for every dtype', () => {
    for (const dtype of ['int8', 'uint8', 'int16', 'uint16', 'int32', 'uint32', 'float32', 'float64', 'char8'] as const) {
      expect(codec.isLossy(dtype)).toBe(false);
    }
  });
});

describe('byte-shuffle codec — isLossy', () => {
  it('is always false (pure byte transposition)', () => {
    const codec = CODEC_REGISTRY['byte-shuffle'];
    for (const dtype of ['int8', 'uint16', 'int32', 'float32', 'float64'] as const) {
      expect(codec.isLossy(dtype)).toBe(false);
    }
  });
});

describe('rle codec — isLossy', () => {
  it('is always false (exact expansion of runs)', () => {
    const codec = CODEC_REGISTRY['rle'];
    for (const dtype of ['int8', 'uint16', 'int32', 'float32', 'float64'] as const) {
      expect(codec.isLossy(dtype)).toBe(false);
    }
  });
});

describe('delta codec', () => {
  const codec = CODEC_REGISTRY['delta'];

  it('computes differences for sorted data', () => {
    const input = valuesToBytes([10, 20, 30, 40], 'int32');
    const result = codec.encode(input, 'int32', { elementSize: 4 });
    const values = bytesToValues(result.bytes, 'int32');
    expect(Array.from(values)).toEqual([10, 10, 10, 10]);
  });

  it('preserves first value', () => {
    const input = valuesToBytes([100, 105, 107], 'int32');
    const result = codec.encode(input, 'int32', { elementSize: 4 });
    const values = bytesToValues(result.bytes, 'int32');
    expect(values[0]).toBe(100);
  });

  it('second-order differencing is just delta twice (why there is no order param)', () => {
    // Values: 0, 1, 4, 9 (squares) → once: 0, 1, 3, 5 → twice: 0, 1, 2, 2
    const input = valuesToBytes([0, 1, 4, 9], 'int32');
    const once = codec.encode(input, 'int32', { elementSize: 4 });
    const twice = codec.encode(once.bytes, once.outputDtype, { elementSize: 4 });
    expect(Array.from(bytesToValues(twice.bytes, 'int32'))).toEqual([0, 1, 2, 2]);
    // …and it reverses by decoding the same number of times.
    const back = codec.decode(codec.decode(twice.bytes, 'int32', { elementSize: 4 }).bytes, 'int32', { elementSize: 4 });
    expect(Array.from(bytesToValues(back.bytes, 'int32'))).toEqual([0, 1, 4, 9]);
  });

  it('identity with all same values', () => {
    const input = valuesToBytes([5, 5, 5, 5], 'int32');
    const result = codec.encode(input, 'int32', { elementSize: 4 });
    const values = bytesToValues(result.bytes, 'int32');
    expect(Array.from(values)).toEqual([5, 0, 0, 0]);
  });

  it('is a plain integer transform on floats: exact roundtrip, garbage values', () => {
    // Differencing IEEE bit patterns, not the numbers — the ⚠ says so, and
    // the point is that it is fully reversible anyway.
    const input = valuesToBytes([1.5, 2.5, 3.5, 4.5], 'float32');
    const encoded = codec.encode(input, 'float32', { elementSize: 4 });
    expect(Array.from(bytesToValues(encoded.bytes, 'float32'))).not.toEqual([1.5, 1, 1, 1]);
    const decoded = codec.decode(encoded.bytes, 'float32', { elementSize: 4 });
    expect(Array.from(decoded.bytes)).toEqual(Array.from(input));
  });
});

describe('byte-shuffle codec', () => {
  const codec = CODEC_REGISTRY['byte-shuffle'];

  it('transposes bytes correctly for 4-byte elements', () => {
    // Two 4-byte elements: [A0 A1 A2 A3] [B0 B1 B2 B3]
    // After shuffle: [A0 B0] [A1 B1] [A2 B2] [A3 B3]
    const input = new Uint8Array([0xa0, 0xa1, 0xa2, 0xa3, 0xb0, 0xb1, 0xb2, 0xb3]);
    const result = codec.encode(input, 'float32', { elementSize: 4 });

    expect(Array.from(result.bytes)).toEqual([
      0xa0, 0xb0, 0xa1, 0xb1, 0xa2, 0xb2, 0xa3, 0xb3,
    ]);
  });

  it('identity for elementSize=1', () => {
    const input = new Uint8Array([1, 2, 3, 4]);
    const result = codec.encode(input, 'uint8', { elementSize: 1 });
    expect(Array.from(result.bytes)).toEqual([1, 2, 3, 4]);
  });

  it('handles empty input', () => {
    const result = codec.encode(new Uint8Array(0), 'float32', { elementSize: 4 });
    expect(result.bytes.length).toBe(0);
  });
});

describe('rle codec', () => {
  const codec = CODEC_REGISTRY['rle'];

  it('compresses runs correctly', () => {
    const input = new Uint8Array([1, 1, 1, 2, 2, 3]);
    const result = codec.encode(input, 'uint8', {});

    // [3, 1, 2, 2, 1, 3]
    expect(Array.from(result.bytes)).toEqual([3, 1, 2, 2, 1, 3]);
    expect(result.outputDtype).toBe('uint8');
  });

  it('handles no runs (all different)', () => {
    const input = new Uint8Array([1, 2, 3, 4]);
    const result = codec.encode(input, 'uint8', {});
    // Each value is a run of 1
    expect(Array.from(result.bytes)).toEqual([1, 1, 1, 2, 1, 3, 1, 4]);
  });

  it('handles max run length of 255', () => {
    const input = new Uint8Array(300).fill(0x42);
    const result = codec.encode(input, 'uint8', {});
    // Should split into [255, 0x42, 45, 0x42]
    expect(result.bytes[0]).toBe(255);
    expect(result.bytes[1]).toBe(0x42);
    expect(result.bytes[2]).toBe(45);
    expect(result.bytes[3]).toBe(0x42);
  });

  it('handles empty input', () => {
    const result = codec.encode(new Uint8Array(0), 'uint8', {});
    expect(result.bytes.length).toBe(0);
  });

  it('handles single byte', () => {
    const result = codec.encode(new Uint8Array([42]), 'uint8', {});
    expect(Array.from(result.bytes)).toEqual([1, 42]);
  });
});

// Per-byte tracing through runCodecPipeline (value-preserving propagation for
// reordering codecs, chunk-level degradation for entropy codecs) is no
// longer computed here — it's derived on demand from the Encoded stage's
// StageLayout (buildEncodedLayout in layout.ts). That behavior is pinned by
// src/__tests__/engine/layout.equivalence.test.ts's ENCODED_CASES (which
// exercises both value-preserving and entropy/chunk-level cases against the
// reference tracer) and unit-tested directly at
// src/__tests__/engine/trace.test.ts (propagateTracesValuePreserving /
// degradeTracesToChunkLevel, now sourced from
// src/__tests__/helpers/referenceTraces.ts).
describe('runCodecPipeline', () => {
  it('runs empty pipeline (identity)', () => {
    const bytes = valuesToBytes([1, 2, 3], 'float32');
    const result = runCodecPipeline(bytes, [], 'float32');

    expect(result.bytes).toEqual(bytes);
    expect(result.outputDtype).toBe('float32');
  });

  it('chains codecs sequentially', () => {
    const bytes = valuesToBytes([100, 200, 300], 'int32');
    const steps: import('../../../src/types/codecs.ts').CodecStep[] = [
      { codec: 'delta', params: {} },
    ];

    const result = runCodecPipeline(bytes, steps, 'int32');
    expect(result.outputDtype).toBe('int32');

    const finalValues = bytesToValues(result.bytes, 'int32');
    expect(Array.from(finalValues)).toEqual([100, 100, 100]);
  });

  it('collapses to uint8 output dtype through entropy codecs', () => {
    const bytes = new Uint8Array([1, 1, 1, 2, 2, 3]);
    const steps: import('../../../src/types/codecs.ts').CodecStep[] = [
      { codec: 'rle', params: {} },
    ];

    const result = runCodecPipeline(bytes, steps, 'uint8');
    expect(result.outputDtype).toBe('uint8');
    expect(Array.from(result.bytes)).toEqual([3, 1, 2, 2, 1, 3]);
  });

  it('skips unknown codecs', () => {
    const bytes = valuesToBytes([1], 'int32');
    const steps: import('../../../src/types/codecs.ts').CodecStep[] = [
      { codec: 'nonexistent', params: {} },
    ];

    const result = runCodecPipeline(bytes, steps, 'int32');
    expect(result.bytes).toEqual(bytes);
  });
});

// ─── F31: per-step enable toggle ─────────────────────────────────────
describe('activeSteps (F31 disabled-step filter)', () => {
  it('absent enabled = enabled', () => {
    const steps: CodecStep[] = [{ codec: 'delta', params: {} }];
    expect(activeSteps(steps)).toEqual(steps);
  });

  it('drops only enabled:false steps', () => {
    const steps: CodecStep[] = [
      { codec: 'delta', params: {}, enabled: true },
      { codec: 'byte-shuffle', params: { elementSize: 4 }, enabled: false },
      { codec: 'zigzag', params: {} },
    ];
    expect(activeSteps(steps).map((s) => s.codec)).toEqual(['delta', 'zigzag']);
  });

  it('a disabled step encodes/decodes/warns identically to omitting it', () => {
    const bytes = valuesToBytes([100, 200, 300], 'int32');
    const withDisabled: CodecStep[] = [
      { codec: 'delta', params: {} },
      { codec: 'byte-shuffle', params: { elementSize: 4 }, enabled: false },
    ];
    const without: CodecStep[] = [{ codec: 'delta', params: {} }];

    const encA = runCodecPipeline(bytes, withDisabled, 'int32');
    const encB = runCodecPipeline(bytes, without, 'int32');
    expect(encA.bytes).toEqual(encB.bytes);
    expect(encA.outputDtype).toBe(encB.outputDtype);

    // Disabled step doesn't collapse the flow dtype to uint8 (pitfall 3).
    expect(encA.outputDtype).toBe('int32');

    const decA = reverseCodecPipeline(encA.bytes, withDisabled, 'int32');
    expect(Array.from(bytesToValues(decA.bytes, 'int32'))).toEqual([100, 200, 300]);

    // A disabled byte-shuffle whose elementSize mismatches must not warn.
    expect(stepWarnings(withDisabled, 'int32')).toEqual(stepWarnings(without, 'int32'));
  });
});

// ─── Decode roundtrip tests ──────────────────────────────────────────

describe('delta decode', () => {
  const codec = CODEC_REGISTRY['delta'];

  it('roundtrips exactly', () => {
    const originalValues = [10, 20, 30, 40];
    const input = valuesToBytes(originalValues, 'int32');
    const encoded = codec.encode(input, 'int32', { elementSize: 4 });
    const decoded = codec.decode(encoded.bytes, encoded.outputDtype, {});
    const values = bytesToValues(decoded.bytes, 'int32');
    expect(Array.from(values)).toEqual(originalValues);
  });

  it('roundtrips every dtype width exactly, including the wrapping edges', () => {
    // The mod-2^N wrap is the whole reason this is lossless on unsigned dtypes:
    // a negative diff must wrap, not clamp (DC-2).
    const cases = [
      ['uint8', 1, [0, 255, 1, 200]],
      ['int8', 1, [-128, 127, -1, 0]],
      ['uint16', 2, [0, 65535, 30000, 1]],
      ['int16', 2, [-32768, 32767, 30000, -30000]],
      ['uint32', 4, [0, 4294967295, 7, 4000000000]],
      ['int32', 4, [-2147483648, 2147483647, 0, -5]],
      ['float64', 8, [1e300, -1e-300, 0, 1.5]],
    ] as const;
    for (const [dtype, elementSize, values] of cases) {
      const input = valuesToBytes([...values], dtype);
      const encoded = codec.encode(input, dtype, { elementSize });
      const decoded = codec.decode(encoded.bytes, encoded.outputDtype, { elementSize });
      expect(Array.from(bytesToValues(decoded.bytes, dtype)), dtype).toEqual([...values]);
    }
  });

  it('roundtrips a byte count that is not a whole number of elements', () => {
    // Trailing partial element copies through untouched.
    const input = new Uint8Array([1, 2, 3, 4, 5]);
    const encoded = codec.encode(input, 'uint16', { elementSize: 2 });
    expect(encoded.bytes[4]).toBe(5);
    const decoded = codec.decode(encoded.bytes, 'uint16', { elementSize: 2 });
    expect(Array.from(decoded.bytes)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('byte-shuffle decode', () => {
  const codec = CODEC_REGISTRY['byte-shuffle'];

  it('roundtrips exactly', () => {
    const input = new Uint8Array([0xa0, 0xa1, 0xa2, 0xa3, 0xb0, 0xb1, 0xb2, 0xb3]);
    const encoded = codec.encode(input, 'float32', { elementSize: 4 });
    const decoded = codec.decode(encoded.bytes, encoded.outputDtype, { elementSize: 4 });
    expect(Array.from(decoded.bytes)).toEqual(Array.from(input));
  });

  it('handles elementSize=1 (identity)', () => {
    const input = new Uint8Array([1, 2, 3, 4]);
    const encoded = codec.encode(input, 'uint8', { elementSize: 1 });
    const decoded = codec.decode(encoded.bytes, encoded.outputDtype, { elementSize: 1 });
    expect(Array.from(decoded.bytes)).toEqual(Array.from(input));
  });

  it('handles empty input', () => {
    const encoded = codec.encode(new Uint8Array(0), 'float32', { elementSize: 4 });
    const decoded = codec.decode(encoded.bytes, encoded.outputDtype, { elementSize: 4 });
    expect(decoded.bytes.length).toBe(0);
  });
});

describe('rle decode', () => {
  const codec = CODEC_REGISTRY['rle'];

  it('roundtrips exactly', () => {
    const input = new Uint8Array([1, 1, 1, 2, 2, 3]);
    const encoded = codec.encode(input, 'uint8', {});
    const decoded = codec.decode(encoded.bytes, encoded.outputDtype, {});
    expect(Array.from(decoded.bytes)).toEqual(Array.from(input));
  });

  it('roundtrips all-different values', () => {
    const input = new Uint8Array([1, 2, 3, 4, 5]);
    const encoded = codec.encode(input, 'uint8', {});
    const decoded = codec.decode(encoded.bytes, encoded.outputDtype, {});
    expect(Array.from(decoded.bytes)).toEqual(Array.from(input));
  });

  it('roundtrips long run (>255)', () => {
    const input = new Uint8Array(300).fill(0x42);
    const encoded = codec.encode(input, 'uint8', {});
    const decoded = codec.decode(encoded.bytes, encoded.outputDtype, {});
    expect(Array.from(decoded.bytes)).toEqual(Array.from(input));
  });

  it('handles empty input', () => {
    const encoded = codec.encode(new Uint8Array(0), 'uint8', {});
    const decoded = codec.decode(encoded.bytes, encoded.outputDtype, {});
    expect(decoded.bytes.length).toBe(0);
  });
});

// ─── applicableTo predicates (task 4.3, UI-4/SW-7) ─────────────────────
//
// Before this task every codec's `applicableTo` was `() => true`, so the
// spec'd ⚠ warning system (docs/design.md "Codec Applicability and
// Warnings") could never fire. These predicates are advisory only — per the
// design doc they never block encode/decode, they only drive UI warnings.

describe('delta codec — applicableTo', () => {
  const codec = CODEC_REGISTRY['delta'];

  // Delta warns on nothing: it is a modular integer transform over elementSize
  // bytes, defined and exactly reversible on any byte stream. The old float and
  // char warnings judged the step's *declared* input dtype, which a preceding
  // Byte Shuffle makes a lie (byte planes, still labelled Float32).
  it('is applicable to every dtype', () => {
    for (const dtype of ['int8', 'uint8', 'int16', 'uint16', 'int32', 'uint32', 'float32', 'float64', 'char4', 'char8', 'char16'] as const) {
      expect(codec.applicableTo(dtype)).toBe(true);
    }
  });

  it('raises no warning after a byte shuffle, where the declared dtype is stale', () => {
    const steps: CodecStep[] = [
      { codec: 'byte-shuffle', params: { elementSize: 4 } },
      { codec: 'delta', params: { elementSize: 1 } },
    ];
    expect(stepWarnings(steps, 'float32')).toEqual([]);
  });
});

describe('byte-shuffle codec — applicableTo', () => {
  const codec = CODEC_REGISTRY['byte-shuffle'];

  it('warns (not applicable) on 1-byte dtypes — shuffling is a no-op', () => {
    for (const dtype of ['int8', 'uint8'] as const) {
      expect(codec.applicableTo(dtype)).toBe(false);
    }
  });

  it('is applicable to every multi-byte dtype', () => {
    for (const dtype of ['int16', 'uint16', 'int32', 'uint32', 'float32', 'float64'] as const) {
      expect(codec.applicableTo(dtype)).toBe(true);
    }
  });
});

describe('rle codec — applicableTo', () => {
  it('is always applicable (byte-wise, no dtype assumptions)', () => {
    const codec = CODEC_REGISTRY['rle'];
    for (const dtype of ['int8', 'uint8', 'int16', 'uint32', 'float32', 'float64'] as const) {
      expect(codec.applicableTo(dtype)).toBe(true);
    }
  });
});

// ─── outputDtypeFor (UI-15) ──────────────────────────────────────────────

describe('outputDtypeFor', () => {
  it('preserves dtype for codecs that leave elements where they were (delta, zigzag)', () => {
    expect(outputDtypeFor(CODEC_REGISTRY['delta'], 'int16', {})).toBe('int16');
    expect(outputDtypeFor(CODEC_REGISTRY['zigzag'], 'int16', {})).toBe('int16');
  });

  it('collapses to uint8 for codecs that destroy element structure (the shuffles)', () => {
    // Not entropy codecs, but their output has no elements in it either: byte
    // planes and bit planes. Reporting float32 here is what made the next
    // step's element size, the ⚠ warnings, and the step's dtype label all lie.
    expect(outputDtypeFor(CODEC_REGISTRY['byte-shuffle'], 'float32', {})).toBe('uint8');
    expect(outputDtypeFor(CODEC_REGISTRY['bit-shuffle'], 'float32', {})).toBe('uint8');
  });

  it('collapses to uint8 for entropy codecs (rle, gzip)', () => {
    expect(outputDtypeFor(CODEC_REGISTRY['rle'], 'int32', {})).toBe('uint8');
    expect(outputDtypeFor(CODEC_REGISTRY['gzip'], 'float64', {})).toBe('uint8');
  });
});

// ─── stepWarnings (task 4.3, UI-4/SW-7) ──────────────────────────────────
//
// Single source of truth shared by CodecPipelineEditor (per-step ⚠) and
// PipelineStrip (Encoded-stage ⚠) — see engine/codecs.ts.

describe('stepWarnings', () => {
  it('returns no warnings for an empty pipeline', () => {
    expect(stepWarnings([], 'float32')).toEqual([]);
  });

  it('returns no warnings for integer delta (humidity-style uint dtype)', () => {
    const steps: CodecStep[] = [{ codec: 'delta', params: {} }];
    expect(stepWarnings(steps, 'uint16')).toEqual([]);
  });

  it('does not warn for delta on any dtype', () => {
    const steps: CodecStep[] = [{ codec: 'delta', params: { elementSize: 4 } }];
    expect(stepWarnings(steps, 'float32')).toEqual([]);
    expect(stepWarnings(steps, 'char8')).toEqual([]);
  });

  it('warns for byte-shuffle on a 1-byte dtype', () => {
    const steps: CodecStep[] = [{ codec: 'byte-shuffle', params: { elementSize: 1 } }];
    const warnings = stepWarnings(steps, 'uint8');
    expect(warnings.some((w) => /not applicable/i.test(w))).toBe(true);
  });

  it('warns when byte-shuffle elementSize does not match the input dtype size', () => {
    const steps: CodecStep[] = [{ codec: 'byte-shuffle', params: { elementSize: 3 } }];
    const warnings = stepWarnings(steps, 'float32'); // float32 is 4 bytes
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Element size 3 doesn't match dtype size 4");
  });

  it('does not warn when byte-shuffle elementSize matches the input dtype size', () => {
    const steps: CodecStep[] = [{ codec: 'byte-shuffle', params: { elementSize: 4 } }];
    expect(stepWarnings(steps, 'float32')).toEqual([]);
  });

  it('can raise both an applicability warning and a param-mismatch warning at once', () => {
    // 1-byte dtype (not applicable to shuffle at all) AND elementSize != 1.
    const steps: CodecStep[] = [{ codec: 'byte-shuffle', params: { elementSize: 4 } }];
    const warnings = stepWarnings(steps, 'uint8');
    expect(warnings).toHaveLength(2);
  });

  it('tracks dtype flow through the pipeline when checking later steps', () => {
    // delta (uint16 -> uint16) then rle (-> uint8): rle has no dtype-specific
    // applicability, so no warning should appear regardless of the dtype it
    // receives.
    const steps: CodecStep[] = [
      { codec: 'delta', params: {} },
      { codec: 'rle', params: {} },
    ];
    expect(stepWarnings(steps, 'uint16')).toEqual([]);
  });

  it('warns per-step, not just for the first offending step', () => {
    const steps: CodecStep[] = [
      { codec: 'zigzag', params: {} }, // uint8 is not signed -> warns
      { codec: 'byte-shuffle', params: { elementSize: 4 } }, // 1-byte dtype -> warns twice (applicability + mismatch)
    ];
    const warnings = stepWarnings(steps, 'uint8');
    expect(warnings).toHaveLength(3);
  });

  it('ignores unknown codec keys', () => {
    const steps: CodecStep[] = [{ codec: 'nonexistent', params: {} }];
    expect(stepWarnings(steps, 'float32')).toEqual([]);
  });
});

describe('shannonEntropy', () => {
  it('returns 0 for empty input', () => {
    expect(shannonEntropy(new Uint8Array(0))).toBe(0);
  });

  it('returns 0 for uniform data', () => {
    expect(shannonEntropy(new Uint8Array(100).fill(42))).toBe(0);
  });

  it('returns 1 for two equally frequent values', () => {
    const data = new Uint8Array(100);
    for (let i = 0; i < 50; i++) data[i] = 0;
    for (let i = 50; i < 100; i++) data[i] = 1;
    expect(shannonEntropy(data)).toBeCloseTo(1.0, 5);
  });

  it('returns 8 for uniformly distributed bytes', () => {
    const data = new Uint8Array(256);
    for (let i = 0; i < 256; i++) data[i] = i;
    expect(shannonEntropy(data)).toBeCloseTo(8.0, 5);
  });

  it('returns value between 0 and 8', () => {
    const data = new Uint8Array([1, 2, 3, 1, 2, 3, 1, 1]);
    const e = shannonEntropy(data);
    expect(e).toBeGreaterThan(0);
    expect(e).toBeLessThanOrEqual(8);
  });
});

describe('codecs on charN input', () => {
  const words = ['Nairobi', 'Nairobi', 'Nairobi', 'Osaka', 'Osaka', 'Lima'];
  const charBytes = valuesToBytes(words, 'char8');

  it('RLE roundtrips char8 bytes exactly', () => {
    const rle = CODEC_REGISTRY['rle'];
    const encoded = rle.encode(charBytes, 'char8', {});
    expect(encoded.outputDtype).toBe('uint8');
    const decoded = rle.decode(encoded.bytes, 'uint8', {});
    expect(Array.from(decoded.bytes)).toEqual(Array.from(charBytes));
    expect(bytesToValues(decoded.bytes, 'char8')).toEqual(words);
  });

  it('RLE shrinks padding-dominated text chunks (short words in a wide char dtype)', () => {
    // Byte-level RLE can't exploit repeated multi-byte words (no same-byte
    // runs — that's LZ's win); its text payoff is runs of space padding.
    const repeated = valuesToBytes(new Array(32).fill('Lima'), 'char16');
    const encoded = CODEC_REGISTRY['rle'].encode(repeated, 'char16', {});
    expect(encoded.bytes.length).toBeLessThan(repeated.length);
  });

  it('delta on char input differences the raw bytes and roundtrips exactly', () => {
    const delta = CODEC_REGISTRY['delta'];
    const encoded = delta.encode(charBytes, 'char8', {});
    // Dtype is preserved (delta is not an entropy codec)...
    expect(encoded.outputDtype).toBe('char8');
    // ...and the encoded bytes are NOT the input (the transform actually ran).
    expect(Array.from(encoded.bytes)).not.toEqual(Array.from(charBytes));
    const decoded = delta.decode(encoded.bytes, 'char8', {});
    expect(Array.from(decoded.bytes)).toEqual(Array.from(charBytes));
    expect(bytesToValues(decoded.bytes, 'char8')).toEqual(words);
  });

  it('delta-on-char roundtrips through runCodecPipeline + reverseCodecPipeline dtype flow', () => {
    const steps: CodecStep[] = [{ codec: 'delta', params: {} }];
    const result = runCodecPipeline(charBytes, steps, 'char8');
    expect(result.outputDtype).toBe('char8');
    const decoded = CODEC_REGISTRY['delta'].decode(result.bytes, 'char8', {});
    expect(Array.from(decoded.bytes)).toEqual(Array.from(charBytes));
  });

  it('byte-shuffle accepts elementSize 16 (char16) and roundtrips', () => {
    expect(CODEC_REGISTRY['byte-shuffle'].params.elementSize.max).toBe(16);
    const bytes = valuesToBytes(['Dar es Salaam', 'Kuala Lumpur'], 'char16');
    const shuffle = CODEC_REGISTRY['byte-shuffle'];
    const encoded = shuffle.encode(bytes, 'char16', { elementSize: 16 });
    const decoded = shuffle.decode(encoded.bytes, 'char16', { elementSize: 16 });
    expect(Array.from(decoded.bytes)).toEqual(Array.from(bytes));
  });

  it('stepWarnings is silent for delta on char dtypes', () => {
    const steps: CodecStep[] = [{ codec: 'delta', params: { elementSize: 8 } }];
    expect(stepWarnings(steps, 'char8')).toEqual([]);
  });

  it('stepWarnings flags byte-shuffle elementSize mismatch against char16', () => {
    const steps: CodecStep[] = [{ codec: 'byte-shuffle', params: { elementSize: 8 } }];
    const warnings = stepWarnings(steps, 'char16');
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/doesn't match dtype size 16/);
  });

  it('stepWarnings is clean for RLE/matched-shuffle on char dtypes', () => {
    const steps: CodecStep[] = [
      { codec: 'byte-shuffle', params: { elementSize: 8 } },
      { codec: 'rle', params: {} },
    ];
    expect(stepWarnings(steps, 'char8')).toEqual([]);
  });
});

describe('codec metadata & dtype flow', () => {
  it('every codec declares a sizeEffect', () => {
    for (const codec of Object.values(CODEC_REGISTRY)) {
      expect(['preserving', 'fixed-ratio', 'variable']).toContain(codec.sizeEffect);
    }
  });
  it('entropy codecs are variable-size; reordering codecs preserve size', () => {
    expect(CODEC_REGISTRY['rle'].sizeEffect).toBe('variable');
    expect(CODEC_REGISTRY['zstd'].sizeEffect).toBe('variable');
    expect(CODEC_REGISTRY['dictionary'].sizeEffect).toBe('variable');
    expect(CODEC_REGISTRY['delta'].sizeEffect).toBe('preserving');
    expect(CODEC_REGISTRY['byte-shuffle'].sizeEffect).toBe('preserving');
  });
  it('outputDtypeFor takes params and defers to a codec-declared outputDtype', () => {
    // no codec declares outputDtype yet: rule matches the old behavior
    expect(outputDtypeFor(CODEC_REGISTRY['delta'], 'int16', {})).toBe('int16');
    expect(outputDtypeFor(CODEC_REGISTRY['rle'], 'int16', {})).toBe('uint8');
    expect(outputDtypeFor(CODEC_REGISTRY['byte-shuffle'], 'float32', {})).toBe('uint8');
  });
  it('pipelineOutputDtype walks active steps', () => {
    const steps = [
      { codec: 'delta', params: {} },
      { codec: 'rle', params: {}, enabled: false },
    ];
    expect(pipelineOutputDtype(steps, 'int16')).toBe('int16');
    expect(pipelineOutputDtype([{ codec: 'rle', params: {} }], 'int16')).toBe('uint8');
  });
  it('encodedByteLength: preserving keeps length, variable returns null', () => {
    expect(encodedByteLength([{ codec: 'delta', params: {} }], 'int16', 64)).toBe(64);
    expect(encodedByteLength([{ codec: 'rle', params: {} }], 'int16', 64)).toBeNull();
    expect(encodedByteLength([], 'float64', 80)).toBe(80);
    // disabled variable-size step is inert
    expect(encodedByteLength([{ codec: 'rle', params: {}, enabled: false }], 'int16', 64)).toBe(64);
  });
  it('runCodecPipeline and reverseCodecPipeline forward byteOrder to the codec', () => {
    const seen: string[] = [];
    const probe: CodecDefinition = {
      key: 'probe', label: 'Probe', category: 'reordering', sizeEffect: 'preserving',
      description: '', params: {}, applicableTo: () => true, isLossy: () => false,
      encode: (bytes, dt, _p, bo) => { seen.push(`enc:${bo}`); return { bytes, outputDtype: dt }; },
      decode: (bytes, dt, _p, bo) => { seen.push(`dec:${bo}`); return { bytes, outputDtype: dt }; },
    };
    CODEC_REGISTRY['probe'] = probe;
    try {
      runCodecPipeline(new Uint8Array(4), [{ codec: 'probe', params: {} }], 'int16', 'big');
      reverseCodecPipeline(new Uint8Array(4), [{ codec: 'probe', params: {} }], 'int16', 'big');
      expect(seen).toEqual(['enc:big', 'dec:big']);
    } finally { delete CODEC_REGISTRY['probe']; }
  });
});
