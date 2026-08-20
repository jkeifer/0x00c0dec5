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
 * Codec-unification shrink: `TypeAssignment` is storage-dtype-only now — scale/
 * offset and bitround moved to the codec pipeline (scale-offset, bitround in
 * codecs.ts). This is a plain cast: clamp/round to the storage dtype's range,
 * track clipped/rounded/NaN stats, convert to bytes.
 */
export function assignType(
  values: ValueArray,
  _logicalType: LogicalTypeConfig,
  assignment: TypeAssignment,
  byteOrder: 'little' | 'big' = 'little',
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
    }

    transformed[i] = result;
  }

  // Convert to bytes
  const bytes = valuesToBytes(transformed, outDtype, byteOrder);

  // For float types, detect rounding by reading back — a plain float64->float32
  // (or any storage narrowing) cast can lose precision even with no scale term.
  if (outInfo.float) {
    const readBack = bytesToValues(bytes, outDtype, byteOrder) as Float64Array;
    for (let i = 0; i < values.length; i++) {
      const expected = values[i] as number;
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
