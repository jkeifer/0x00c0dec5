import { describe, it, expect } from 'vitest';
import { CODEC_REGISTRY, runCodecPipeline, shannonEntropy } from '../../engine/codecs.ts';
import { valuesToBytes, bytesToValues } from '../../engine/elements.ts';
import { isChunkLevelTrace } from '../../engine/trace.ts';
import type { ByteTrace } from '../../types/pipeline.ts';

function makeSimpleTraces(byteCount: number, chunkId: string = 'chunk:0'): ByteTrace[] {
  return Array.from({ length: byteCount }, (_, i) => ({
    traceId: `var:${Math.floor(i / 4)}`,
    variableName: 'var',
    variableColor: '#f00',
    coords: [Math.floor(i / 4)],
    displayValue: '0',
    dtype: 'float32',
    chunkId,
    byteInValue: i % 4,
    byteCount: 4,
  }));
}

describe('codec registry', () => {
  it('contains only delta, byte-shuffle, rle, lz', () => {
    const keys = Object.keys(CODEC_REGISTRY).sort();
    expect(keys).toEqual(['byte-shuffle', 'delta', 'lz', 'rle']);
  });

  it('does not contain scale-offset or bitround', () => {
    expect(CODEC_REGISTRY['scale-offset']).toBeUndefined();
    expect(CODEC_REGISTRY['bitround']).toBeUndefined();
  });
});

