import { describe, it, expect } from 'vitest';
import { readFile, parseStructure } from '../../../src/engine/read.ts';
import { computePipelineStages } from '../../../src/hooks/usePipeline.ts';
import { DEFAULT_STATE, type AppState } from '../../../src/types/state.ts';
import { generateValues } from '../../../src/engine/generate.ts';
import { hexToBytes } from '../../../src/engine/bytes.ts';
import type { MetadataEntry } from '../../../src/engine/metadata.ts';
import { locateMetadata } from '../../../src/engine/readLocate.ts';
import { encodeMetadataBinary } from '../../../src/engine/metadataBinary.ts';
import type { VirtualFile } from '../../../src/types/pipeline.ts';

function stateWith(overrides: Partial<AppState>): AppState {
  return { ...DEFAULT_STATE, ...overrides };
}

function deepMerge(base: AppState, overrides: Record<string, unknown>): AppState {
  const result = { ...base } as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = {
        ...(result[key] as Record<string, unknown>),
        ...(value as Record<string, unknown>),
      };
    } else {
      result[key] = value;
    }
  }
  return result as unknown as AppState;
}

describe('readFile — failure cases', () => {
  it('fails when no metadata is included (default state)', () => {
    const state = stateWith({
      write: { ...DEFAULT_STATE.write },
    });
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('no-metadata');
      expect(result.message).toContain('Cannot read file');
      expect(result.message).toContain('no metadata');
    }
  });

  it('failure result includes byte count', () => {
    const state = stateWith({
      write: { ...DEFAULT_STATE.write },
    });
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });
    if (!result.success) {
      expect(result.byteCount).toBeGreaterThan(0);
      expect(result.message).toContain('bytes');
    }
  });
});

describe('readFile — lossless roundtrip (column mode, header metadata)', () => {
  it('reconstructs values within tolerance with no codecs', () => {
    const state = deepMerge(DEFAULT_STATE, {
      metadata: { include: { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true, endianness: true }, enabled: true },
      write: { metadataPlacement: 'header' },
    }) as AppState;
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });

    expect(result.success).toBe(true);
    if (result.success) {
      const totalElements = state.shape.reduce((a, b) => a * b, 1);
      for (const v of state.variables) {
        const expected = generateValues(v.name, v.logicalType, totalElements);
        const actual = result.reconstructedValues.get(v.name);
        expect(actual).toBeDefined();
        expect(actual!.length).toBe(expected.length);
        for (let i = 0; i < expected.length; i++) {
          expect(actual![i]).toBeCloseTo(expected[i] as number, 4);
        }
      }
    }
  });
});

describe('readFile — lossless roundtrip (column mode, footer metadata)', () => {
  it('reconstructs values with footer placement', () => {
    const state = deepMerge(DEFAULT_STATE, {
      metadata: { include: { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true, endianness: true }, enabled: true },
      write: { metadataPlacement: 'footer' },
    }) as AppState;
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });

    expect(result.success).toBe(true);
    if (result.success) {
      const totalElements = state.shape.reduce((a, b) => a * b, 1);
      for (const v of state.variables) {
        const expected = generateValues(v.name, v.logicalType, totalElements);
        const actual = result.reconstructedValues.get(v.name);
        expect(actual).toBeDefined();
        expect(actual!.length).toBe(expected.length);
        for (let i = 0; i < expected.length; i++) {
          expect(actual![i]).toBeCloseTo(expected[i] as number, 4);
        }
      }
    }
  });
});

describe('readFile — lossless roundtrip (column mode, sidecar metadata)', () => {
  it('reconstructs values with sidecar metadata', () => {
    const state = deepMerge(DEFAULT_STATE, {
      metadata: { include: { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true, endianness: true }, enabled: true },
      write: { metadataPlacement: 'sidecar' },
    }) as AppState;
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });

    expect(result.success).toBe(true);
    if (result.success) {
      const totalElements = state.shape.reduce((a, b) => a * b, 1);
      for (const v of state.variables) {
        const expected = generateValues(v.name, v.logicalType, totalElements);
        const actual = result.reconstructedValues.get(v.name);
        expect(actual).toBeDefined();
        expect(actual!.length).toBe(expected.length);
        for (let i = 0; i < expected.length; i++) {
          expect(actual![i]).toBeCloseTo(expected[i] as number, 4);
        }
      }
    }
  });
});

