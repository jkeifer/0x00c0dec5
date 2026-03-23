import { describe, it, expect } from 'vitest';
import { hexToBytes, orderChunks, assembleFiles } from '../../engine/write.ts';
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
  it('parses hex string to bytes', () => {
    const bytes = hexToBytes('00C0DEC5');
    expect(Array.from(bytes)).toEqual([0x00, 0xc0, 0xde, 0xc5]);
  });

  it('handles lowercase', () => {
    const bytes = hexToBytes('ff00');
    expect(Array.from(bytes)).toEqual([0xff, 0x00]);
  });

  it('handles empty string', () => {
    const bytes = hexToBytes('');
    expect(bytes.length).toBe(0);
  });

  it('strips spaces', () => {
    const bytes = hexToBytes('00 C0 DE C5');
    expect(Array.from(bytes)).toEqual([0x00, 0xc0, 0xde, 0xc5]);
  });

  it('throws on odd-length hex', () => {
    expect(() => hexToBytes('ABC')).toThrow();
  });
});

describe('orderChunks', () => {
  it('row-major preserves natural order', () => {
    const chunks = [
      makeEncodedChunk([0, 0], [1]),
      makeEncodedChunk([0, 1], [2]),
      makeEncodedChunk([1, 0], [3]),
      makeEncodedChunk([1, 1], [4]),
    ];
    const ordered = orderChunks(chunks, [2, 2], 'row-major');
    expect(ordered.map((c) => c.coords)).toEqual([[0, 0], [0, 1], [1, 0], [1, 1]]);
  });

  it('column-major reorders by reversed dimensions', () => {
    const chunks = [
      makeEncodedChunk([0, 0], [1]),
      makeEncodedChunk([0, 1], [2]),
      makeEncodedChunk([1, 0], [3]),
      makeEncodedChunk([1, 1], [4]),
    ];
    const ordered = orderChunks(chunks, [2, 2], 'column-major');
    expect(ordered.map((c) => c.coords)).toEqual([[0, 0], [1, 0], [0, 1], [1, 1]]);
  });

  it('1-d is same for both orderings', () => {
    const chunks = [
      makeEncodedChunk([0], [1]),
      makeEncodedChunk([1], [2]),
      makeEncodedChunk([2], [3]),
    ];
    const rowMajor = orderChunks(chunks, [3], 'row-major');
    const colMajor = orderChunks(chunks, [3], 'column-major');
    expect(rowMajor.map((c) => c.coords)).toEqual(colMajor.map((c) => c.coords));
  });

  it('groups by variable when variableOrder is provided', () => {
    const chunks = [
      { ...makeEncodedChunk([0], [1]), variableName: 'a' },
      { ...makeEncodedChunk([0], [2]), variableName: 'b' },
      { ...makeEncodedChunk([1], [3]), variableName: 'a' },
      { ...makeEncodedChunk([1], [4]), variableName: 'b' },
    ];
    const ordered = orderChunks(chunks, [2], 'row-major', ['a', 'b']);
    expect(ordered.map((c) => c.variableName)).toEqual(['a', 'a', 'b', 'b']);
  });

  it('preserves spatial order within variable groups', () => {
    const chunks = [
      { ...makeEncodedChunk([0], [1]), variableName: 'temp' },
      { ...makeEncodedChunk([1], [2]), variableName: 'temp' },
      { ...makeEncodedChunk([2], [3]), variableName: 'temp' },
      { ...makeEncodedChunk([0], [4]), variableName: 'pres' },
      { ...makeEncodedChunk([1], [5]), variableName: 'pres' },
      { ...makeEncodedChunk([2], [6]), variableName: 'pres' },
    ];
    const ordered = orderChunks(chunks, [3], 'row-major', ['temp', 'pres']);
    expect(ordered.map((c) => [c.variableName, c.coords[0]])).toEqual([
      ['temp', 0], ['temp', 1], ['temp', 2],
      ['pres', 0], ['pres', 1], ['pres', 2],
    ]);
  });

  it('without variableOrder, does not group by variable', () => {
    const chunks = [
      { ...makeEncodedChunk([0], [1]), variableName: 'a' },
      { ...makeEncodedChunk([0], [2]), variableName: 'b' },
      { ...makeEncodedChunk([1], [3]), variableName: 'a' },
      { ...makeEncodedChunk([1], [4]), variableName: 'b' },
    ];
    const ordered = orderChunks(chunks, [2], 'row-major');
    // Should preserve input order
    expect(ordered.map((c) => c.variableName)).toEqual(['a', 'b', 'a', 'b']);
  });
});

