import { describe, it, expect } from 'vitest';
import { valuesToBytes, bytesToValues, formatValue } from '../../engine/elements.ts';
import { DTYPE_KEYS } from '../../types/dtypes.ts';
import type { DtypeKey } from '../../types/dtypes.ts';

describe('valuesToBytes / bytesToValues roundtrip', () => {
  it.each(DTYPE_KEYS)('roundtrips %s values correctly', (dtype) => {
    const testValues = getTestValues(dtype);
    const bytes = valuesToBytes(testValues, dtype);
    const result = bytesToValues(bytes, dtype);

    if (dtype === 'float32' || dtype === 'float64') {
      expect(result.length).toBe(testValues.length);
      for (let i = 0; i < testValues.length; i++) {
        expect(result[i]).toBeCloseTo(testValues[i], dtype === 'float32' ? 5 : 10);
      }
    } else {
      expect(result).toEqual(testValues);
    }
  });

  it('handles empty input', () => {
    const bytes = valuesToBytes([], 'int32');
    expect(bytes.length).toBe(0);
    const values = bytesToValues(bytes, 'int32');
    expect(values.length).toBe(0);
  });
});

describe('little-endian byte order', () => {
  it('encodes uint16 0x0102 as [0x02, 0x01]', () => {
    const bytes = valuesToBytes([0x0102], 'uint16');
    expect(bytes[0]).toBe(0x02);
    expect(bytes[1]).toBe(0x01);
  });

  it('encodes uint32 0x01020304 as [0x04, 0x03, 0x02, 0x01]', () => {
    const bytes = valuesToBytes([0x01020304], 'uint32');
    expect(bytes[0]).toBe(0x04);
    expect(bytes[1]).toBe(0x03);
    expect(bytes[2]).toBe(0x02);
    expect(bytes[3]).toBe(0x01);
  });

  it('encodes int16 -1 as [0xFF, 0xFF]', () => {
    const bytes = valuesToBytes([-1], 'int16');
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xff);
  });
});

describe('edge values', () => {
  it('handles int8 extremes', () => {
    const values = [-128, 0, 127];
    expect(bytesToValues(valuesToBytes(values, 'int8'), 'int8')).toEqual(values);
  });

  it('handles uint8 extremes', () => {
    const values = [0, 128, 255];
    expect(bytesToValues(valuesToBytes(values, 'uint8'), 'uint8')).toEqual(values);
  });

  it('handles int32 extremes', () => {
    const values = [-2147483648, 0, 2147483647];
    expect(bytesToValues(valuesToBytes(values, 'int32'), 'int32')).toEqual(values);
  });

  it('handles uint32 extremes', () => {
    const values = [0, 2147483648, 4294967295];
    expect(bytesToValues(valuesToBytes(values, 'uint32'), 'uint32')).toEqual(values);
  });

  it('handles float32 special values', () => {
    const bytes = valuesToBytes([0, -0, Infinity, -Infinity], 'float32');
    const result = bytesToValues(bytes, 'float32');
    expect(result[0]).toBe(0);
    expect(result[2]).toBe(Infinity);
    expect(result[3]).toBe(-Infinity);
  });
});

describe('byte count', () => {
  it.each([
    ['int8', 1],
    ['uint8', 1],
    ['int16', 2],
    ['uint16', 2],
    ['int32', 4],
    ['uint32', 4],
    ['float32', 4],
    ['float64', 8],
  ] as [DtypeKey, number][])('%s produces %d bytes per value', (dtype, size) => {
    const bytes = valuesToBytes([0, 0, 0], dtype);
    expect(bytes.length).toBe(3 * size);
  });
});

describe('formatValue', () => {
  it('formats integers as plain numbers', () => {
    expect(formatValue(42, 'int32')).toBe('42');
    expect(formatValue(-7, 'int8')).toBe('-7');
    expect(formatValue(0, 'uint16')).toBe('0');
  });

  it('formats floats with precision', () => {
    const result = formatValue(3.14159265, 'float32');
    expect(result).toBe('3.14159');
  });

  it('formats negative floats', () => {
    const result = formatValue(-123.456, 'float64');
    expect(result).toBe('-123.456');
  });
});

function getTestValues(dtype: DtypeKey): number[] {
  switch (dtype) {
    case 'int8':
      return [-128, -1, 0, 1, 127];
    case 'uint8':
      return [0, 1, 128, 254, 255];
    case 'int16':
      return [-32768, -1, 0, 1, 32767];
    case 'uint16':
      return [0, 1, 32768, 65534, 65535];
    case 'int32':
      return [-2147483648, -1, 0, 1, 2147483647];
    case 'uint32':
      return [0, 1, 2147483648, 4294967294, 4294967295];
    case 'float32':
      return [-1000, -1.5, 0, 1.5, 1000];
    case 'float64':
      return [-1e100, -1.5, 0, 1.5, 1e100];
  }
}
