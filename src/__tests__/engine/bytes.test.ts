import { describe, it, expect } from 'vitest';
import { hexToBytes, bytesToHex } from '../../engine/bytes.ts';
import { assembleFiles } from '../../engine/write.ts';
import { DEFAULT_STATE } from '../../types/state.ts';
import type { EncodedChunk } from '../../types/pipeline.ts';

function makeEncodedChunk(coords: number[], data: number[]): EncodedChunk {
  return {
    chunkId: `chunk:${coords.join(',')}`,
    coords,
    bytes: new Uint8Array(data),
    traces: data.map((_, i) => ({
      traceId: `var:${i}`,
      variableName: 'var',
      variableColor: '#f00',
      coords: [i],
      displayValue: String(data[i]),
      dtype: 'uint8',
      chunkId: `chunk:${coords.join(',')}`,
      byteInValue: 0,
      byteCount: 1,
    })),
  };
}

describe('hexToBytes', () => {
  it('parses a well-formed hex string', () => {
    const bytes = hexToBytes('00C0DEC5');
    expect(Array.from(bytes)).toEqual([0x00, 0xc0, 0xde, 0xc5]);
  });

  it('handles mixed case', () => {
    const bytes = hexToBytes('Ff00aB');
    expect(Array.from(bytes)).toEqual([0xff, 0x00, 0xab]);
  });

  it('handles empty string', () => {
    expect(hexToBytes('').length).toBe(0);
  });

  it('drops the trailing nibble on odd length: single character', () => {
    expect(hexToBytes('0').length).toBe(0);
  });

  it('drops the trailing nibble on odd length: longer string', () => {
    // '00C0D' cleans to '00C0D' (5 chars); trailing 'D' nibble is dropped,
    // leaving '00C0' -> [0x00, 0xc0].
    const bytes = hexToBytes('00C0D');
    expect(Array.from(bytes)).toEqual([0x00, 0xc0]);
  });

  it('strips non-hex characters entirely: all invalid', () => {
    expect(hexToBytes('GGGG').length).toBe(0);
  });

  it('strips non-hex characters mixed with valid hex', () => {
    // 'zz00' strips to '00' -> [0x00]
    const bytes = hexToBytes('zz00');
    expect(Array.from(bytes)).toEqual([0x00]);
  });

  it('strips whitespace and separators', () => {
    const bytes = hexToBytes('00 C0-DE:C5');
    expect(Array.from(bytes)).toEqual([0x00, 0xc0, 0xde, 0xc5]);
  });

  it('round-trips with bytesToHex', () => {
    const original = new Uint8Array([0x00, 0xc0, 0xde, 0xc5, 0xff, 0x01]);
    expect(hexToBytes(bytesToHex(original))).toEqual(original);
  });
});

describe('bytesToHex', () => {
  it('produces lowercase hex with no separators', () => {
    expect(bytesToHex(new Uint8Array([0x00, 0xc0, 0xde, 0xc5]))).toBe('00c0dec5');
  });

  it('pads single-digit bytes with a leading zero', () => {
    expect(bytesToHex(new Uint8Array([0x00, 0x0f, 0x9]))).toBe('000f09');
  });

  it('handles empty input', () => {
    expect(bytesToHex(new Uint8Array(0))).toBe('');
  });
});

describe('assembleFiles does not throw on malformed magic numbers (CR-1)', () => {
  const chunk = makeEncodedChunk([0], [0x01, 0x02, 0x03]);

  it('does not throw with an odd-length magic number', () => {
    const state = {
      ...DEFAULT_STATE,
      write: { ...DEFAULT_STATE.write, magicNumber: '0' },
    };
    expect(() => assembleFiles(state, [chunk], [1])).not.toThrow();
    const files = assembleFiles(state, [chunk], [1]);
    expect(files.length).toBeGreaterThan(0);
  });

  it('does not throw with a non-hex magic number', () => {
    const state = {
      ...DEFAULT_STATE,
      write: { ...DEFAULT_STATE.write, magicNumber: 'GG' },
    };
    expect(() => assembleFiles(state, [chunk], [1])).not.toThrow();
    const files = assembleFiles(state, [chunk], [1]);
    expect(files.length).toBeGreaterThan(0);
    // 'GG' strips to empty hex -> zero-length magic, so the file is just
    // metadata/chunk bytes with no magic framing.
    expect(files[0].bytes.length).toBeGreaterThan(0);
  });
});