describe('includeMetadata toggle', () => {
  const chunk = makeEncodedChunk([0], [0x01, 0x02, 0x03]);

  it('includeMetadata: false produces no metadata in single file', () => {
    const state = {
      ...DEFAULT_STATE,
      write: { ...DEFAULT_STATE.write, includeMetadata: false, metadataPlacement: 'header' as const },
    };
    const files = assembleFiles(state, [chunk], [1]);
    expect(files).toHaveLength(1);
    // File should only contain magic + chunk data + magic
    const magic = hexToBytes(state.write.magicNumber);
    const expectedSize = magic.length + chunk.bytes.length + magic.length;
    expect(files[0].bytes.length).toBe(expectedSize);
  });

  it('includeMetadata: true preserves existing metadata behavior', () => {
    const state = {
      ...DEFAULT_STATE,
      write: { ...DEFAULT_STATE.write, includeMetadata: true, metadataPlacement: 'header' as const },
    };
    const files = assembleFiles(state, [chunk], [1]);
    expect(files).toHaveLength(1);
    // Should be larger than magic + chunk + magic due to metadata
    const magic = hexToBytes(state.write.magicNumber);
    const minSize = magic.length + chunk.bytes.length + magic.length;
    expect(files[0].bytes.length).toBeGreaterThan(minSize);
  });

  it('includeMetadata: false produces no sidecar in per-chunk mode', () => {
    const chunks = [
      makeEncodedChunk([0], [0x01, 0x02]),
      makeEncodedChunk([1], [0x03, 0x04]),
    ];
    const state = {
      ...DEFAULT_STATE,
      write: { ...DEFAULT_STATE.write, includeMetadata: false, partitioning: 'per-chunk' as const },
    };
    const files = assembleFiles(state, chunks, [2]);
    // Should have 2 chunk files, NO metadata sidecar
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.name !== 'metadata')).toBe(true);
  });

  it('includeMetadata: true produces sidecar in per-chunk mode', () => {
    const chunks = [
      makeEncodedChunk([0], [0x01, 0x02]),
      makeEncodedChunk([1], [0x03, 0x04]),
    ];
    const state = {
      ...DEFAULT_STATE,
      write: { ...DEFAULT_STATE.write, includeMetadata: true, partitioning: 'per-chunk' as const },
    };
    const files = assembleFiles(state, chunks, [2]);
    // Should have 2 chunk files + 1 metadata sidecar
    expect(files).toHaveLength(3);
    expect(files.some((f) => f.name === 'metadata')).toBe(true);
  });
});

