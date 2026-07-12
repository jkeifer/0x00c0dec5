import { describe, it, expect } from 'vitest';
import { CODEC_REGISTRY, runCodecPipeline } from '../../../src/engine/codecs.ts';
import { reverseCodecPipeline } from '../../../src/engine/decode.ts';
import { valuesToBytes } from '../../../src/engine/elements.ts';

const dict = () => CODEC_REGISTRY['dictionary'];

describe('dictionary codec', () => {
  it('is an entropy codec applicable to everything', () => {
    expect(dict().category).toBe('entropy');
    expect(dict().applicableTo('float64')).toBe(true);
    expect(dict().isLossy('int16')).toBe(false);
  });
  it('low-cardinality data shrinks; format fields are as specified', () => {
    const values = Array.from({ length: 1000 }, (_, i) => [10, 20, 30][i % 3]);
    const bytes = valuesToBytes(values, 'int32'); // 4000 bytes
    const enc = dict().encode(bytes, 'int32', {});
    expect(enc.outputDtype).toBe('uint8');
    // header: stride=4, dictCount=3, indexWidth=1 -> 1+4+12+1+1000 = 1018
    expect(enc.bytes.length).toBe(1018);
    expect(enc.bytes[0]).toBe(4); // stride
    expect(new DataView(enc.bytes.buffer, enc.bytes.byteOffset).getUint32(1, true)).toBe(3);
    expect(enc.bytes[17]).toBe(1); // indexWidth after 12 dict bytes
  });
  it('round-trips exactly for every fixed-stride dtype including charN', () => {
    for (const [dtype, vals] of [
      ['int16', [5, -5, 5, 5, -5, 100]],
      ['float64', [1.5, 2.5, 1.5, NaN, 2.5, 1.5]], // NaN: byte-level dedup, still exact
      ['char4', ['ab', 'cd', 'ab', '', 'cd', 'ab']],
    ] as const) {
      const bytes = valuesToBytes(vals as never, dtype as never);
      const enc = dict().encode(bytes, dtype as string, {});
      const dec = dict().decode(enc.bytes, dtype as string, {});
      expect(Array.from(dec.bytes), dtype as string).toEqual(Array.from(bytes));
    }
  });
  it('promotes indexWidth for >255 and >65535 distinct values', () => {
    const many = Array.from({ length: 300 }, (_, i) => i);
    const enc = dict().encode(valuesToBytes(many, 'int32'), 'int32', {});
    const stride = enc.bytes[0];
    const dictCount = new DataView(enc.bytes.buffer, enc.bytes.byteOffset).getUint32(1, true);
    expect(dictCount).toBe(300);
    expect(enc.bytes[1 + 4 + dictCount * stride]).toBe(2); // u16 indices
    const dec = dict().decode(enc.bytes, 'int32', {});
    expect(Array.from(dec.bytes)).toEqual(Array.from(valuesToBytes(many, 'int32')));
  });
  it('handles empty input', () => {
    const enc = dict().encode(new Uint8Array(0), 'int32', {});
    const dec = dict().decode(enc.bytes, 'int32', {});
    expect(dec.bytes.length).toBe(0);
  });
  it('composes: dictionary -> zstd would decode via reverseCodecPipeline (decode side dtype flow)', () => {
    const values = Array.from({ length: 256 }, (_, i) => [7, 8][i % 2]);
    const input = valuesToBytes(values, 'int16');
    const steps = [{ codec: 'dictionary', params: {} }];
    const enc = runCodecPipeline(input, steps, 'int16');
    const dec = reverseCodecPipeline(enc.bytes, steps, 'int16');
    expect(dec.outputDtype).toBe('int16');
    expect(Array.from(dec.bytes)).toEqual(Array.from(input));
  });
});
