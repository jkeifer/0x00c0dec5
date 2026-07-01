/**
 * Targeted engine gap tests — type assignment edge cases.
 *
 * Covers remediation-plan.md Phase 1 task 1.2 / §1.7 gap #7:
 *  - float64 bitround via `assignType` at keepBits 19/20/21 (DC-6 predicts breakage
 *    at exactly keepBits=20 due to `0xffffffff << 32` wrapping to `<< 0` in JS).
 *  - NaN input through `assignType` (unpredicted — probed live, see NEW FINDING below).
 */
import { describe, it, expect } from 'vitest';
import { assignType } from '../../engine/typeAssign.ts';
import type { LogicalTypeConfig, TypeAssignment } from '../../types/state.ts';

const continuousType: LogicalTypeConfig = { type: 'continuous', min: 0, max: 10, significantFigures: 15 };

/** Read the low/high 32-bit words of the first float64 element (little-endian). */
function readFloat64Words(bytes: Uint8Array): { low: number; high: number; value: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    low: view.getUint32(0, true),
    high: view.getUint32(4, true),
    value: view.getFloat64(0, true),
  };
}

describe('assignType — float64 bitround (keepBits)', () => {
  // keepBits=19 is below the JS shift-wraparound boundary: `52 - 19 = 33`, and
  // `<< 33` in JS wraps to `<< 1`, which still zeroes essentially all low mantissa
  // bits for this value. Verified live: low word truncates to 0, value changes.
  it('keepBits=19 truncates low mantissa bits and changes the value (lossy)', () => {
    const values = [Math.PI];
    const assignment: TypeAssignment = { storageDtype: 'float64', keepBits: 19 };
    const result = assignType(values, continuousType, assignment);
    const { low, value } = readFloat64Words(result.bytes);

    expect(low).toBe(0);
    expect(value).not.toBe(Math.PI);
    expect(result.stats.isLossy).toBe(true);
  });

  // KNOWN BUG DC-6 — `src/engine/typeAssign.ts` computes
  // `maskLow = keepBits >= 20 ? 0xffffffff << (52 - keepBits) : 0`. At keepBits=20,
  // `52 - 20 = 32`, and `0xffffffff << 32` wraps to `<< 0` in JS (shift amounts are
  // taken mod 32 for 32-bit operands), producing an all-ones mask that keeps every
  // low mantissa bit instead of truncating. Verified live: readback for keepBits=20
  // equals Math.PI exactly, i.e. NO truncation occurs despite keepBits < 52.
  // The fix (task 2.7) changes the boundary from `>= 20` to `> 20`.
  // flip to it() when Phase 2 lands.
  it.fails('keepBits=20 truncates low mantissa bits (currently keeps all of them)', () => {
    const values = [Math.PI];
    const assignment: TypeAssignment = { storageDtype: 'float64', keepBits: 20 };
    const result = assignType(values, continuousType, assignment);
    const { low, value } = readFloat64Words(result.bytes);

    // Correct behavior: keepBits=20 should still truncate some low mantissa bits,
    // so the low word should not retain every bit and the value should not survive
    // as bit-exact Math.PI.
    expect(low).not.toBe(0xffffffff);
    expect(value).not.toBe(Math.PI);
  });

  // keepBits=21 is above the wraparound boundary (`52 - 21 = 31`, a valid shift) and
  // truncates correctly.
  it('keepBits=21 truncates low mantissa bits and changes the value (lossy)', () => {
    const values = [Math.PI];
    const assignment: TypeAssignment = { storageDtype: 'float64', keepBits: 21 };
    const result = assignType(values, continuousType, assignment);
    const { low, value } = readFloat64Words(result.bytes);

    expect(low).toBe(0);
    expect(value).not.toBe(Math.PI);
    expect(result.stats.isLossy).toBe(true);
  });
});

describe('assignType — NaN input', () => {
  // NEW FINDING (not in remediation-plan.md Part 1): `assignType`'s min/max/mean
  // tracking is silently broken by NaN inputs. The loop does `if (original < min) ...`
  // / `if (original > max) ...`, but `NaN < x` and `NaN > x` are always `false` in
  // JS, so `min` stays at its `Infinity` sentinel and `max` stays at `-Infinity`
  // instead of reflecting the NaN input. `mean` becomes NaN (sum poisoned by NaN).
  // Verified live: for a single-value input of `[NaN]`, `stats.min === Infinity` and
  // `stats.max === -Infinity` (not NaN, not close to correct in any sense), and
  // `stats.mean` is `NaN`. This corrupts the variable-statistics metadata written to
  // the file (see `engine/metadata.ts` `variable_statistics` entry) for any dataset
  // containing NaN. Marked it.fails to assert the CORRECT behavior (min/max should
  // reflect/propagate NaN, not silently keep sentinel values) until this is fixed.
  it.fails('tracks NaN in min/max instead of leaving sentinel Infinity/-Infinity values', () => {
    const assignment: TypeAssignment = { storageDtype: 'int32' };
    const result = assignType([NaN], { type: 'integer', min: 0, max: 10 }, assignment);

    // Correct behavior: a NaN-containing dataset should not report finite-looking
    // sentinel min/max that were never touched by real data.
    expect(Number.isFinite(result.stats.min)).toBe(false);
    expect(Number.isNaN(result.stats.min)).toBe(true);
  });

  // For float storage, NaN survives the round trip (IEEE-754 NaN is representable
  // in float32/float64), but the rounding detector flags it as "rounded" because
  // `NaN !== NaN` in the readback comparison (`typeAssign.ts`'s `readBack[i] !== expected`
  // check). This makes NaN values on float dtypes register as spuriously lossy.
  // Verified live: `stats.rounded === 1` and `stats.isLossy === true` for a single
  // NaN value stored as float32, even though float32 represents NaN exactly.
  it.fails('does not flag NaN as "rounded" when stored in a float dtype that represents it exactly', () => {
    const assignment: TypeAssignment = { storageDtype: 'float32' };
    const result = assignType([NaN], { type: 'continuous', min: 0, max: 10, significantFigures: 6 }, assignment);

    expect(result.stats.rounded).toBe(0);
    expect(result.stats.isLossy).toBe(false);
  });

  // Integer storage: Math.round(NaN) is NaN, and Math.max(min, Math.min(max, NaN))
  // is NaN (any comparison with NaN is false, so Math.min/Math.max propagate NaN
  // through as their "not less/greater" fallback). Writing NaN into an int32 typed
  // array via DataView.setInt32 does not throw — verified live it silently becomes 0
  // on readback. Documented here as a NEW FINDING: NaN silently becomes 0 for
  // integer-backed variables with no clipped/rounded signal a user could act on
  // (rounded is incremented, but the resulting value (0) bears no relation to NaN).
  it.fails('does not silently coerce NaN to 0 for integer storage dtypes', () => {
    const assignment: TypeAssignment = { storageDtype: 'int32' };
    const result = assignType([NaN], { type: 'integer', min: 0, max: 10 }, assignment);
    const view = new DataView(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength);
    const readBack = view.getInt32(0, true);

    // Correct behavior per the task's contract: this should NOT silently succeed as
    // a plain 0 — either the value should be flagged unambiguously (e.g. clipped)
    // or the pipeline should reject/mark it distinctly from a legitimate zero.
    expect(readBack).not.toBe(0);
  });
});
