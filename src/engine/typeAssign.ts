import type { DtypeKey } from '../types/dtypes.ts';
import type { LogicalTypeConfig, TypeAssignment } from '../types/state.ts';
import type { VariableStats } from '../types/pipeline.ts';
import { getDtype } from '../types/dtypes.ts';
import { valuesToBytes, bytesToValues } from './elements.ts';

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
  values: number[],
  _logicalType: LogicalTypeConfig,
  assignment: TypeAssignment,
): TypeAssignResult {
  const outDtype = assignment.storageDtype;
  const outInfo = getDtype(outDtype);
  const hasScaleOffset = (assignment.scale !== undefined && assignment.scale !== 1) ||
    (assignment.offset !== undefined && assignment.offset !== 0);
  const scale = assignment.scale ?? 1;
  const offset = assignment.offset ?? 0;

  let clipped = 0;
  let rounded = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;

  const transformed: number[] = new Array(values.length);

  for (let i = 0; i < values.length; i++) {
    const original = values[i];
    sum += original;
    if (original < min) min = original;
    if (original > max) max = original;

    let result = original;

    // Apply scale/offset if configured
    if (hasScaleOffset) {
      result = (result - offset) * scale;
    }

    // Clamp to output dtype range for integer types
    if (!outInfo.float) {
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
    const readBack = bytesToValues(bytes, outDtype);
    for (let i = 0; i < values.length; i++) {
      let expected = values[i];
      if (hasScaleOffset) {
        expected = (expected - offset) * scale;
      }
      if (readBack[i] !== expected) {
        rounded++;
      }
    }
  }

  const count = values.length;
  const isLossy = clipped > 0 || rounded > 0;

  return {
    bytes,
    stats: {
      min: count > 0 ? min : 0,
      max: count > 0 ? max : 0,
      mean: count > 0 ? sum / count : 0,
      count,
      clipped,
      rounded,
      isLossy,
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
): number[] {
  let dtype = assignment.storageDtype;

  // keepBits is irrecoverable (like bitround), so no reversal needed for it
  // Just read the values and reverse scale/offset
  const values = bytesToValues(bytes, dtype);

  const hasScaleOffset = (assignment.scale !== undefined && assignment.scale !== 1) ||
    (assignment.offset !== undefined && assignment.offset !== 0);

  if (!hasScaleOffset) {
    return values;
  }

  const scale = assignment.scale ?? 1;
  const offset = assignment.offset ?? 0;

  return values.map((v) => v / scale + offset);
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
    const maskLow = keepBits >= 20 ? 0xffffffff << (52 - keepBits) : 0;
    for (let i = 0; i < result.length; i += 8) {
      const low = view.getUint32(i, true);
      const high = view.getUint32(i + 4, true);
      view.setUint32(i, low & maskLow, true);
      view.setUint32(i + 4, high & maskHigh, true);
    }
  }

  return result;
}