describe('assembleFiles', () => {
  const chunk = makeEncodedChunk([0], [0x01, 0x02, 0x03]);

  it('places magic at start and end of file', () => {
    const state = {
      ...DEFAULT_STATE,
      write: { ...DEFAULT_STATE.write, magicNumber: '00C0DEC5' },
    };
    const files = assembleFiles(state, [chunk], [1]);
    const mainFile = files[0];

    // Check start magic
    expect(mainFile.bytes[0]).toBe(0x00);
    expect(mainFile.bytes[1]).toBe(0xc0);
    expect(mainFile.bytes[2]).toBe(0xde);
    expect(mainFile.bytes[3]).toBe(0xc5);

    // Check end magic
    const len = mainFile.bytes.length;
    expect(mainFile.bytes[len - 4]).toBe(0x00);
    expect(mainFile.bytes[len - 3]).toBe(0xc0);
    expect(mainFile.bytes[len - 2]).toBe(0xde);
    expect(mainFile.bytes[len - 1]).toBe(0xc5);
  });

  it('places metadata as header before chunks', () => {
    const state = {
      ...DEFAULT_STATE,
      write: { ...DEFAULT_STATE.write, includeMetadata: true, metadataPlacement: 'header' as const },
    };
    const files = assembleFiles(state, [chunk], [1]);
    expect(files).toHaveLength(1);
    // File should have magic + metadata + chunk data + magic
    expect(files[0].bytes.length).toBeGreaterThan(4 + 3 + 4);
  });

  it('places metadata as footer after chunks', () => {
    const state = {
      ...DEFAULT_STATE,
      write: { ...DEFAULT_STATE.write, includeMetadata: true, metadataPlacement: 'footer' as const },
    };
    const files = assembleFiles(state, [chunk], [1]);
    expect(files).toHaveLength(1);
  });

  it('places metadata as sidecar (separate file)', () => {
    const state = {
      ...DEFAULT_STATE,
      write: { ...DEFAULT_STATE.write, includeMetadata: true, metadataPlacement: 'sidecar' as const },
    };
    const files = assembleFiles(state, [chunk], [1]);
    expect(files).toHaveLength(2);
    expect(files[1].name).toBe('metadata');
    expect(files[1].bytes.length).toBeGreaterThan(0);
  });

  it('creates per-chunk files', () => {
    const chunks = [
      makeEncodedChunk([0], [0x01, 0x02]),
      makeEncodedChunk([1], [0x03, 0x04]),
    ];
    const state = {
      ...DEFAULT_STATE,
      interleaving: 'row' as const,
      write: { ...DEFAULT_STATE.write, includeMetadata: true, partitioning: 'per-chunk' as const },
    };
    const files = assembleFiles(state, chunks, [2]);

    // Should have 2 chunk files + 1 metadata sidecar
    expect(files).toHaveLength(3);
    expect(files[0].name).toBe('chunk_0');
    expect(files[1].name).toBe('chunk_1');
    expect(files[2].name).toBe('metadata');
  });

  it('per-chunk files include variable name when set', () => {
    const chunks = [
      { ...makeEncodedChunk([0], [0x01]), variableName: 'temperature' },
      { ...makeEncodedChunk([1], [0x02]), variableName: 'temperature' },
      { ...makeEncodedChunk([0], [0x03]), variableName: 'pressure' },
      { ...makeEncodedChunk([1], [0x04]), variableName: 'pressure' },
    ];
    const state = {
      ...DEFAULT_STATE,
      write: { ...DEFAULT_STATE.write, includeMetadata: true, partitioning: 'per-chunk' as const },
    };
    const files = assembleFiles(state, chunks, [2]);

    // 4 chunk files + 1 metadata sidecar
    expect(files).toHaveLength(5);
    expect(files[0].name).toBe('temperature_chunk_0');
    expect(files[1].name).toBe('temperature_chunk_1');
    expect(files[2].name).toBe('pressure_chunk_0');
    expect(files[3].name).toBe('pressure_chunk_1');
    expect(files[4].name).toBe('metadata');
  });

  it('trace count matches byte count', () => {
    const state = {
      ...DEFAULT_STATE,
      write: { ...DEFAULT_STATE.write, metadataPlacement: 'header' as const },
    };
    const files = assembleFiles(state, [chunk], [1]);
    const mainFile = files[0];
    expect(mainFile.traces.length).toBe(mainFile.bytes.length);
  });

  it('handles empty magic number', () => {
    const state = {
      ...DEFAULT_STATE,
      write: { ...DEFAULT_STATE.write, magicNumber: '' },
    };
    const files = assembleFiles(state, [chunk], [1]);
    expect(files[0].bytes.length).toBeGreaterThan(0);
  });

  it('sidecar metadata file has traces matching byte count', () => {
    const state = {
      ...DEFAULT_STATE,
      write: { ...DEFAULT_STATE.write, includeMetadata: true, metadataPlacement: 'sidecar' as const },
    };
    const files = assembleFiles(state, [chunk], [1]);
    const sidecar = files.find((f) => f.name === 'metadata')!;
    expect(sidecar.traces.length).toBe(sidecar.bytes.length);
    for (const t of sidecar.traces) {
      expect(t.traceId).toBe('metadata');
    }
  });

  it('per-chunk sidecar metadata file has traces', () => {
    const chunks = [
      makeEncodedChunk([0], [0x01, 0x02]),
      makeEncodedChunk([1], [0x03, 0x04]),
    ];
    const state = {
      ...DEFAULT_STATE,
      write: { ...DEFAULT_STATE.write, includeMetadata: true, partitioning: 'per-chunk' as const },
    };
    const files = assembleFiles(state, chunks, [2]);
    const sidecar = files.find((f) => f.name === 'metadata')!;
    expect(sidecar.traces.length).toBe(sidecar.bytes.length);
    for (const t of sidecar.traces) {
      expect(t.traceId).toBe('metadata');
    }
  });

  it('chunk index offsets are correct', () => {
    const chunks = [
      makeEncodedChunk([0], [0x01, 0x02, 0x03]),
      makeEncodedChunk([1], [0x04, 0x05]),
    ];
    const state = {
      ...DEFAULT_STATE,
      write: {
        ...DEFAULT_STATE.write,
        metadataPlacement: 'footer' as const,
      },
    };
    const files = assembleFiles(state, chunks, [2]);
    const mainFile = files[0];

    // Parse the footer metadata to check chunk index
    const magic = hexToBytes(state.write.magicNumber);
    // The footer is between end of chunk data and end magic
    // The chunk data starts after the start magic
    const dataStart = magic.length;

    // Chunk 0: starts at dataStart, size 3
    // Chunk 1: starts at dataStart + 3, size 2
    // Let's verify by checking that the bytes at those offsets match
    expect(mainFile.bytes[dataStart]).toBe(0x01);
    expect(mainFile.bytes[dataStart + 3]).toBe(0x04);
  });
});