describe('delta codec', () => {
  const codec = CODEC_REGISTRY['delta'];

  it('computes differences for sorted data', () => {
    const input = valuesToBytes([10, 20, 30, 40], 'int32');
    const result = codec.encode(input, 'int32', { order: 1 });
    const values = bytesToValues(result.bytes, 'int32');
    expect(values).toEqual([10, 10, 10, 10]);
  });

  it('preserves first value', () => {
    const input = valuesToBytes([100, 105, 107], 'int32');
    const result = codec.encode(input, 'int32', { order: 1 });
    const values = bytesToValues(result.bytes, 'int32');
    expect(values[0]).toBe(100);
  });

  it('handles order 2', () => {
    // Values: 0, 1, 4, 9 (squares)
    // After order 1: 0, 1, 3, 5
    // After order 2: 0, 1, 2, 2
    const input = valuesToBytes([0, 1, 4, 9], 'int32');
    const result = codec.encode(input, 'int32', { order: 2 });
    const values = bytesToValues(result.bytes, 'int32');
    expect(values).toEqual([0, 1, 2, 2]);
  });

  it('identity with all same values', () => {
    const input = valuesToBytes([5, 5, 5, 5], 'int32');
    const result = codec.encode(input, 'int32', { order: 1 });
    const values = bytesToValues(result.bytes, 'int32');
    expect(values).toEqual([5, 0, 0, 0]);
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

describe('lz codec', () => {
  const codec = CODEC_REGISTRY['lz'];

  it('finds back-references for repeated patterns', () => {
    // "ABCABC" → literals for first 3, then a match for the second 3
    const input = new Uint8Array([65, 66, 67, 65, 66, 67]);
    const result = codec.encode(input, 'uint8', { windowSize: 256 });

    // First 3 bytes are literals: [0x00, 65, 0x00, 66, 0x00, 67]
    // Then match length=3, offset=3: [3, 0, 3]
    expect(result.bytes[0]).toBe(0x00); // literal
    expect(result.bytes[1]).toBe(65);
    expect(result.bytes[6]).toBe(3); // match length
    expect(result.bytes[8]).toBe(3); // match offset low byte
    expect(result.outputDtype).toBe('uint8');
  });

  it('handles empty input', () => {
    const result = codec.encode(new Uint8Array(0), 'uint8', { windowSize: 256 });
    expect(result.bytes.length).toBe(0);
  });

  it('handles all unique bytes (no matches)', () => {
    const input = new Uint8Array([1, 2, 3, 4, 5]);
    const result = codec.encode(input, 'uint8', { windowSize: 256 });
    // All literals: [0x00, 1, 0x00, 2, ...]
    expect(result.bytes.length).toBe(10);
    for (let i = 0; i < 5; i++) {
      expect(result.bytes[i * 2]).toBe(0x00);
      expect(result.bytes[i * 2 + 1]).toBe(input[i]);
    }
  });
});

describe('runCodecPipeline', () => {
  it('runs empty pipeline (identity)', () => {
    const bytes = valuesToBytes([1, 2, 3], 'float32');
    const traces = makeSimpleTraces(bytes.length);
    const result = runCodecPipeline(bytes, traces, [], 'float32');

    expect(result.bytes).toEqual(bytes);
    expect(result.traces).toEqual(traces);
    expect(result.stages).toHaveLength(0);
    expect(result.outputDtype).toBe('float32');
  });

  it('chains codecs sequentially', () => {
    const bytes = valuesToBytes([100, 200, 300], 'int32');
    const traces = makeSimpleTraces(bytes.length);
    const steps: import('../../types/codecs.ts').CodecStep[] = [
      { codec: 'delta', params: { order: 1 } },
    ];

    const result = runCodecPipeline(bytes, traces, steps, 'int32');
    expect(result.stages).toHaveLength(1);
    expect(result.outputDtype).toBe('int32');

    const finalValues = bytesToValues(result.bytes, 'int32');
    expect(finalValues).toEqual([100, 100, 100]);
  });

  it('preserves traces through mapping/reordering codecs', () => {
    const bytes = valuesToBytes([1, 2, 3], 'int32');
    const traces = makeSimpleTraces(bytes.length);
    const steps: import('../../types/codecs.ts').CodecStep[] = [
      { codec: 'delta', params: { order: 1 } },
    ];

    const result = runCodecPipeline(bytes, traces, steps, 'int32');
    // Traces should be preserved (same count, not chunk-level)
    expect(result.traces.length).toBe(bytes.length);
    for (const t of result.traces) {
      expect(isChunkLevelTrace(t.traceId)).toBe(false);
    }
  });

  it('degrades traces through entropy codecs', () => {
    const bytes = new Uint8Array([1, 1, 1, 2, 2, 3]);
    const traces = makeSimpleTraces(bytes.length, 'chunk:0');
    const steps: import('../../types/codecs.ts').CodecStep[] = [
      { codec: 'rle', params: {} },
    ];

    const result = runCodecPipeline(bytes, traces, steps, 'uint8');
    for (const t of result.traces) {
      expect(isChunkLevelTrace(t.traceId)).toBe(true);
    }
  });

  it('skips unknown codecs', () => {
    const bytes = valuesToBytes([1], 'int32');
    const traces = makeSimpleTraces(bytes.length);
    const steps: import('../../types/codecs.ts').CodecStep[] = [
      { codec: 'nonexistent', params: {} },
    ];

    const result = runCodecPipeline(bytes, traces, steps, 'int32');
    expect(result.bytes).toEqual(bytes);
  });
});

// ─── Decode roundtrip tests ──────────────────────────────────────────

describe('delta decode', () => {
  const codec = CODEC_REGISTRY['delta'];

  it('roundtrips exactly (order 1)', () => {
    const originalValues = [10, 20, 30, 40];
    const input = valuesToBytes(originalValues, 'int32');
    const encoded = codec.encode(input, 'int32', { order: 1 });
    const decoded = codec.decode(encoded.bytes, encoded.outputDtype, { order: 1 });
    const values = bytesToValues(decoded.bytes, 'int32');
    expect(values).toEqual(originalValues);
  });

  it('roundtrips exactly (order 2)', () => {
    const originalValues = [0, 1, 4, 9];
    const input = valuesToBytes(originalValues, 'int32');
    const encoded = codec.encode(input, 'int32', { order: 2 });
    const decoded = codec.decode(encoded.bytes, encoded.outputDtype, { order: 2 });
    const values = bytesToValues(decoded.bytes, 'int32');
    expect(values).toEqual(originalValues);
  });

  it('roundtrips float values', () => {
    const originalValues = [1.5, 2.5, 3.5, 4.5];
    const input = valuesToBytes(originalValues, 'float32');
    const encoded = codec.encode(input, 'float32', { order: 1 });
    const decoded = codec.decode(encoded.bytes, encoded.outputDtype, { order: 1 });
    const values = bytesToValues(decoded.bytes, 'float32');
    for (let i = 0; i < originalValues.length; i++) {
      expect(values[i]).toBeCloseTo(originalValues[i], 5);
    }
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

describe('lz decode', () => {
  const codec = CODEC_REGISTRY['lz'];

  it('roundtrips repeated pattern', () => {
    const input = new Uint8Array([65, 66, 67, 65, 66, 67]);
    const encoded = codec.encode(input, 'uint8', { windowSize: 256 });
    const decoded = codec.decode(encoded.bytes, encoded.outputDtype, { windowSize: 256 });
    expect(Array.from(decoded.bytes)).toEqual(Array.from(input));
  });

  it('roundtrips all unique bytes', () => {
    const input = new Uint8Array([1, 2, 3, 4, 5]);
    const encoded = codec.encode(input, 'uint8', { windowSize: 256 });
    const decoded = codec.decode(encoded.bytes, encoded.outputDtype, { windowSize: 256 });
    expect(Array.from(decoded.bytes)).toEqual(Array.from(input));
  });

  it('handles empty input', () => {
    const encoded = codec.encode(new Uint8Array(0), 'uint8', { windowSize: 256 });
    const decoded = codec.decode(encoded.bytes, encoded.outputDtype, { windowSize: 256 });
    expect(decoded.bytes.length).toBe(0);
  });

  it('roundtrips longer data with multiple matches', () => {
    const pattern = [10, 20, 30, 40, 50];
    const input = new Uint8Array([...pattern, ...pattern, ...pattern, 99, 98, 97]);
    const encoded = codec.encode(input, 'uint8', { windowSize: 256 });
    const decoded = codec.decode(encoded.bytes, encoded.outputDtype, { windowSize: 256 });
    expect(Array.from(decoded.bytes)).toEqual(Array.from(input));
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
