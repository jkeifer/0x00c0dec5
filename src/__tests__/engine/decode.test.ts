import { describe, it, expect } from 'vitest';
import { reverseCodecPipeline } from '../../engine/decode.ts';
import { runCodecPipeline } from '../../engine/codecs.ts';
import { valuesToBytes, bytesToValues } from '../../engine/elements.ts';
import type { CodecStep } from '../../types/codecs.ts';
import type { ByteTrace } from '../../types/pipeline.ts';

function makeTraces(byteCount: number): ByteTrace[] {
  return Array.from({ length: byteCount }, (_, i) => ({
    traceId: `var:${Math.floor(i / 4)}`,
    variableName: 'var',
    variableColor: '#f00',
    coords: [Math.floor(i / 4)],
    displayValue: '0',
    dtype: 'float32',
    chunkId: 'chunk:0',
    byteInValue: i % 4,
    byteCount: 4,
  }));
}

describe('reverseCodecPipeline', () => {
  it('empty pipeline is identity', () => {
    const input = valuesToBytes([1, 2, 3], 'float32');
    const result = reverseCodecPipeline(input, [], 'float32');
    expect(bytesToValues(result.bytes, 'float32')).toEqual([1, 2, 3]);
    expect(result.outputDtype).toBe('float32');
  });

  it('reverses single delta codec exactly', () => {
    const originalValues = [10, 20, 30, 40];
    const input = valuesToBytes(originalValues, 'int32');
    const steps: CodecStep[] = [{ codec: 'delta', params: { order: 1 } }];
    const encoded = runCodecPipeline(input, makeTraces(input.length), steps, 'int32');

    const decoded = reverseCodecPipeline(encoded.bytes, steps, 'int32');
    const values = bytesToValues(decoded.bytes, decoded.outputDtype as 'int32');
    expect(values).toEqual(originalValues);
  });

  it('reverses single byte-shuffle codec exactly', () => {
    const input = new Uint8Array([0xa0, 0xa1, 0xa2, 0xa3, 0xb0, 0xb1, 0xb2, 0xb3]);
    const steps: CodecStep[] = [{ codec: 'byte-shuffle', params: { elementSize: 4 } }];
    const encoded = runCodecPipeline(input, makeTraces(input.length), steps, 'float32');

    const decoded = reverseCodecPipeline(encoded.bytes, steps, 'float32');
    expect(Array.from(decoded.bytes)).toEqual(Array.from(input));
  });

  it('reverses single RLE codec exactly', () => {
    const input = new Uint8Array([1, 1, 1, 2, 2, 3]);
    const steps: CodecStep[] = [{ codec: 'rle', params: {} }];
    const encoded = runCodecPipeline(input, makeTraces(input.length), steps, 'uint8');

    const decoded = reverseCodecPipeline(encoded.bytes, steps, 'uint8');
    expect(Array.from(decoded.bytes)).toEqual(Array.from(input));
  });

  it('reverses multi-codec pipeline (delta + byte-shuffle + rle)', () => {
    const originalValues = [10, 20, 30, 40, 50, 60, 70, 80];
    const input = valuesToBytes(originalValues, 'int32');
    const steps: CodecStep[] = [
      { codec: 'delta', params: { order: 1 } },
      { codec: 'byte-shuffle', params: { elementSize: 4 } },
      { codec: 'rle', params: {} },
    ];
    const encoded = runCodecPipeline(input, makeTraces(input.length), steps, 'int32');

    const decoded = reverseCodecPipeline(encoded.bytes, steps, 'int32');
    const values = bytesToValues(decoded.bytes, decoded.outputDtype as 'int32');
    expect(values).toEqual(originalValues);
  });

  it('skips unknown codecs gracefully', () => {
    const input = valuesToBytes([1, 2, 3], 'int32');
    const steps: CodecStep[] = [{ codec: 'nonexistent', params: {} }];
    const result = reverseCodecPipeline(input, steps, 'int32');
    expect(bytesToValues(result.bytes, 'int32')).toEqual([1, 2, 3]);
  });
});
