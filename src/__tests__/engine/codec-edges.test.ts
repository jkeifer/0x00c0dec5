/**
 * Targeted engine gap tests — codec edge cases.
 *
 * Covers remediation-plan.md Phase 1 task 1.2 / §1.7 gaps for:
 *  - Delta codec: unsigned dtypes, decreasing values, near-range values, order 2/3,
 *    empty input, single element (DC-2: clamping broke round-trip on unsigned dtypes;
 *    fixed by Phase 2 task 2.5 — the clamp is removed, typed-array writes wrap
 *    mod 2^N instead).
 *  - LZ codec: back-references with offset > 255, incompressible input.
 *  - Byte shuffle with elementSize != dtype size (garbled-but-reversible round-trip).
 *  - RLE: runs longer than 255, empty input, alternating (worst-case) input.
 *
 * The DC-2 cases were originally written to assert CORRECT behavior (exact
 * round-trip) and marked `it.fails` per the task's "do not weaken assertions"
 * rule, ahead of the fix landing. Phase 2 task 2.5 has now landed, so they are
 * flipped to plain `it()`.
 */
import { describe, it, expect } from 'vitest';
import { CODEC_REGISTRY } from '../../engine/codecs.ts';
import { valuesToBytes, bytesToValues } from '../../engine/elements.ts';

const delta = CODEC_REGISTRY['delta'];
const byteShuffle = CODEC_REGISTRY['byte-shuffle'];
const rle = CODEC_REGISTRY['rle'];
const lz = CODEC_REGISTRY['lz'];

describe('delta codec — edge cases', () => {
  // FIXED DC-2 (task 2.5) — delta encode/decode used to round/clamp diffs and
  // cumsums to the dtype range, so any negative diff on an unsigned dtype clamped
  // to 0 instead of wrapping. The clamp is removed; typed-array writes now wrap
  // mod 2^N, making the round-trip exact.
  it('round-trips decreasing values on uint16 exactly', () => {
    const original = [57, 12, 90, 3];
    const input = valuesToBytes(original, 'uint16');
    const encoded = delta.encode(input, 'uint16', { order: 1 });
    const decoded = delta.decode(encoded.bytes, encoded.outputDtype, { order: 1 });
    const values = bytesToValues(decoded.bytes, 'uint16');
    expect(values).toEqual(original);
  });

  // FIXED DC-2 (task 2.5) — same former clamping bug, exercised near the dtype's
  // range boundary where negative diffs are especially likely.
  it('round-trips near-range values on uint8 exactly', () => {
    const original = [250, 5, 255, 0, 128];
    const input = valuesToBytes(original, 'uint8');
    const encoded = delta.encode(input, 'uint8', { order: 1 });
    const decoded = delta.decode(encoded.bytes, encoded.outputDtype, { order: 1 });
    const values = bytesToValues(decoded.bytes, 'uint8');
    expect(values).toEqual(original);
  });

  // FIXED DC-2 (task 2.5) — order=2 compounds first-differences, so the former
  // clamping corrupted even faster; now wraps and reverses exactly.
  it('round-trips decreasing values on uint16 with order=2', () => {
    const original = [57, 12, 90, 3, 40];
    const input = valuesToBytes(original, 'uint16');
    const encoded = delta.encode(input, 'uint16', { order: 2 });
    const decoded = delta.decode(encoded.bytes, encoded.outputDtype, { order: 2 });
    const values = bytesToValues(decoded.bytes, 'uint16');
    expect(values).toEqual(original);
  });

  // FIXED DC-2 (task 2.5) — order=3 on an unsigned dtype with decreasing values.
  it('round-trips decreasing values on uint16 with order=3', () => {
    const original = [5, 20, 8, 40, 1];
    const input = valuesToBytes(original, 'uint16');
    const encoded = delta.encode(input, 'uint16', { order: 3 });
    const decoded = delta.decode(encoded.bytes, encoded.outputDtype, { order: 3 });
    const values = bytesToValues(decoded.bytes, 'uint16');
    expect(values).toEqual(original);
  });

  it('round-trips empty input', () => {
    const input = valuesToBytes([], 'uint16');
    const encoded = delta.encode(input, 'uint16', { order: 1 });
    expect(encoded.bytes.length).toBe(0);
    const decoded = delta.decode(encoded.bytes, encoded.outputDtype, { order: 1 });
    expect(decoded.bytes.length).toBe(0);
    const values = bytesToValues(decoded.bytes, 'uint16');
    expect(values).toEqual([]);
  });

  it('round-trips a single element (no diff to take)', () => {
    const original = [42];
    const input = valuesToBytes(original, 'uint16');
    const encoded = delta.encode(input, 'uint16', { order: 1 });
    const decoded = delta.decode(encoded.bytes, encoded.outputDtype, { order: 1 });
    const values = bytesToValues(decoded.bytes, 'uint16');
    expect(values).toEqual(original);
  });

  it('round-trips a single element at order=3', () => {
    const original = [7];
    const input = valuesToBytes(original, 'uint16');
    const encoded = delta.encode(input, 'uint16', { order: 3 });
    const decoded = delta.decode(encoded.bytes, encoded.outputDtype, { order: 3 });
    const values = bytesToValues(decoded.bytes, 'uint16');
    expect(values).toEqual(original);
  });

  // Signed dtypes are not subject to DC-2 for this particular data (no wraparound
  // needed since diffs stay in-range) — documents the contrast with the unsigned case.
  it('round-trips decreasing values on int16 exactly (signed dtype, no wraparound needed)', () => {
    const original = [57, 12, 90, 3];
    const input = valuesToBytes(original, 'int16');
    const encoded = delta.encode(input, 'int16', { order: 1 });
    const decoded = delta.decode(encoded.bytes, encoded.outputDtype, { order: 1 });
    const values = bytesToValues(decoded.bytes, 'int16');
    expect(values).toEqual(original);
  });
});

