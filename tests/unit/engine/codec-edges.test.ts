/**
 * Targeted engine gap tests — codec edge cases.
 *
 * Covers remediation-plan.md Phase 1 task 1.2 / §1.7 gaps for:
 *  - Delta codec: unsigned dtypes, decreasing values, near-range values, repeated
 *    application, empty input, single element (DC-2: clamping broke round-trip on unsigned dtypes;
 *    fixed by Phase 2 task 2.5 — the clamp is removed, typed-array writes wrap
 *    mod 2^N instead).
 *  - Byte shuffle with elementSize != dtype size (garbled-but-reversible round-trip).
 *  - RLE: runs longer than 255, empty input, alternating (worst-case) input.
 *
 * The DC-2 cases were originally written to assert CORRECT behavior (exact
 * round-trip) and marked `it.fails` per the task's "do not weaken assertions"
 * rule, ahead of the fix landing. Phase 2 task 2.5 has now landed, so they are
 * flipped to plain `it()`.
 *
 * (LZ-codec edge cases — back-references with offset > 255, incompressible
 * input — were removed with LZ itself; see tests/unit/engine/codecs.test.ts's
 * 'curation' describe.)
 */
import { describe, it, expect } from 'vitest';
import { CODEC_REGISTRY } from '../../../src/engine/codecs.ts';
import { valuesToBytes, bytesToValues } from '../../../src/engine/elements.ts';

const delta = CODEC_REGISTRY['delta'];
const byteShuffle = CODEC_REGISTRY['byte-shuffle'];
const rle = CODEC_REGISTRY['rle'];

describe('delta codec — edge cases', () => {
  // FIXED DC-2 (task 2.5) — delta encode/decode used to round/clamp diffs and
  // cumsums to the dtype range, so any negative diff on an unsigned dtype clamped
  // to 0 instead of wrapping. The clamp is removed; typed-array writes now wrap
  // mod 2^N, making the round-trip exact.
  it('round-trips decreasing values on uint16 exactly', () => {
    const original = [57, 12, 90, 3];
    const input = valuesToBytes(original, 'uint16');
    const encoded = delta.encode(input, 'uint16', { elementSize: 2 });
    const decoded = delta.decode(encoded.bytes, encoded.outputDtype, { elementSize: 2 });
    const values = bytesToValues(decoded.bytes, 'uint16');
    expect(Array.from(values)).toEqual(original);
  });

  // FIXED DC-2 (task 2.5) — same former clamping bug, exercised near the dtype's
  // range boundary where negative diffs are especially likely.
  it('round-trips near-range values on uint8 exactly', () => {
    const original = [250, 5, 255, 0, 128];
    const input = valuesToBytes(original, 'uint8');
    const encoded = delta.encode(input, 'uint8', { elementSize: 1 });
    const decoded = delta.decode(encoded.bytes, encoded.outputDtype, { elementSize: 1 });
    const values = bytesToValues(decoded.bytes, 'uint8');
    expect(Array.from(values)).toEqual(original);
  });

  // FIXED DC-2 (task 2.5) — repeated application compounds first-differences, so
  // the former clamping corrupted even faster; now wraps and reverses exactly.
  // (This is what the deleted `order` param did: N passes = N steps.)
  it('round-trips decreasing values on uint16 through 2 and 3 delta passes', () => {
    for (const [original, passes] of [[[57, 12, 90, 3, 40], 2], [[5, 20, 8, 40, 1], 3]] as const) {
      let bytes = valuesToBytes([...original], 'uint16');
      for (let i = 0; i < passes; i++) bytes = delta.encode(bytes, 'uint16', { elementSize: 2 }).bytes;
      for (let i = 0; i < passes; i++) bytes = delta.decode(bytes, 'uint16', { elementSize: 2 }).bytes;
      expect(Array.from(bytesToValues(bytes, 'uint16'))).toEqual([...original]);
    }
  });

  it('round-trips empty input', () => {
    const input = valuesToBytes([], 'uint16');
    const encoded = delta.encode(input, 'uint16', { elementSize: 2 });
    expect(encoded.bytes.length).toBe(0);
    const decoded = delta.decode(encoded.bytes, encoded.outputDtype, { elementSize: 2 });
    expect(decoded.bytes.length).toBe(0);
    const values = bytesToValues(decoded.bytes, 'uint16');
    expect(Array.from(values)).toEqual([]);
  });

  it('round-trips a single element (no diff to take)', () => {
    const original = [42];
    const input = valuesToBytes(original, 'uint16');
    const encoded = delta.encode(input, 'uint16', { elementSize: 2 });
    const decoded = delta.decode(encoded.bytes, encoded.outputDtype, { elementSize: 2 });
    const values = bytesToValues(decoded.bytes, 'uint16');
    expect(Array.from(values)).toEqual(original);
  });

  it('round-trips a single element through 3 delta passes', () => {
    let bytes = valuesToBytes([7], 'uint16');
    for (let i = 0; i < 3; i++) bytes = delta.encode(bytes, 'uint16', { elementSize: 2 }).bytes;
    for (let i = 0; i < 3; i++) bytes = delta.decode(bytes, 'uint16', { elementSize: 2 }).bytes;
    expect(Array.from(bytesToValues(bytes, 'uint16'))).toEqual([7]);
  });

  // Signed dtypes are not subject to DC-2 for this particular data (no wraparound
  // needed since diffs stay in-range) — documents the contrast with the unsigned case.
  it('round-trips decreasing values on int16 exactly (signed dtype, no wraparound needed)', () => {
    const original = [57, 12, 90, 3];
    const input = valuesToBytes(original, 'int16');
    const encoded = delta.encode(input, 'int16', { elementSize: 2 });
    const decoded = delta.decode(encoded.bytes, encoded.outputDtype, { elementSize: 2 });
    const values = bytesToValues(decoded.bytes, 'int16');
    expect(Array.from(values)).toEqual(original);
  });
});

