import { describe, it, expect } from 'vitest';
import { reverseCodecPipeline } from '../../../src/engine/decode.ts';
import { runCodecPipeline } from '../../../src/engine/codecs.ts';
import { valuesToBytes, bytesToValues } from '../../../src/engine/elements.ts';
import type { CodecStep } from '../../../src/types/codecs.ts';

describe('reverseCodecPipeline', () => {
  it('empty pipeline is identity', () => {
    const input = valuesToBytes([1, 2, 3], 'float32');
    const result = reverseCodecPipeline(input, [], 'float32');
    expect(Array.from(bytesToValues(result.bytes, 'float32'))).toEqual([1, 2, 3]);
    expect(result.outputDtype).toBe('float32');
  });

  it('reverses single delta codec exactly', () => {
    const originalValues = [10, 20, 30, 40];
    const input = valuesToBytes(originalValues, 'int32');
    const steps: CodecStep[] = [{ codec: 'delta', params: {} }];
    const encoded = runCodecPipeline(input, steps, 'int32');

    const decoded = reverseCodecPipeline(encoded.bytes, steps, 'int32');
    const values = bytesToValues(decoded.bytes, decoded.outputDtype as 'int32');
    expect(Array.from(values)).toEqual(originalValues);
  });

  it('reverses single byte-shuffle codec exactly', () => {
    const input = new Uint8Array([0xa0, 0xa1, 0xa2, 0xa3, 0xb0, 0xb1, 0xb2, 0xb3]);
    const steps: CodecStep[] = [{ codec: 'byte-shuffle', params: { elementSize: 4 } }];
    const encoded = runCodecPipeline(input, steps, 'float32');

    const decoded = reverseCodecPipeline(encoded.bytes, steps, 'float32');
    expect(Array.from(decoded.bytes)).toEqual(Array.from(input));
  });

  it('reverses single RLE codec exactly', () => {
    const input = new Uint8Array([1, 1, 1, 2, 2, 3]);
    const steps: CodecStep[] = [{ codec: 'rle', params: {} }];
    const encoded = runCodecPipeline(input, steps, 'uint8');

    const decoded = reverseCodecPipeline(encoded.bytes, steps, 'uint8');
    expect(Array.from(decoded.bytes)).toEqual(Array.from(input));
  });

  it('reverses multi-codec pipeline (delta + byte-shuffle + rle)', () => {
    const originalValues = [10, 20, 30, 40, 50, 60, 70, 80];
    const input = valuesToBytes(originalValues, 'int32');
    const steps: CodecStep[] = [
      { codec: 'delta', params: {} },
      { codec: 'byte-shuffle', params: { elementSize: 4 } },
      { codec: 'rle', params: {} },
    ];
    const encoded = runCodecPipeline(input, steps, 'int32');

    const decoded = reverseCodecPipeline(encoded.bytes, steps, 'int32');
    const values = bytesToValues(decoded.bytes, decoded.outputDtype as 'int32');
    expect(Array.from(values)).toEqual(originalValues);
  });

  it('skips unknown codecs gracefully', () => {
    const input = valuesToBytes([1, 2, 3], 'int32');
    const steps: CodecStep[] = [{ codec: 'nonexistent', params: {} }];
    const result = reverseCodecPipeline(input, steps, 'int32');
    expect(Array.from(bytesToValues(result.bytes, 'int32'))).toEqual([1, 2, 3]);
  });
});

// The dtype flow across a shuffle is uint8, and `reverseCodecPipeline` builds
// its chain from `outputDtypeFor`. These pin the two ways that could break:
// a codec that reads its geometry off the declared dtype (Bit Shuffle used to),
// and a chain whose backward dtypes must match the forward ones step for step.
describe('reverseCodecPipeline across structure-destroying codecs', () => {
  const original = valuesToBytes([1000, -2000, 3000, -4000, 5000, 6000], 'int16');

  const pipelines: [string, CodecStep[]][] = [
    ['[byte-shuffle]', [{ codec: 'byte-shuffle', params: { elementSize: 2 } }]],
    ['[bit-shuffle]', [{ codec: 'bit-shuffle', params: { elementSize: 2 } }]],
    // Delta AFTER a shuffle is the arrangement the whole dtype fix is about:
    // the bytes are byte planes, so the honest element size is 1.
    ['[byte-shuffle, delta@1]', [
      { codec: 'byte-shuffle', params: { elementSize: 2 } },
      { codec: 'delta', params: { elementSize: 1 } },
    ]],
    ['[delta@2, byte-shuffle, rle]', [
      { codec: 'delta', params: { elementSize: 2 } },
      { codec: 'byte-shuffle', params: { elementSize: 2 } },
      { codec: 'rle', params: {} },
    ]],
    ['[bit-shuffle, delta@1, zstd-less chain]', [
      { codec: 'bit-shuffle', params: { elementSize: 2 } },
      { codec: 'delta', params: { elementSize: 1 } },
      { codec: 'dictionary', params: {} },
    ]],
  ];

  for (const [label, steps] of pipelines) {
    it(`round-trips ${label} back to int16 bytes`, () => {
      const encoded = runCodecPipeline(original, steps, 'int16');
      const reversed = reverseCodecPipeline(encoded.bytes, steps, 'int16');
      expect(Array.from(reversed.bytes), label).toEqual(Array.from(original));
      expect(reversed.outputDtype, label).toBe('int16');
    });
  }
});