describe('readFile — row mode roundtrip', () => {
  it('reconstructs values in row mode with metadata', () => {
    const state = deepMerge(DEFAULT_STATE, {
      interleaving: 'row',
      metadata: { include: { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true, endianness: true }, enabled: true },
      write: { metadataPlacement: 'header' },
    }) as AppState;
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });

    expect(result.success).toBe(true);
    if (result.success) {
      const totalElements = state.shape.reduce((a, b) => a * b, 1);
      for (const v of state.variables) {
        const expected = generateValues(v.name, v.logicalType, totalElements);
        const actual = result.reconstructedValues.get(v.name);
        expect(actual).toBeDefined();
        expect(actual!.length).toBe(expected.length);
        for (let i = 0; i < expected.length; i++) {
          expect(actual![i]).toBeCloseTo(expected[i] as number, 4);
        }
      }
    }
  });
});

describe('readFile — lossy roundtrip (type assignment with float32 storage)', () => {
  it('detects lossy variables via statistics and reconstructs within tolerance', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      variables: [
        {
          id: 'temp', name: 'temperature', color: '#e06c75',
          logicalType: { type: 'decimal', min: -50, max: 50, decimalPlaces: 1, generation: 'random' },
          typeAssignment: { storageDtype: 'float32' },
        },
      ],
      fieldPipelines: { temperature: [] },
      metadata: { ...DEFAULT_STATE.metadata, enabled: true, include: { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true, endianness: true } },
      write: { ...DEFAULT_STATE.write, metadataPlacement: 'header' },
    };
    const { files, variableStats } = computePipelineStages(state);

    // float32 can't exactly represent decimal values like 23.4
    // (variableStats is keyed by Variable.id — S2)
    const tempStats = variableStats.get('temp')!;
    expect(tempStats.isLossy).toBe(true);
    expect(tempStats.rounded).toBeGreaterThan(0);

    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.lossyVariables.has('temperature')).toBe(true);
      const totalElements = state.shape.reduce((a, b) => a * b, 1);
      const expected = generateValues('temperature', state.variables[0].logicalType, totalElements) as number[];
      const actual = result.reconstructedValues.get('temperature')! as number[];
      expect(actual.length).toBe(expected.length);
      for (let i = 0; i < expected.length; i++) {
        expect(Math.abs(actual[i] - expected[i])).toBeLessThan(0.01);
      }
    }
  });
});

describe('readFile — lossless roundtrip with scale/offset type assignment', () => {
  it('reconstructs decimal values via int16 + scale/offset', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      variables: [
        {
          id: 'temp', name: 'temperature', color: '#e06c75',
          logicalType: { type: 'decimal', min: -50, max: 50, decimalPlaces: 1, generation: 'random' },
          typeAssignment: { storageDtype: 'int16', scale: 10, offset: 0 },
        },
      ],
      fieldPipelines: { temperature: [] },
      metadata: { ...DEFAULT_STATE.metadata, enabled: true, include: { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true, endianness: true } },
      write: { ...DEFAULT_STATE.write, metadataPlacement: 'header' },
    };
    const { files, variableStats } = computePipelineStages(state);

    // int16 with scale=10 should be lossless for decimal values with 1 decimal place
    // (variableStats is keyed by Variable.id — S2)
    const tempStats = variableStats.get('temp')!;
    expect(tempStats.isLossy).toBe(false);

    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.lossyVariables.has('temperature')).toBe(false);
      const totalElements = state.shape.reduce((a, b) => a * b, 1);
      const expected = generateValues('temperature', state.variables[0].logicalType, totalElements) as number[];
      const actual = result.reconstructedValues.get('temperature')! as number[];
      expect(actual.length).toBe(expected.length);
      for (let i = 0; i < expected.length; i++) {
        expect(actual[i]).toBeCloseTo(expected[i], 5);
      }
    }
  });
});

