import { describe, it, expect } from 'vitest';
import { CODEC_REGISTRY, runCodecPipeline, encodedByteLength } from '../../../src/engine/codecs.ts';
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
  it('copies a trailing partial element through unchanged', () => {
    const whole = valuesToBytes(Float64Array.from([1.2345]), 'float64');
    const bytes = new Uint8Array(12);
    bytes.set(whole);
    bytes.set([0xde, 0xad, 0xbe, 0xef], 8);
    const { bytes: out } = q.encode(bytes, 'float64', { digits: 2 });
    expect(Array.from(out.subarray(8))).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(out.subarray(0, 8)).toEqual(q.encode(whole, 'float64', { digits: 2 }).bytes);
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
  it('copies a trailing partial element through unchanged (no throw)', () => {
    // 1 whole float64 + 4 trailing bytes: used to throw RangeError in
    // applyBitround's unbounded DataView loop.
    const whole = valuesToBytes(Float64Array.from([Math.PI]), 'float64');
    const bytes = new Uint8Array(12);
    bytes.set(whole);
    bytes.set([0xde, 0xad, 0xbe, 0xef], 8);
    const { bytes: out } = b.encode(bytes, 'float64', { keepBits: 8 });
    expect(Array.from(out.subarray(8))).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(out.subarray(0, 8)).toEqual(b.encode(whole, 'float64', { keepBits: 8 }).bytes);
  });
  it('roundtrips through the pipeline as a stable no-op on already-rounded data', () => {
    const step = [{ codec: 'bitround', params: { keepBits: 8 } }];
    const once = runCodecPipeline(valuesToBytes(Float64Array.from([Math.PI]), 'float64'), step, 'float64');
    const twice = runCodecPipeline(once.bytes, step, 'float64');
    expect(twice.bytes).toEqual(once.bytes);
    expect(reverseCodecPipeline(once.bytes, step, 'float64').bytes).toEqual(once.bytes);
  });
});

describe('scale-offset', () => {
  const so = CODEC_REGISTRY['scale-offset'];
  const params = { scale: 10, offset: 0, sourceDtype: 'float32', targetDtype: 'int16' };
  it('packs floats into the target int dtype at 1/scale precision', () => {
    const bytes = valuesToBytes(Float64Array.from([1.5, 2.34, -0.5]), 'float32');
    const { bytes: out, outputDtype, stats } = so.encode(bytes, 'float32', params);
    expect(outputDtype).toBe('int16');
    expect(out.length).toBe(6); // 3 elements × 2 bytes — the fixed ratio
    expect(Array.from(bytesToValues(out, 'int16') as Float64Array)).toEqual([15, 23, -5]);
    expect(stats!.rounded).toBe(1); // 2.34×10 = 23.4 rounds; 1.5×10 and -0.5×10 are exact
    expect(stats!.clipped).toBe(0);
  });
  it('clamps and counts values outside the target range', () => {
    const bytes = valuesToBytes(Float64Array.from([40000, -1]), 'float32');
    const { bytes: out, stats } = so.encode(bytes, 'float32', { ...params, scale: 1 });
    expect(Array.from(bytesToValues(out, 'int16') as Float64Array)).toEqual([32767, -1]);
    expect(stats!.clipped).toBe(1);
  });
  it('decode divides out and re-emits at sourceDtype', () => {
    const enc = valuesToBytes(Float64Array.from([15, 23]), 'int16');
    const { bytes: out, outputDtype } = so.decode(enc, 'int16', params);
    expect(outputDtype).toBe('float32');
    expect(Array.from(bytesToValues(out, 'float32') as Float64Array)).toEqual([1.5, 2.299999952316284]);
  });
  it('reverseCodecPipeline roundtrips to the quantized values', () => {
    const original = valuesToBytes(Float64Array.from([1.5, 2.3, -0.7]), 'float32');
    const steps = [{ codec: 'scale-offset', params }];
    const enc = runCodecPipeline(original, steps, 'float32');
    expect(enc.outputDtype).toBe('int16');
    const dec = reverseCodecPipeline(enc.bytes, steps, 'float32');
    expect(dec.outputDtype).toBe('float32');
    const vals = bytesToValues(dec.bytes, 'float32') as Float64Array;
    expect(vals[0]).toBeCloseTo(1.5, 5);
    expect(vals[1]).toBeCloseTo(2.3, 5);
    expect(vals[2]).toBeCloseTo(-0.7, 5);
  });
  it('encodedByteLength accounts for the ratio', () => {
    expect(encodedByteLength([{ codec: 'scale-offset', params }], 'float32', 12)).toBe(6);
    expect(encodedByteLength(
      [{ codec: 'scale-offset', params }, { codec: 'delta', params: { elementSize: 2 } }],
      'float32', 12,
    )).toBe(6);
  });
  it('NaN stores as 0 without clip/round counts (assignType NF-4 convention)', () => {
    const bytes = valuesToBytes(Float64Array.from([NaN]), 'float32');
    const { bytes: out, stats } = so.encode(bytes, 'float32', params);
    expect(Array.from(bytesToValues(out, 'int16') as Float64Array)).toEqual([0]);
    expect(stats).toEqual({ clipped: 0, rounded: 0 });
  });
});
