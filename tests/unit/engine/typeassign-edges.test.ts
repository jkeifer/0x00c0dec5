/**
 * Targeted engine gap tests — type assignment edge cases.
 *
 * Covers remediation-plan.md Phase 1 task 1.2 / §1.7 gap #7:
 *  - NaN input through `assignType` (unpredicted — probed live, see NEW FINDING below).
 *
 * The float64 bitround (keepBits) coverage that used to live here moved with
 * the behavior itself to the bitround codec (codec-unification typeAssignment
 * shrink) — see tests/unit/engine/transformCodecs.test.ts's `bitround` block.
 */
import { describe, it, expect } from 'vitest';
import { assignType } from '../../../src/engine/typeAssign.ts';
import type { TypeAssignment } from '../../../src/types/state.ts';

describe('assignType — NaN input', () => {
  // FIXED (NF-2, task 2.14) — `assignType`'s min/max/mean tracking used to be
  // silently broken by NaN inputs. The loop did `if (original < min) ...` /
  // `if (original > max) ...`, but `NaN < x` and `NaN > x` are always `false` in
  // JS, so `min` stayed at its `Infinity` sentinel and `max` stayed at `-Infinity`
  // instead of reflecting the NaN input, while `mean` went NaN (sum poisoned).
  // Verified live (pre-fix): for a single-value input of `[NaN]`, `stats.min ===
  // Infinity` and `stats.max === -Infinity`. Fix: NaN values are now skipped in
  // min/max/mean accumulation and counted separately in `nanCount`; an all-NaN
  // input reports min/max/mean as NaN instead of leaking the sentinels.
  it('tracks NaN in min/max instead of leaving sentinel Infinity/-Infinity values', () => {
    const assignment: TypeAssignment = { storageDtype: 'int32' };
    const result = assignType([NaN], { type: 'integer', min: 0, max: 10, generation: 'random' }, assignment);

    // Correct behavior: a NaN-containing dataset should not report finite-looking
    // sentinel min/max that were never touched by real data.
    expect(Number.isFinite(result.stats.min)).toBe(false);
    expect(Number.isNaN(result.stats.min)).toBe(true);
    expect(result.stats.nanCount).toBe(1);
  });

  // FIXED (NF-3, task 2.14) — for float storage, NaN survives the round trip
  // (IEEE-754 NaN is representable in float32/float64), but the rounding detector
  // used to flag it as "rounded" because `NaN !== NaN` in the readback comparison
  // (`typeAssign.ts`'s `readBack[i] !== expected` check). This made NaN values on
  // float dtypes register as spuriously lossy. Verified live (pre-fix):
  // `stats.rounded === 1` and `stats.isLossy === true` for a single NaN value
  // stored as float32. Fix: NaN-aware comparison (Object.is/Number.isNaN on both
  // sides) so a losslessly-stored NaN no longer counts as rounded.
  it('does not flag NaN as "rounded" when stored in a float dtype that represents it exactly', () => {
    const assignment: TypeAssignment = { storageDtype: 'float32' };
    const result = assignType([NaN], { type: 'continuous', min: 0, max: 10, significantFigures: 6, generation: 'random' }, assignment);

    expect(result.stats.rounded).toBe(0);
    expect(result.stats.isLossy).toBe(false);
    expect(result.stats.nanCount).toBe(1);
  });

  // FIXED (NF-4, task 2.14) — integer storage: Math.round(NaN) is NaN, and
  // Math.max(min, Math.min(max, NaN)) is NaN (any comparison with NaN is false, so
  // Math.min/Math.max propagate NaN through as their "not less/greater" fallback).
  // Writing NaN into an int32 typed array via DataView.setInt32 does not throw —
  // it silently becomes 0 on readback, indistinguishable from a real zero. Per the
  // task's pinned design: the stored-value behavior (NaN -> 0) is acceptable and
  // unchanged; the fix is that `stats.nanCount` now explicitly records that this
  // happened, so the UI/metadata can surface it instead of a silent, ambiguous 0.
  it('records nanCount instead of silently coercing NaN to 0 without a signal', () => {
    const assignment: TypeAssignment = { storageDtype: 'int32' };
    const result = assignType([NaN], { type: 'integer', min: 0, max: 10, generation: 'random' }, assignment);
    const view = new DataView(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength);
    const readBack = view.getInt32(0, true);

    // Storage behavior is unchanged (NaN -> 0 for integer dtypes is acceptable) —
    // but it must never pass silently: nanCount is the explicit signal.
    expect(readBack).toBe(0);
    expect(result.stats.nanCount).toBe(1);
  });

  it('nanCount is 0 (always present) when there are no NaN values', () => {
    const assignment: TypeAssignment = { storageDtype: 'int32' };
    const result = assignType([1, 2, 3], { type: 'integer', min: 0, max: 10, generation: 'random' }, assignment);

    expect(result.stats.nanCount).toBe(0);
  });

  it('all-NaN input reports min/max/mean as NaN, not ±Infinity sentinels', () => {
    const assignment: TypeAssignment = { storageDtype: 'float64' };
    const result = assignType([NaN, NaN, NaN], { type: 'continuous', min: 0, max: 10, significantFigures: 6, generation: 'random' }, assignment);

    expect(result.stats.count).toBe(3);
    expect(result.stats.nanCount).toBe(3);
    expect(Number.isNaN(result.stats.min)).toBe(true);
    expect(Number.isNaN(result.stats.max)).toBe(true);
    expect(Number.isNaN(result.stats.mean)).toBe(true);
    // Losslessly-stored NaN should not be flagged as rounded/lossy.
    expect(result.stats.rounded).toBe(0);
    expect(result.stats.isLossy).toBe(false);

    // The all-NaN stats must remain valid JSON when serialized (as
    // engine/metadata.ts does for the `variable_statistics` entry):
    // JSON.stringify(NaN) becomes `null`, which does not throw and round-trips
    // through JSON.parse as `null` rather than corrupting the document.
    const json = JSON.stringify(result.stats);
    expect(() => JSON.parse(json)).not.toThrow();
    const parsed = JSON.parse(json);
    expect(parsed.min).toBe(null);
    expect(parsed.max).toBe(null);
    expect(parsed.mean).toBe(null);
  });

  it('mixed NaN and real values excludes NaN from min/max/mean but counts it', () => {
    const assignment: TypeAssignment = { storageDtype: 'float64' };
    const result = assignType([1, NaN, 5, NaN, 3], { type: 'continuous', min: 0, max: 10, significantFigures: 6, generation: 'random' }, assignment);

    expect(result.stats.count).toBe(5);
    expect(result.stats.nanCount).toBe(2);
    expect(result.stats.min).toBe(1);
    expect(result.stats.max).toBe(5);
    expect(result.stats.mean).toBe(3);
  });
});