describe('readFile — per-chunk partitioning with sidecar', () => {
  it('reconstructs from per-chunk files', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      shape: [8],
      chunkShape: [4],
      variables: [
        {
          id: 'temp', name: 'temperature', color: '#e06c75',
          logicalType: { type: 'decimal', min: -50, max: 50, decimalPlaces: 1, generation: 'random' },
          typeAssignment: { storageDtype: 'float32' },
        },
      ],
      fieldPipelines: { temperature: [] },
      metadata: {
        ...DEFAULT_STATE.metadata,
        enabled: true,
        include: { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true, endianness: true },
      },
      write: {
        ...DEFAULT_STATE.write,
        partitioning: 'per-chunk',
      },
    };
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });

    expect(result.success).toBe(true);
    if (result.success) {
      const totalElements = state.shape.reduce((a, b) => a * b, 1);
      const expected = generateValues('temperature', state.variables[0].logicalType, totalElements) as number[];
      const actual = result.reconstructedValues.get('temperature')! as number[];
      expect(actual.length).toBe(expected.length);
      for (let i = 0; i < expected.length; i++) {
        expect(actual[i]).toBeCloseTo(expected[i], 4);
      }
    }
  });
});

describe('readFile — multiple chunks in single file', () => {
  it('handles multiple chunks with column interleaving', () => {
    const state = deepMerge(DEFAULT_STATE, {
      shape: [16],
      chunkShape: [8],
      metadata: { include: { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true, endianness: true }, enabled: true },
      write: { metadataPlacement: 'footer' },
    }) as AppState;
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });

    expect(result.success).toBe(true);
    if (result.success) {
      for (const v of state.variables) {
        const expected = generateValues(v.name, v.logicalType, 16);
        const actual = result.reconstructedValues.get(v.name);
        expect(actual).toBeDefined();
        expect(actual!.length).toBe(expected.length);
        for (let i = 0; i < expected.length; i++) {
          expect(actual![i]).toBeCloseTo(expected[i] as number, 4);
        }
      }
    }
  });
});

describe('readFile — 2-D multi-chunk reassembly (task 2.1)', () => {
  it('reconstructs exact values for shape [4,4] chunkShape [2,2] column mode via chunk_index coords', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      shape: [4, 4],
      chunkShape: [2, 2],
      variables: [
        {
          id: 'humidity', name: 'humidity', color: '#98c379',
          logicalType: { type: 'integer', min: 0, max: 100, generation: 'random' },
          typeAssignment: { storageDtype: 'uint16' },
        },
      ],
      fieldPipelines: { humidity: [] },
      metadata: { ...DEFAULT_STATE.metadata, enabled: true, include: { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true, endianness: true } },
      write: { ...DEFAULT_STATE.write, metadataPlacement: 'header' },
    };
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });

    expect(result.success).toBe(true);
    if (result.success) {
      const expected = generateValues('humidity', state.variables[0].logicalType, 16);
      const actual = result.reconstructedValues.get('humidity');
      expect(actual).toEqual(expected);
    }
  });

  it('reconstructs exact values for per-chunk 2-D files matched by coords, not filename order', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      shape: [4, 4],
      chunkShape: [2, 2],
      variables: [
        {
          id: 'humidity', name: 'humidity', color: '#98c379',
          logicalType: { type: 'integer', min: 0, max: 100, generation: 'random' },
          typeAssignment: { storageDtype: 'uint16' },
        },
      ],
      fieldPipelines: { humidity: [] },
      metadata: {
        ...DEFAULT_STATE.metadata,
        enabled: true,
        include: { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true, endianness: true },
      },
      write: {
        ...DEFAULT_STATE.write,
        partitioning: 'per-chunk',
      },
    };
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });

    expect(result.success).toBe(true);
    if (result.success) {
      const expected = generateValues('humidity', state.variables[0].logicalType, 16);
      const actual = result.reconstructedValues.get('humidity');
      expect(actual).toEqual(expected);
    }
  });
});

