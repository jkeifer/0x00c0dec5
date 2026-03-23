import { describe, it, expect } from 'vitest';
import { assignType, reverseTypeAssignment } from '../../engine/typeAssign.ts';
import type { LogicalTypeConfig, TypeAssignment } from '../../types/state.ts';

describe('assignType', () => {
  describe('integer logical type', () => {
    const intType: LogicalTypeConfig = { type: 'integer', min: 0, max: 100 };

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
      const negType: LogicalTypeConfig = { type: 'integer', min: -200, max: 200 };
      const values = [-200, 0, 200]; // -200 and 200 exceed int8 range [-128, 127]
      const assignment: TypeAssignment = { storageDtype: 'int8' };
      const result = assignType(values, negType, assignment);

      expect(result.stats.isLossy).toBe(true);
      expect(result.stats.clipped).toBe(2);
    });
  });

  describe('decimal logical type', () => {
    const decType: LogicalTypeConfig = { type: 'decimal', min: -50, max: 50, decimalPlaces: 1 };

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

    it('stores decimal with scale/offset into int16 losslessly', () => {
      // values like 23.4 * 10 = 234, fits in int16
      const values = [23.4, -12.7, 0.0];
      const assignment: TypeAssignment = { storageDtype: 'int16', scale: 10, offset: 0 };
      const result = assignType(values, decType, assignment);

      expect(result.outputDtype).toBe('int16');
      expect(result.stats.clipped).toBe(0);
      expect(result.stats.rounded).toBe(0);
      expect(result.stats.isLossy).toBe(false);
    });

    it('detects rounding when scale/offset produces non-integer for int storage', () => {
      // 23.4 * 3 = 70.2, rounds to 70 → lossy
      const values = [23.4];
      const assignment: TypeAssignment = { storageDtype: 'int16', scale: 3, offset: 0 };
      const result = assignType(values, decType, assignment);

      expect(result.stats.rounded).toBe(1);
      expect(result.stats.isLossy).toBe(true);
    });
  });

  describe('continuous logical type', () => {
    const contType: LogicalTypeConfig = { type: 'continuous', min: -1000, max: 1000, significantFigures: 6 };

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

  describe('keepBits (mantissa truncation)', () => {
    it('applies bitround to float32 output', () => {
      const values = [3.14159265];
      const contType: LogicalTypeConfig = { type: 'continuous', min: 0, max: 10, significantFigures: 9 };
      const assignment: TypeAssignment = { storageDtype: 'float32', keepBits: 5 };
      const result = assignType(values, contType, assignment);

      expect(result.outputDtype).toBe('float32');
      expect(result.stats.isLossy).toBe(true);
    });
  });

  describe('statistics', () => {
    it('computes min, max, mean correctly', () => {
      const values = [10, 20, 30];
      const intType: LogicalTypeConfig = { type: 'integer', min: 0, max: 100 };
      const assignment: TypeAssignment = { storageDtype: 'int32' };
      const result = assignType(values, intType, assignment);

      expect(result.stats.min).toBe(10);
      expect(result.stats.max).toBe(30);
      expect(result.stats.mean).toBe(20);
      expect(result.stats.count).toBe(3);
    });

    it('handles empty values', () => {
      const intType: LogicalTypeConfig = { type: 'integer', min: 0, max: 100 };
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

describe('reverseTypeAssignment', () => {
  it('reverses identity assignment (no scale/offset)', () => {
    const values = [10, 20, 30];
    const intType: LogicalTypeConfig = { type: 'integer', min: 0, max: 100 };
    const assignment: TypeAssignment = { storageDtype: 'int32' };
    const { bytes } = assignType(values, intType, assignment);

    const reversed = reverseTypeAssignment(bytes, assignment);
    expect(reversed).toEqual(values);
  });

  it('reverses scale/offset assignment', () => {
    const values = [23.4, -12.7, 0.0];
    const decType: LogicalTypeConfig = { type: 'decimal', min: -50, max: 50, decimalPlaces: 1 };
    const assignment: TypeAssignment = { storageDtype: 'int16', scale: 10, offset: 0 };
    const { bytes } = assignType(values, decType, assignment);

    const reversed = reverseTypeAssignment(bytes, assignment);
    for (let i = 0; i < values.length; i++) {
      expect(reversed[i]).toBeCloseTo(values[i], 5);
    }
  });

  it('reverses scale/offset with non-zero offset', () => {
    const values = [900, 1000, 1100];
    const decType: LogicalTypeConfig = { type: 'decimal', min: 900, max: 1100, decimalPlaces: 0 };
    const assignment: TypeAssignment = { storageDtype: 'int16', scale: 1, offset: 900 };
    const { bytes } = assignType(values, decType, assignment);

    const reversed = reverseTypeAssignment(bytes, assignment);
    expect(reversed).toEqual([900, 1000, 1100]);
  });

  it('reversal is approximate for lossy assignments', () => {
    // float32 storage of decimal value — some precision lost
    const values = [23.4];
    const decType: LogicalTypeConfig = { type: 'decimal', min: -50, max: 50, decimalPlaces: 1 };
    const assignment: TypeAssignment = { storageDtype: 'float32' };
    const { bytes } = assignType(values, decType, assignment);

    const reversed = reverseTypeAssignment(bytes, assignment);
    expect(reversed[0]).toBeCloseTo(23.4, 5);
  });
});