describe('delta codec — elementSize', () => {
  // The borrow/carry chain is what makes delta exact at sizes no JS unsigned
  // view can hold, and at sizes that match no dtype at all.
  it('round-trips at every element size 1..16, including sizes that divide nothing evenly', () => {
    const input = new Uint8Array(37);
    for (let i = 0; i < input.length; i++) input[i] = (i * 37 + 11) & 0xff;
    for (let elementSize = 1; elementSize <= 16; elementSize++) {
      const encoded = delta.encode(input, 'uint8', { elementSize });
      const decoded = delta.decode(encoded.bytes, encoded.outputDtype, { elementSize });
      expect(Array.from(decoded.bytes), `elementSize=${elementSize}`).toEqual(Array.from(input));
    }
  });

  it('borrows across the whole element, not per byte', () => {
    // Two 2-byte LE elements: 0x0100 (256) and 0x0001 (1). 1 - 256 = -255,
    // which mod 2^16 is 0xFF01 — only right if the borrow crosses into byte 1.
    const input = new Uint8Array([0x00, 0x01, 0x01, 0x00]);
    const encoded = delta.encode(input, 'uint16', { elementSize: 2 });
    expect(Array.from(encoded.bytes.slice(2))).toEqual([0x01, 0xff]);
  });

  it('a mis-set element size is still reversible (the same lesson byte shuffle teaches)', () => {
    const input = valuesToBytes([1000, 2000, 3000, 4000], 'uint16');
    const encoded = delta.encode(input, 'uint16', { elementSize: 3 });
    expect(Array.from(encoded.bytes)).not.toEqual(Array.from(input));
    const decoded = delta.decode(encoded.bytes, encoded.outputDtype, { elementSize: 3 });
    expect(Array.from(bytesToValues(decoded.bytes, 'uint16'))).toEqual([1000, 2000, 3000, 4000]);
  });
});

describe('byte-shuffle codec — elementSize mismatched with dtype size', () => {
  it('round-trips exactly with elementSize=3 on float32 data (elementSize != 4)', () => {
    // The shuffle codec has no concept of the underlying dtype's actual size — the
    // "garbled" lesson is that mis-set elementSize still transposes reversibly, it
    // just doesn't align with value boundaries.
    const input = valuesToBytes([1.5, -2.25, 3.75, 100.125], 'float32'); // 16 bytes
    const encoded = byteShuffle.encode(input, 'float32', { elementSize: 3 });
    const decoded = byteShuffle.decode(encoded.bytes, encoded.outputDtype, { elementSize: 3 });
    expect(Array.from(decoded.bytes)).toEqual(Array.from(input));
  });

  it('round-trips exactly with elementSize=5 on int32 data (elementSize > dtype size)', () => {
    const input = valuesToBytes([1, 2, 3, 4, 5, 6], 'int32'); // 24 bytes
    const encoded = byteShuffle.encode(input, 'int32', { elementSize: 5 });
    const decoded = byteShuffle.decode(encoded.bytes, encoded.outputDtype, { elementSize: 5 });
    expect(Array.from(decoded.bytes)).toEqual(Array.from(input));
  });

  it('round-trips exactly when elementSize does not evenly divide the byte length', () => {
    // 10 bytes with elementSize=3 leaves a 1-byte remainder copied through unchanged.
    const input = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const encoded = byteShuffle.encode(input, 'uint8', { elementSize: 3 });
    const decoded = byteShuffle.decode(encoded.bytes, encoded.outputDtype, { elementSize: 3 });
    expect(Array.from(decoded.bytes)).toEqual(Array.from(input));
  });
});

describe('RLE codec — worst-case and boundary inputs', () => {
  it('round-trips a run longer than 255 exactly', () => {
    const input = new Uint8Array(300).fill(0x42);
    const encoded = rle.encode(input, 'uint8', {});
    // 300 = 255 + 45, so two run-pairs are expected.
    expect(Array.from(encoded.bytes)).toEqual([255, 0x42, 45, 0x42]);
    const decoded = rle.decode(encoded.bytes, encoded.outputDtype, {});
    expect(Array.from(decoded.bytes)).toEqual(Array.from(input));
  });

  it('round-trips a run of exactly 510 (two full 255-runs)', () => {
    const input = new Uint8Array(510).fill(0x07);
    const encoded = rle.encode(input, 'uint8', {});
    expect(Array.from(encoded.bytes)).toEqual([255, 0x07, 255, 0x07]);
    const decoded = rle.decode(encoded.bytes, encoded.outputDtype, {});
    expect(Array.from(decoded.bytes)).toEqual(Array.from(input));
  });

  it('round-trips empty input', () => {
    const encoded = rle.encode(new Uint8Array(0), 'uint8', {});
    expect(encoded.bytes.length).toBe(0);
    const decoded = rle.decode(encoded.bytes, encoded.outputDtype, {});
    expect(decoded.bytes.length).toBe(0);
  });

  it('round-trips alternating bytes exactly (worst case: doubles in size)', () => {
    const input = new Uint8Array(20);
    for (let i = 0; i < input.length; i++) input[i] = i % 2 === 0 ? 0xaa : 0xbb;
    const encoded = rle.encode(input, 'uint8', {});
    // Every byte is its own run of length 1 — output is exactly 2x input size.
    expect(encoded.bytes.length).toBe(input.length * 2);
    const decoded = rle.decode(encoded.bytes, encoded.outputDtype, {});
    expect(Array.from(decoded.bytes)).toEqual(Array.from(input));
  });
});