describe('readFile — Task 5: synthetic index, chunk order, reader selection', () => {
  // Common: include.chunkIndex OFF so resolveChunkIndex must synthesize.
  const includeNoChunkIndex = {
    schema: true, layout: true, codecs: true,
    chunkIndex: false, descriptive: true, endianness: true,
  };

  it('per-chunk files + size-changing codec + no chunk index: read succeeds', () => {
    // per-chunk reader resolves chunks by FILENAME from coords and ignores
    // offset/size, so a size-changing (rle) codec must NOT trip the
    // no-chunk-index guard. Pre-fix this throws NoChunkIndexError.
    const state: AppState = {
      ...DEFAULT_STATE,
      shape: [8],
      chunkShape: [4],
      variables: [
        {
          id: 'temp', name: 'temperature', color: '#e06c75',
          logicalType: { type: 'integer', min: 0, max: 5, generation: 'random' },
          typeAssignment: { storageDtype: 'uint8' },
        },
      ],
      fieldPipelines: { temp: [{ codec: 'rle', params: {} }] },
      metadata: { ...DEFAULT_STATE.metadata, enabled: true, include: includeNoChunkIndex },
      write: { ...DEFAULT_STATE.write, partitioning: 'per-chunk' },
    };
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });

    expect(result.success).toBe(true);
    if (result.success) {
      const expected = generateValues('temperature', state.variables[0].logicalType, 8) as number[];
      const actual = result.reconstructedValues.get('temperature')! as number[];
      expect(actual.length).toBe(expected.length);
      for (let i = 0; i < expected.length; i++) {
        expect(actual[i]).toBeCloseTo(expected[i], 4);
      }
    }
  });

  it('single file + column-major chunk order + no chunk index: reconstructs correctly', () => {
    // >=2 chunks in each of 2 dims so order matters; size-preserving pipeline.
    // The single file lays chunks out column-major; the synthetic index must
    // enumerate coords in that same order. Pre-fix the synthetic index is
    // row-major and values reassemble scrambled.
    const state: AppState = {
      ...DEFAULT_STATE,
      shape: [4, 4],
      chunkShape: [2, 2],
      variables: [
        {
          id: 'humidity', name: 'humidity', color: '#98c379',
          logicalType: { type: 'integer', min: 0, max: 100, generation: 'random' },
          typeAssignment: { storageDtype: 'uint16' },
        },
      ],
      fieldPipelines: { humidity: [] },
      metadata: { ...DEFAULT_STATE.metadata, enabled: true, include: includeNoChunkIndex },
      write: { ...DEFAULT_STATE.write, metadataPlacement: 'footer', chunkOrder: 'column-major' },
    };
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });

    expect(result.success).toBe(true);
    if (result.success) {
      const expected = generateValues('humidity', state.variables[0].logicalType, 16);
      const actual = result.reconstructedValues.get('humidity');
      expect(actual).toEqual(expected);
    }
  });

  it('single chunk, per-chunk partitioning: read succeeds (reader selected by partitioning)', () => {
    // shape == chunkShape => 1 chunk file. Pre-fix dataFiles.length===1 chose
    // the single-file reader, which slices by offset/size and mis-reads a
    // per-chunk file (whose only real offset is past its own leading magic).
    const state: AppState = {
      ...DEFAULT_STATE,
      shape: [4],
      chunkShape: [4],
      variables: [
        {
          id: 'temp', name: 'temperature', color: '#e06c75',
          logicalType: { type: 'integer', min: 0, max: 100, generation: 'random' },
          typeAssignment: { storageDtype: 'uint16' },
        },
      ],
      fieldPipelines: { temperature: [] },
      metadata: { ...DEFAULT_STATE.metadata, enabled: true, include: includeNoChunkIndex },
      write: { ...DEFAULT_STATE.write, partitioning: 'per-chunk' },
    };
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });

    expect(result.success).toBe(true);
    if (result.success) {
      const expected = generateValues('temperature', state.variables[0].logicalType, 4);
      const actual = result.reconstructedValues.get('temperature');
      expect(actual).toEqual(expected);
    }
  });

  it('single file + entropy codec + no chunk index still fails no-chunk-index', () => {
    // Unchanged lesson: single-file mode DOES need offsets, and a size-changing
    // codec makes them underivable without a real index.
    const state: AppState = {
      ...DEFAULT_STATE,
      shape: [8],
      chunkShape: [4],
      variables: [
        {
          id: 'temp', name: 'temperature', color: '#e06c75',
          logicalType: { type: 'integer', min: 0, max: 5, generation: 'random' },
          typeAssignment: { storageDtype: 'uint8' },
        },
      ],
      fieldPipelines: { temp: [{ codec: 'rle', params: {} }] },
      metadata: { ...DEFAULT_STATE.metadata, enabled: true, include: includeNoChunkIndex },
      write: { ...DEFAULT_STATE.write, partitioning: 'single', metadataPlacement: 'footer' },
    };
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('no-chunk-index');
    }
  });
});

