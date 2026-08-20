import { describe, it, expect } from 'vitest';
import { CODEC_REGISTRY, runCodecPipeline } from '../../../src/engine/codecs.ts';
import { reverseCodecPipeline } from '../../../src/engine/decode.ts';
import { valuesToBytes, bytesToValues } from '../../../src/engine/elements.ts';

describe('quantize', () => {
  const q = CODEC_REGISTRY['quantize'];
  it('rounds float64 values to N decimal digits in place', () => {
    const bytes = valuesToBytes(Float64Array.from([1.2345, -2.71828, 3.0]), 'float64');
    const { bytes: out, outputDtype, stats } = q.encode(bytes, 'float64', { digits: 2 });
    expect(outputDtype).toBe('float64');
    expect(Array.from(bytesToValues(out, 'float64') as Float64Array)).toEqual([1.23, -2.72, 3]);
    expect(stats).toEqual({ clipped: 0, rounded: 2 });
  });
  it('decode is identity (irrecoverable)', () => {
    const bytes = valuesToBytes(Float64Array.from([1.23]), 'float64');
    expect(q.decode(bytes, 'float64', { digits: 2 }).bytes).toEqual(bytes);
  });
  it('honors byteOrder', () => {
    const be = valuesToBytes(Float64Array.from([1.2345]), 'float64', 'big');
    const { bytes: out } = q.encode(be, 'float64', { digits: 1 }, 'big');
    expect((bytesToValues(out, 'float64', 'big') as Float64Array)[0]).toBeCloseTo(1.2, 10);
  });
  it('skips NaN without counting it rounded', () => {
    const bytes = valuesToBytes(Float64Array.from([NaN, 1.25]), 'float64');
    const { stats } = q.encode(bytes, 'float64', { digits: 1 });
    expect(stats).toEqual({ clipped: 0, rounded: 1 });
  });
  it('metadata: transform category, preserving size, lossy, no traceMode', () => {
    expect(q.category).toBe('transform');
    expect(q.sizeEffect).toBe('preserving');
    expect(q.isLossy('float64')).toBe(true);
    expect(q.traceMode).toBeUndefined();
  });
});

describe('bitround', () => {
  const b = CODEC_REGISTRY['bitround'];
  it('zeroes low mantissa bits, dtype preserved, counts changed elements', () => {
    const bytes = valuesToBytes(Float64Array.from([Math.PI, 1.0]), 'float64');
    const { bytes: out, outputDtype, stats } = b.encode(bytes, 'float64', { keepBits: 8 });
    expect(outputDtype).toBe('float64');
    const vals = bytesToValues(out, 'float64') as Float64Array;
    expect(vals[0]).not.toBe(Math.PI);
    expect(Math.abs(vals[0] - Math.PI)).toBeLessThan(0.01);
    expect(vals[1]).toBe(1.0);          // exactly representable at any keepBits
    expect(stats).toEqual({ clipped: 0, rounded: 1 });
  });
  it('passes through non-float input unchanged', () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    expect(b.encode(bytes, 'int16', { keepBits: 8 }).bytes).toEqual(bytes);
  });
  it('roundtrips through the pipeline as a stable no-op on already-rounded data', () => {
    const step = [{ codec: 'bitround', params: { keepBits: 8 } }];
    const once = runCodecPipeline(valuesToBytes(Float64Array.from([Math.PI]), 'float64'), step, 'float64');
    const twice = runCodecPipeline(once.bytes, step, 'float64');
    expect(twice.bytes).toEqual(once.bytes);
    expect(reverseCodecPipeline(once.bytes, step, 'float64').bytes).toEqual(once.bytes);
  });
});