describe('LZ codec — back-reference offset > 255', () => {
  it('round-trips exactly when a match source is more than 255 bytes back (2-byte offset path)', () => {
    // 300 bytes of non-repeating filler (no run >= 3 so no accidental short-range
    // matches), then a 5-byte pattern repeated far enough back to require an
    // offset > 255 in the [length, offset_hi, offset_lo] encoding.
    const filler = new Uint8Array(300);
    for (let i = 0; i < filler.length; i++) filler[i] = i % 250;
    const pattern = new Uint8Array([11, 22, 33, 44, 55]);
    const input = new Uint8Array([...pattern, ...filler, ...pattern]);

    const encoded = lz.encode(input, 'uint8', { windowSize: 32768 });

    // Confirm the encoding actually exercises the 2-byte offset path (offset > 255)
    // so this test is not vacuously true.
    let sawBigOffset = false;
    let i = 0;
    while (i < encoded.bytes.length) {
      const token = encoded.bytes[i];
      if (token === 0x00) {
        i += 2;
      } else {
        const offset = (encoded.bytes[i + 1] << 8) | encoded.bytes[i + 2];
        if (offset > 255) sawBigOffset = true;
        i += 3;
      }
    }
    expect(sawBigOffset).toBe(true);

    const decoded = lz.decode(encoded.bytes, encoded.outputDtype, { windowSize: 32768 });
    expect(Array.from(decoded.bytes)).toEqual(Array.from(input));
  });
});

describe('LZ codec — incompressible input', () => {
  it('round-trips exactly even when output is larger than input', () => {
    // Bytes chosen so no 3+ byte run repeats within the window (each literal costs
    // 2 bytes: [0x00, byte]), so the encoded output should be larger than the input.
    const input = new Uint8Array(50);
    for (let i = 0; i < input.length; i++) input[i] = (i * 97 + 13) % 256;

    const encoded = lz.encode(input, 'uint8', { windowSize: 256 });
    expect(encoded.bytes.length).toBeGreaterThan(input.length);

    const decoded = lz.decode(encoded.bytes, encoded.outputDtype, { windowSize: 256 });
    expect(Array.from(decoded.bytes)).toEqual(Array.from(input));
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