describe('readFile — Task 6: fixed-ratio chunk-index synthesis & column round-trips', () => {
  it('scale-offset column pipeline round-trips through write/read', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      shape: [4],
      variables: [
        {
          id: 'temp', name: 'temperature', color: '#e06c75',
          logicalType: { type: 'decimal', min: -50, max: 50, decimalPlaces: 1, generation: 'random' },
          typeAssignment: { storageDtype: 'float32' },
        },
      ],
      fieldPipelines: {
        temp: [{ codec: 'scale-offset', params: { scale: 10, offset: 0, sourceDtype: 'float32', targetDtype: 'int16' } }],
      },
      metadata: { ...DEFAULT_STATE.metadata, enabled: true, include: { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true, endianness: true } },
      write: { ...DEFAULT_STATE.write, metadataPlacement: 'header' },
    };
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });

    expect(result.success).toBe(true);
    if (result.success) {
      const totalElements = state.shape.reduce((a, b) => a * b, 1);
      const expected = generateValues('temperature', state.variables[0].logicalType, totalElements) as number[];
      const actual = result.reconstructedValues.get('temperature')! as number[];
      expect(actual.length).toBe(expected.length);
      for (let i = 0; i < expected.length; i++) {
        expect(actual[i]).toBeCloseTo(expected[i], 1);
      }
    }
  });

  it('chunk-index OFF + fixed-ratio (scale-offset) pipeline still reads: offsets derived from geometry x ratio', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      shape: [8],
      chunkShape: [4],
      variables: [
        {
          id: 'temp', name: 'temperature', color: '#e06c75',
          logicalType: { type: 'decimal', min: -50, max: 50, decimalPlaces: 1, generation: 'random' },
          typeAssignment: { storageDtype: 'float32' },
        },
      ],
      fieldPipelines: {
        temp: [{ codec: 'scale-offset', params: { scale: 10, offset: 0, sourceDtype: 'float32', targetDtype: 'int16' } }],
      },
      metadata: {
        ...DEFAULT_STATE.metadata,
        enabled: true,
        include: { schema: true, layout: true, codecs: true, chunkIndex: false, descriptive: true, endianness: true },
      },
      write: { ...DEFAULT_STATE.write, partitioning: 'single', metadataPlacement: 'footer' },
    };
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });

    expect(result.success).toBe(true);
    if (result.success) {
      const totalElements = state.shape.reduce((a, b) => a * b, 1);
      const expected = generateValues('temperature', state.variables[0].logicalType, totalElements) as number[];
      const actual = result.reconstructedValues.get('temperature')! as number[];
      expect(actual.length).toBe(expected.length);
      for (let i = 0; i < expected.length; i++) {
        expect(actual[i]).toBeCloseTo(expected[i], 1);
      }
    }
  });

  it('chunk-index OFF + entropy codec (rle) still fails no-chunk-index', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      shape: [8],
      chunkShape: [4],
      variables: [
        {
          id: 'temp', name: 'temperature', color: '#e06c75',
          logicalType: { type: 'integer', min: 0, max: 5, generation: 'random' },
          typeAssignment: { storageDtype: 'uint8' },
        },
      ],
      fieldPipelines: { temp: [{ codec: 'rle', params: {} }] },
      metadata: {
        ...DEFAULT_STATE.metadata,
        enabled: true,
        include: { schema: true, layout: true, codecs: true, chunkIndex: false, descriptive: true, endianness: true },
      },
      write: { ...DEFAULT_STATE.write, partitioning: 'single', metadataPlacement: 'footer' },
    };
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('no-chunk-index');
    }
  });

  it('codecs group OFF + scale-offset hard-fails on byte-count mismatch (decode-error)', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      shape: [4],
      variables: [
        {
          id: 'temp', name: 'temperature', color: '#e06c75',
          logicalType: { type: 'decimal', min: -50, max: 50, decimalPlaces: 1, generation: 'random' },
          typeAssignment: { storageDtype: 'float32' },
        },
      ],
      fieldPipelines: {
        temp: [{ codec: 'scale-offset', params: { scale: 10, offset: 0, sourceDtype: 'float32', targetDtype: 'int16' } }],
      },
      metadata: {
        ...DEFAULT_STATE.metadata,
        enabled: true,
        include: { schema: true, layout: true, codecs: false, chunkIndex: true, descriptive: true, endianness: true },
      },
      write: { ...DEFAULT_STATE.write, metadataPlacement: 'header' },
    };
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('decode-error');
    }
  });

  it('codecs group OFF + quantize reads successfully with the quantized values (identity decode)', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      shape: [4],
      variables: [
        {
          id: 'temp', name: 'temperature', color: '#e06c75',
          logicalType: { type: 'decimal', min: -50, max: 50, decimalPlaces: 3, generation: 'random' },
          typeAssignment: { storageDtype: 'float32' },
        },
      ],
      fieldPipelines: {
        temp: [{ codec: 'quantize', params: { digits: 1 } }],
      },
      metadata: {
        ...DEFAULT_STATE.metadata,
        enabled: true,
        include: { schema: true, layout: true, codecs: false, chunkIndex: true, descriptive: true, endianness: true },
      },
      write: { ...DEFAULT_STATE.write, metadataPlacement: 'header' },
    };
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });

    expect(result.success).toBe(true);
    if (result.success) {
      const totalElements = state.shape.reduce((a, b) => a * b, 1);
      const rawValues = generateValues('temperature', state.variables[0].logicalType, totalElements) as number[];
      // quantize rounds to 1 digit but is size/dtype-preserving with identity
      // decode: the stored (and thus reconstructed) values ARE the quantized
      // originals, not the raw pre-quantize values.
      const expectedQuantized = rawValues.map((v) => Math.round(v * 10) / 10);
      const actual = result.reconstructedValues.get('temperature')! as number[];
      expect(actual.length).toBe(expectedQuantized.length);
      for (let i = 0; i < expectedQuantized.length; i++) {
        expect(actual[i]).toBeCloseTo(expectedQuantized[i], 4);
      }
    }
  });
});

