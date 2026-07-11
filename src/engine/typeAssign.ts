import type { DtypeKey } from '../types/dtypes.ts';
import type { LogicalTypeConfig, TypeAssignment } from '../types/state.ts';
import type { VariableStats } from '../types/pipeline.ts';
import { getDtype, isCharDtype } from '../types/dtypes.ts';
import { valuesToBytes, bytesToValues } from './elements.ts';
import type { ValueArray } from './layout.ts';

export interface TypeAssignResult {
  bytes: Uint8Array;
  stats: VariableStats;
  outputDtype: DtypeKey;
}

/**
 * Convert logical values to binary-typed bytes according to a type assignment.
 *
 * Steps:
 * 1. If scale/offset are set, apply: transformed = (value - offset) * scale
 * 2. If keepBits is set (float output), apply mantissa truncation
 * 3. Convert to storageDtype via valuesToBytes
 * 4. Track statistics: clipped/rounded counts
 */
export function assignType(
  values: ValueArray,
  _logicalType: LogicalTypeConfig,
  assignment: TypeAssignment,
): TypeAssignResult {
  const outDtype = assignment.storageDtype;
  const outInfo = getDtype(outDtype);

  // Text branch: charN storage stringifies, truncates to width, and
  // space-pads (see valuesToBytes). Numeric stats don't apply; the one lossy
  // signal is truncation — a value longer than the dtype's width loses its
  // tail irrecoverably.
  if (isCharDtype(outDtype)) {
    let truncated = 0;
    for (const v of values) {
      if (String(v).length > outInfo.size) truncated++;
    }
    return {
      bytes: valuesToBytes(values, outDtype),
      stats: {
        min: 0,
        max: 0,
        mean: 0,
        count: values.length,
        clipped: 0,
        rounded: 0,
        nanCount: 0,
        truncated,
        isLossy: truncated > 0,
      },
      outputDtype: outDtype,
    };
  }
  const hasScaleOffset = (assignment.scale !== undefined && assignment.scale !== 1) ||
    (assignment.offset !== undefined && assignment.offset !== 0);
  const scale = assignment.scale ?? 1;
  const offset = assignment.offset ?? 0;

  let clipped = 0;
  let rounded = 0;
  let nanCount = 0;
  let sum = 0;
  let sumCount = 0;
  let min = Infinity;
  let max = -Infinity;

  const transformed = new Float64Array(values.length);

  for (let i = 0; i < values.length; i++) {
    const original = values[i] as number; // numeric path (char handled above)
    // NF-2: skip NaN in min/max/mean accumulation — `NaN < x` / `NaN > x` are always
    // false, so leaving NaN in the comparisons silently keeps the ±Infinity sentinels
    // while `sum` gets poisoned to NaN. Count NaN separately instead.
    if (Number.isNaN(original)) {
      nanCount++;
    } else {
      sum += original;
      sumCount++;
      if (original < min) min = original;
      if (original > max) max = original;
    }

    let result = original;

    // Apply scale/offset if configured
    if (hasScaleOffset) {
      result = (result - offset) * scale;
    }

    // Clamp to output dtype range for integer types
    if (!outInfo.float) {
      if (Number.isNaN(result)) {
        // NF-4: NaN written via DataView to an integer dtype silently becomes 0
        // (setIntN(NaN) => 0), which is indistinguishable from a real zero on
        // readback. We keep that storage behavior (it's how the format actually
        // behaves) but the loop above already counted this input in `nanCount`,
        // which is the explicit signal the stats/UI can act on. Skip the
        // clipped/rounded bookkeeping here — NaN isn't a rounding or clipping
        // event, it's a distinct "unrepresentable" event already recorded.
        result = 0;
      } else {
        const clamped = Math.max(outInfo.min, Math.min(outInfo.max, Math.round(result)));
        if (clamped !== result) {
          if (Math.round(result) !== result) {
            rounded++;
          }
          if (Math.round(result) < outInfo.min || Math.round(result) > outInfo.max) {
            clipped++;
          }
          result = clamped;
        }
      }
    } else {
      // For float types, check if the value loses precision
      // Write to typed array and read back to detect truncation
      // We'll do this check after writing bytes below
    }

    transformed[i] = result;
  }

  // Convert to bytes
  let bytes = valuesToBytes(transformed, outDtype);

  // Apply keepBits (mantissa truncation) for float output
  if (assignment.keepBits !== undefined && outInfo.float) {
    bytes = applyBitround(bytes, outDtype, assignment.keepBits);
  }

  // For float types, detect rounding by reading back
  if (outInfo.float) {
    const readBack = bytesToValues(bytes, outDtype) as Float64Array;
    for (let i = 0; i < values.length; i++) {
      let expected = values[i] as number;
      if (hasScaleOffset) {
        expected = (expected - offset) * scale;
      }
      // NF-3: `readBack[i] !== expected` is always true for NaN vs NaN (NaN !== NaN
      // in JS), so a losslessly-stored NaN (float32/float64 represent NaN exactly)
      // was spuriously flagged as "rounded". Use a NaN-aware comparison: only count
      // it as rounded if the values differ and it isn't the NaN-both-sides case.
      const bothNaN = Number.isNaN(readBack[i]) && Number.isNaN(expected);
      if (!bothNaN && readBack[i] !== expected) {
        rounded++;
      }
    }
  }

  const count = values.length;
  const isLossy = clipped > 0 || rounded > 0;

  // Edge cases for min/max/mean:
  //  - truly empty input (count === 0): keep the existing convention of 0/0/0
  //    (unchanged behavior, still covered by the "handles empty values" test).
  //  - all-NaN, non-empty input (count > 0, sumCount === 0): report NaN rather than
  //    leaking the ±Infinity sentinels into stats/metadata. `JSON.stringify(NaN)`
  //    serializes to `null`, which is valid JSON (see engine/metadata.ts's
  //    `variable_statistics` entry) — it just can't be told apart from -Infinity/
  //    Infinity there, which is an acceptable "no data" signal for a NaN-only
  //    dataset.
  const hasFiniteStat = sumCount > 0;

  return {
    bytes,
    stats: {
      min: count === 0 ? 0 : (hasFiniteStat ? min : NaN),
      max: count === 0 ? 0 : (hasFiniteStat ? max : NaN),
      mean: count === 0 ? 0 : (hasFiniteStat ? sum / sumCount : NaN),
      count,
      clipped,
      rounded,
      isLossy,
      nanCount,
    },
    outputDtype: outDtype,
  };
}

