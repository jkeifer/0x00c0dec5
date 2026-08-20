import { describe, it, expect } from 'vitest';
import { assignType } from '../../../src/engine/typeAssign.ts';
import { bytesToValues } from '../../../src/engine/elements.ts';
import type { LogicalTypeConfig, TypeAssignment } from '../../../src/types/state.ts';

describe('assignType', () => {
  it('TypeAssignment carries only storageDtype', () => {
    const result = assignType(
      Float64Array.from([1.4, 70000]),
      { type: 'integer' } as LogicalTypeConfig,
      { storageDtype: 'int16' },
    );
    expect(result.stats.rounded).toBe(1);
    expect(result.stats.clipped).toBe(1);
  });

  describe('integer logical type', () => {
    const intType: LogicalTypeConfig = { type: 'integer', min: 0, max: 100, generation: 'random' };

    it('stores integers in uint16 losslessly', () => {
      const values = [0, 50, 100];
      const assignment: TypeAssignment = { storageDtype: 'uint16' };
      const result = assignType(values, intType, assignment);

      expect(result.outputDtype).toBe('uint16');
      expect(result.stats.isLossy).toBe(false);
      expect(result.stats.clipped).toBe(0);
      expect(result.stats.rounded).toBe(0);
      expect(result.stats.count).toBe(3);
    });

    it('stores integers in uint8 with clipping when out of range', () => {
      const values = [0, 100, 300]; // 300 exceeds uint8 max (255)
      const assignment: TypeAssignment = { storageDtype: 'uint8' };
      const result = assignType(values, intType, assignment);

      expect(result.outputDtype).toBe('uint8');
      expect(result.stats.isLossy).toBe(true);
      expect(result.stats.clipped).toBe(1);
    });

    it('stores integers in int8 with clipping for negative overflow', () => {
      const negType: LogicalTypeConfig = { type: 'integer', min: -200, max: 200, generation: 'random' };
      const values = [-200, 0, 200]; // -200 and 200 exceed int8 range [-128, 127]
      const assignment: TypeAssignment = { storageDtype: 'int8' };
      const result = assignType(values, negType, assignment);

      expect(result.stats.isLossy).toBe(true);
      expect(result.stats.clipped).toBe(2);
    });
  });

  describe('decimal logical type', () => {
    const decType: LogicalTypeConfig = { type: 'decimal', min: -50, max: 50, decimalPlaces: 1, generation: 'random' };

    it('stores decimal values in float32 (may round)', () => {
      const values = [23.4, -12.7, 0.0];
      const assignment: TypeAssignment = { storageDtype: 'float32' };
      const result = assignType(values, decType, assignment);

      expect(result.outputDtype).toBe('float32');
      expect(result.stats.count).toBe(3);
      // float32 can't exactly represent 23.4, so rounding occurs
      expect(result.stats.rounded).toBeGreaterThan(0);
      expect(result.stats.isLossy).toBe(true);
    });

    it('stores decimal values in float64 losslessly', () => {
      // float64 can represent decimal values with 1 decimal place exactly
      const values = [23.4, -12.7, 0.0];
      const assignment: TypeAssignment = { storageDtype: 'float64' };
      const result = assignType(values, decType, assignment);

      expect(result.outputDtype).toBe('float64');
      expect(result.stats.rounded).toBe(0);
      expect(result.stats.isLossy).toBe(false);
    });

    it('stores decimal values cast directly into int16 (clamps/rounds, no scale)', () => {
      // With no scale, 23.4 rounds to 23 — a plain cast loses the decimal.
      const values = [23.4, -12.7, 0.0];
      const assignment: TypeAssignment = { storageDtype: 'int16' };
      const result = assignType(values, decType, assignment);

      expect(result.outputDtype).toBe('int16');
      expect(result.stats.clipped).toBe(0);
      expect(result.stats.rounded).toBe(2);
      expect(result.stats.isLossy).toBe(true);
    });
  });

  describe('continuous logical type', () => {
    const contType: LogicalTypeConfig = { type: 'continuous', min: -1000, max: 1000, significantFigures: 6, generation: 'random' };

    it('stores continuous values in float64 losslessly', () => {
      const values = [123.456, -789.012, 0.001];
      const assignment: TypeAssignment = { storageDtype: 'float64' };
      const result = assignType(values, contType, assignment);

      expect(result.outputDtype).toBe('float64');
      expect(result.stats.isLossy).toBe(false);
    });

    it('stores continuous values in float32 with potential precision loss', () => {
      // Some values may lose precision in float32
      const values = [123.456789]; // too many digits for float32
      const assignment: TypeAssignment = { storageDtype: 'float32' };
      const result = assignType(values, contType, assignment);

      expect(result.outputDtype).toBe('float32');
    });
  });

  describe('statistics', () => {
    it('computes min, max, mean correctly', () => {
      const values = [10, 20, 30];
      const intType: LogicalTypeConfig = { type: 'integer', min: 0, max: 100, generation: 'random' };
      const assignment: TypeAssignment = { storageDtype: 'int32' };
      const result = assignType(values, intType, assignment);

      expect(result.stats.min).toBe(10);
      expect(result.stats.max).toBe(30);
      expect(result.stats.mean).toBe(20);
      expect(result.stats.count).toBe(3);
    });

    it('handles empty values', () => {
      const intType: LogicalTypeConfig = { type: 'integer', min: 0, max: 100, generation: 'random' };
      const assignment: TypeAssignment = { storageDtype: 'int32' };
      const result = assignType([], intType, assignment);

      expect(result.stats.count).toBe(0);
      expect(result.stats.min).toBe(0);
      expect(result.stats.max).toBe(0);
      expect(result.stats.mean).toBe(0);
      expect(result.stats.isLossy).toBe(false);
    });
  });
});

describe('text (charN) type assignment', () => {
  const textType: LogicalTypeConfig = { type: 'text', min: 0, max: 0, wordSet: 'cities', generation: 'random' };

  it('is lossless when every word fits the width', () => {
    const values = ['Lima', 'Oslo', 'Nairobi', ''];
    const assignment: TypeAssignment = { storageDtype: 'char8' };
    const result = assignType(values, textType, assignment);

    expect(result.outputDtype).toBe('char8');
    expect(result.bytes.length).toBe(4 * 8);
    expect(result.stats.truncated).toBe(0);
    expect(result.stats.isLossy).toBe(false);
    expect(result.stats.count).toBe(4);
    expect(result.stats.clipped).toBe(0);
    expect(result.stats.rounded).toBe(0);
    expect(result.stats.nanCount).toBe(0);
  });

  it('counts truncated words and flags lossy', () => {
    const values = ['Lima', 'Johannesburg', 'Ulaanbaatar'];
    const result = assignType(values, textType, { storageDtype: 'char8' });
    expect(result.stats.truncated).toBe(2);
    expect(result.stats.isLossy).toBe(true);
  });

  it('roundtrips exactly through bytesToValues when nothing truncates', () => {
    const values = ['Lima', 'Oslo', 'Sao Paulo', 'WX-0042-A'];
    const assignment: TypeAssignment = { storageDtype: 'char16' };
    const result = assignType(values, textType, assignment);
    expect(bytesToValues(result.bytes, assignment.storageDtype)).toEqual(values);
  });

  it('reads a truncated word back as its width-limited prefix', () => {
    const assignment: TypeAssignment = { storageDtype: 'char8' };
    const result = assignType(['Alexandria'], textType, assignment);
    expect(bytesToValues(result.bytes, assignment.storageDtype)).toEqual(['Alexandr']);
  });
});