describe('readFile — JSON and binary metadata formats', () => {
  it('reads JSON metadata successfully', () => {
    const state = deepMerge(DEFAULT_STATE, {
      metadata: {
        customEntries: [], serialization: 'json', enabled: true,
        include: { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true, endianness: true },
      },
      write: { metadataPlacement: 'header' },
    }) as AppState;
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });
    expect(result.success).toBe(true);
  });

  it('reads binary metadata successfully', () => {
    const state = deepMerge(DEFAULT_STATE, {
      metadata: {
        customEntries: [], serialization: 'binary', enabled: true,
        include: { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true, endianness: true },
      },
      write: { metadataPlacement: 'header' },
    }) as AppState;
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });
    expect(result.success).toBe(true);
  });
});

describe('parseStructure — partitioning and chunkOrder', () => {
  function entriesWith(overrides: Record<string, string>): MetadataEntry[] {
    const base: Record<string, string> = {
      schema: JSON.stringify([{ name: 'a', dtype: 'int32', logicalType: 'integer' }]),
      shape: JSON.stringify([2]),
      chunk_shape: JSON.stringify([2]),
    };
    return Object.entries({ ...base, ...overrides }).map(([key, value]) => ({ key, value }));
  }

  it('parses explicit per-chunk partitioning and column-major chunk_order', () => {
    const structure = parseStructure(
      entriesWith({ partitioning: 'per-chunk', chunk_order: 'column-major' }),
    );
    expect(structure.partitioning).toBe('per-chunk');
    expect(structure.chunkOrder).toBe('column-major');
  });

  it('defaults to single partitioning and row-major chunk_order when keys are absent', () => {
    const structure = parseStructure(entriesWith({}));
    expect(structure.partitioning).toBe('single');
    expect(structure.chunkOrder).toBe('row-major');
  });

  it('falls back to defaults for unknown/garbage values', () => {
    const structure = parseStructure(
      entriesWith({ partitioning: 'banana', chunk_order: 'banana' }),
    );
    expect(structure.partitioning).toBe('single');
    expect(structure.chunkOrder).toBe('row-major');
  });
});