/**
 * Reverse a type assignment: convert typed bytes back to logical values.
 */
export function reverseTypeAssignment(
  bytes: Uint8Array,
  assignment: TypeAssignment,
): ValueArray {
  let dtype = assignment.storageDtype;

  // keepBits is irrecoverable (like bitround), so no reversal needed for it
  // Just read the values and reverse scale/offset
  const values = bytesToValues(bytes, dtype);

  // Char storage: bytesToValues already produced right-trimmed strings, and
  // there is no scale/offset to reverse for text.
  if (isCharDtype(dtype)) {
    return values;
  }

  const hasScaleOffset = (assignment.scale !== undefined && assignment.scale !== 1) ||
    (assignment.offset !== undefined && assignment.offset !== 0);

  if (!hasScaleOffset) {
    return values;
  }

  const scale = assignment.scale ?? 1;
  const offset = assignment.offset ?? 0;

  return (values as Float64Array).map((v) => v / scale + offset);
}

/** Apply mantissa bit truncation to float bytes. */
function applyBitround(bytes: Uint8Array, dtype: DtypeKey, keepBits: number): Uint8Array {
  const result = new Uint8Array(bytes.length);
  result.set(bytes);

  if (dtype === 'float32') {
    const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
    const mask = 0xffffffff << (23 - keepBits);
    for (let i = 0; i < result.length; i += 4) {
      const bits = view.getUint32(i, true);
      view.setUint32(i, bits & mask, true);
    }
  } else if (dtype === 'float64') {
    const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
    const maskHigh = 0xffffffff << Math.max(0, 20 - keepBits);
    // Boundary fixed (DC-6): at keepBits === 20, `52 - keepBits === 32`, and
    // `0xffffffff << 32` wraps to `<< 0` in JS (32-bit shift amounts are taken mod 32),
    // producing an all-ones mask that keeps every low mantissa bit instead of
    // truncating them all. Using `> 20` (not `>= 20`) routes keepBits===20 through the
    // `0` branch, which is correct: keepBits=20 keeps 0 bits of the low 32-bit word
    // (all 20 kept bits live in the high word/exponent side).
    const maskLow = keepBits > 20 ? 0xffffffff << (52 - keepBits) : 0;
    for (let i = 0; i < result.length; i += 8) {
      const low = view.getUint32(i, true);
      const high = view.getUint32(i + 4, true);
      view.setUint32(i, low & maskLow, true);
      view.setUint32(i + 4, high & maskHigh, true);
    }
  }

  return result;
}
