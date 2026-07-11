import { describe, it, expect } from 'vitest';
import { CODEC_REGISTRY } from '../../../src/engine/codecs.ts';
import { createPRNG } from '../../../src/engine/generate.ts';

const lz = CODEC_REGISTRY['lz'];
const roundtrip = (input: Uint8Array, windowSize = 256) => {
  const enc = lz.encode(input, 'uint8', { windowSize });
  const dec = lz.decode(enc.bytes, 'uint8', { windowSize });
  return { enc: enc.bytes, dec: dec.bytes };
};

describe('lz hash-chain encoder', () => {
  const CASES: [string, () => Uint8Array][] = [
    ['empty', () => new Uint8Array(0)],
    ['single byte', () => new Uint8Array([7])],
    ['two bytes (below min match)', () => new Uint8Array([7, 7])],
    ['all zeros (max-length overlapping matches)', () => new Uint8Array(10_000)],
    ['repeating 3-byte period (overlap, offset < len)', () => {
      const b = new Uint8Array(999);
      for (let i = 0; i < b.length; i++) b[i] = i % 3;
      return b;
    }],
    ['random incompressible', () => {
      const rng = createPRNG(42);
      const b = new Uint8Array(20_000);
      for (let i = 0; i < b.length; i++) b[i] = Math.floor(rng() * 256);
      return b;
    }],
    ['prefix-heavy text', () => new TextEncoder().encode('WX-0007-A WX-0007-B WX-0014-A WX-0014-B '.repeat(500))],
    ['match at exact window boundary', () => {
      const b = new Uint8Array(600);
      b.set([1, 2, 3, 4, 5], 0);
      b.set([1, 2, 3, 4, 5], 256); // offset exactly == default windowSize
      return b;
    }],
  ];
  for (const [name, make] of CASES) {
    it(`roundtrips: ${name}`, () => {
      const input = make();
      const { dec } = roundtrip(input);
      expect(Array.from(dec)).toEqual(Array.from(input));
    });
    it(`roundtrips with large window: ${name}`, () => {
      const input = make();
      const { dec } = roundtrip(input, 32768);
      expect(Array.from(dec)).toEqual(Array.from(input));
    });
  }

  it('compresses repetitive input (sanity, not a pinned size)', () => {
    const input = new Uint8Array(10_000); // zeros
    const { enc } = roundtrip(input);
    expect(enc.length).toBeLessThan(input.length / 10);
  });

  it('encodes 1MB of compressible data in bounded time', () => {
    const b = new Uint8Array(1_048_576);
    for (let i = 0; i < b.length; i++) b[i] = (i >> 4) & 0xff; // runs of 16
    const t0 = performance.now();
    lz.encode(b, 'uint8', { windowSize: 4096 });
    const ms = performance.now() - t0;
    // Naive O(n*window) at 4096 window would take tens of seconds here.
    // Generous CI bound — this is a cliff detector, not a benchmark.
    expect(ms).toBeLessThan(3_000);
  });
});