// Task 7 fix: scanBinaryBackward must stay a BOUNDED window from the end (the
// footer='none' blob always ends at end-of-data, so its start is at most its
// own length back), never a whole-file walk — the unbounded version was
// measured at ~O(n²) (85s on a 4MB chunk-only file) on a path that runs
// unconditionally for any single-file read whose trailer/header probes miss.
describe('locateMetadata — binary backward scan is a bounded window (perf guard)', () => {
  const MAGIC = new Uint8Array([0xaa, 0x55]);

  /** Deterministic junk that never starts a JSON object, never ends in '}',
   * and (verified by these tests passing) never coincidentally decodes as a
   * full-consuming binary metadata frame. */
  function junk(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let s = 12345;
    for (let i = 0; i < n; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      out[i] = (s >> 16) & 0xff;
    }
    if (n > 0) out[n - 1] = 0x00; // not '}' — keep the JSON footer path out of play
    return out;
  }

  function singleFile(payload: Uint8Array): VirtualFile[] {
    const bytes = new Uint8Array(MAGIC.length * 2 + payload.length);
    bytes.set(MAGIC, 0);
    bytes.set(payload, MAGIC.length);
    bytes.set(MAGIC, MAGIC.length + payload.length);
    return [{ name: 'data', bytes, layout: undefined } as unknown as VirtualFile];
  }

  it('binary metadata LARGER than the window is not recognized (proves the scan is bounded)', () => {
    // ~80KB blob > the 64KiB window: starts further back from the end than the
    // scan reaches. An unbounded scan would find it (metadata-not-found); the
    // bounded scan must honestly report no-metadata.
    const blob = encodeMetadataBinary([{ key: 'x', value: 'a'.repeat(80000) }]);
    expect(blob.length).toBeGreaterThan(65536);
    const payload = new Uint8Array(1000 + blob.length);
    payload.set(junk(1000), 0);
    payload.set(blob, 1000);
    const files = singleFile(payload);
    const result = locateMetadata(files, files, MAGIC);
    expect(result.entries).toBeNull();
    if (result.entries === null) expect(result.reason).toBe('no-metadata');
  });

  it('binary metadata WITHIN the window is spotted as plausible but never returned (D1 lesson)', () => {
    const blob = encodeMetadataBinary([
      { key: 'shape', value: '[16]' },
      { key: 'metadata_format', value: 'binary' },
    ]);
    const payload = new Uint8Array(1000 + blob.length);
    payload.set(junk(1000), 0);
    payload.set(blob, 1000);
    const files = singleFile(payload);
    const result = locateMetadata(files, files, MAGIC);
    expect(result.entries).toBeNull(); // never returns entries — the lesson
    if (result.entries === null) expect(result.reason).toBe('metadata-not-found');
  });

  it('a 4MB chunk-only file completes the scan quickly and reports no-metadata', () => {
    const files = singleFile(junk(4 * 1024 * 1024));
    const t0 = performance.now();
    const result = locateMetadata(files, files, MAGIC);
    const elapsed = performance.now() - t0;
    expect(result.entries).toBeNull();
    if (result.entries === null) expect(result.reason).toBe('no-metadata');
    // Unbounded scan took ~85s here; the bounded window takes single-digit ms.
    // Generous bound to keep CI noise out.
    expect(elapsed).toBeLessThan(250);
  });
});
