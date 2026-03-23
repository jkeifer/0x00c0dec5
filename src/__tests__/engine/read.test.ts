import { describe, it, expect } from 'vitest';
import { readFile } from '../../engine/read.ts';
import { computePipelineStages } from '../../hooks/usePipeline.ts';
import { DEFAULT_STATE, type AppState } from '../../types/state.ts';
import { generateValues } from '../../engine/generate.ts';

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
      write: { ...DEFAULT_STATE.write, includeMetadata: false },
    });
    const { files } = computePipelineStages(state);
    const result = readFile(files, state.write.magicNumber);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorMessage).toContain('Cannot read file');
      expect(result.errorMessage).toContain('no metadata');
    }
  });

  it('failure message includes byte count', () => {
    const state = stateWith({
      write: { ...DEFAULT_STATE.write, includeMetadata: false },
    });
    const { files } = computePipelineStages(state);
    const result = readFile(files, state.write.magicNumber);
    if (!result.success) {
      expect(result.errorMessage).toContain('bytes');
    }
  });
});

describe('readFile — lossless roundtrip (column mode, header metadata)', () => {
  it('reconstructs values within tolerance with no codecs', () => {
    const state = deepMerge(DEFAULT_STATE, {
      write: { includeMetadata: true, metadataPlacement: 'header' },
    }) as AppState;
    const { files } = computePipelineStages(state);
    const result = readFile(files, state.write.magicNumber);

    expect(result.success).toBe(true);
    if (result.success) {
      const totalElements = state.shape.reduce((a, b) => a * b, 1);
      for (const v of state.variables) {
        const expected = generateValues(v.name, v.logicalType, totalElements);
        const actual = result.reconstructedValues.get(v.name);
        expect(actual).toBeDefined();
        expect(actual!.length).toBe(expected.length);
        for (let i = 0; i < expected.length; i++) {
          expect(actual![i]).toBeCloseTo(expected[i], 4);
        }
      }
    }
  });
});

describe('readFile — lossless roundtrip (column mode, footer metadata)', () => {
  it('reconstructs values with footer placement', () => {
    const state = deepMerge(DEFAULT_STATE, {
      write: { includeMetadata: true, metadataPlacement: 'footer' },
    }) as AppState;
    const { files } = computePipelineStages(state);
    const result = readFile(files, state.write.magicNumber);

    expect(result.success).toBe(true);
    if (result.success) {
      const totalElements = state.shape.reduce((a, b) => a * b, 1);
      for (const v of state.variables) {
        const expected = generateValues(v.name, v.logicalType, totalElements);
        const actual = result.reconstructedValues.get(v.name);
        expect(actual).toBeDefined();
        expect(actual!.length).toBe(expected.length);
        for (let i = 0; i < expected.length; i++) {
          expect(actual![i]).toBeCloseTo(expected[i], 4);
        }
      }
    }
  });
});

describe('readFile — lossless roundtrip (column mode, sidecar metadata)', () => {
  it('reconstructs values with sidecar metadata', () => {
    const state = deepMerge(DEFAULT_STATE, {
      write: { includeMetadata: true, metadataPlacement: 'sidecar' },
    }) as AppState;
    const { files } = computePipelineStages(state);
    const result = readFile(files, state.write.magicNumber);

    expect(result.success).toBe(true);
    if (result.success) {
      const totalElements = state.shape.reduce((a, b) => a * b, 1);
      for (const v of state.variables) {
        const expected = generateValues(v.name, v.logicalType, totalElements);
        const actual = result.reconstructedValues.get(v.name);
        expect(actual).toBeDefined();
        expect(actual!.length).toBe(expected.length);
        for (let i = 0; i < expected.length; i++) {
          expect(actual![i]).toBeCloseTo(expected[i], 4);
        }
      }
    }
  });
});

describe('readFile — row mode roundtrip', () => {
  it('reconstructs values in row mode with metadata', () => {
    const state = deepMerge(DEFAULT_STATE, {
      interleaving: 'row',
      write: { includeMetadata: true, metadataPlacement: 'header' },
    }) as AppState;
    const { files } = computePipelineStages(state);
    const result = readFile(files, state.write.magicNumber);

    expect(result.success).toBe(true);
    if (result.success) {
      const totalElements = state.shape.reduce((a, b) => a * b, 1);
      for (const v of state.variables) {
        const expected = generateValues(v.name, v.logicalType, totalElements);
        const actual = result.reconstructedValues.get(v.name);
        expect(actual).toBeDefined();
        expect(actual!.length).toBe(expected.length);
        for (let i = 0; i < expected.length; i++) {
          expect(actual![i]).toBeCloseTo(expected[i], 4);
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
          logicalType: { type: 'decimal', min: -50, max: 50, decimalPlaces: 1 },
          typeAssignment: { storageDtype: 'float32' },
        },
      ],
      fieldPipelines: { temperature: [] },
      write: { ...DEFAULT_STATE.write, includeMetadata: true, metadataPlacement: 'header' },
    };
    const { files, variableStats } = computePipelineStages(state);

    // float32 can't exactly represent decimal values like 23.4
    const tempStats = variableStats.get('temperature')!;
    expect(tempStats.isLossy).toBe(true);
    expect(tempStats.rounded).toBeGreaterThan(0);

    const result = readFile(files, state.write.magicNumber);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.lossyVariables.has('temperature')).toBe(true);
      const totalElements = state.shape.reduce((a, b) => a * b, 1);
      const expected = generateValues('temperature', state.variables[0].logicalType, totalElements);
      const actual = result.reconstructedValues.get('temperature')!;
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
          logicalType: { type: 'decimal', min: -50, max: 50, decimalPlaces: 1 },
          typeAssignment: { storageDtype: 'int16', scale: 10, offset: 0 },
        },
      ],
      fieldPipelines: { temperature: [] },
      write: { ...DEFAULT_STATE.write, includeMetadata: true, metadataPlacement: 'header' },
    };
    const { files, variableStats } = computePipelineStages(state);

    // int16 with scale=10 should be lossless for decimal values with 1 decimal place
    const tempStats = variableStats.get('temperature')!;
    expect(tempStats.isLossy).toBe(false);

    const result = readFile(files, state.write.magicNumber);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.lossyVariables.has('temperature')).toBe(false);
      const totalElements = state.shape.reduce((a, b) => a * b, 1);
      const expected = generateValues('temperature', state.variables[0].logicalType, totalElements);
      const actual = result.reconstructedValues.get('temperature')!;
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
          logicalType: { type: 'decimal', min: -50, max: 50, decimalPlaces: 1 },
          typeAssignment: { storageDtype: 'float32' },
        },
      ],
      fieldPipelines: { temperature: [] },
      write: {
        ...DEFAULT_STATE.write,
        includeMetadata: true,
        partitioning: 'per-chunk',
      },
    };
    const { files } = computePipelineStages(state);
    const result = readFile(files, state.write.magicNumber);

    expect(result.success).toBe(true);
    if (result.success) {
      const totalElements = state.shape.reduce((a, b) => a * b, 1);
      const expected = generateValues('temperature', state.variables[0].logicalType, totalElements);
      const actual = result.reconstructedValues.get('temperature')!;
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
      write: { includeMetadata: true, metadataPlacement: 'footer' },
    }) as AppState;
    const { files } = computePipelineStages(state);
    const result = readFile(files, state.write.magicNumber);

    expect(result.success).toBe(true);
    if (result.success) {
      for (const v of state.variables) {
        const expected = generateValues(v.name, v.logicalType, 16);
        const actual = result.reconstructedValues.get(v.name);
        expect(actual).toBeDefined();
        expect(actual!.length).toBe(expected.length);
        for (let i = 0; i < expected.length; i++) {
          expect(actual![i]).toBeCloseTo(expected[i], 4);
        }
      }
    }
  });
});

describe('readFile — JSON and binary metadata formats', () => {
  it('reads JSON metadata successfully', () => {
    const state = deepMerge(DEFAULT_STATE, {
      metadata: { customEntries: [], serialization: 'json' },
      write: { includeMetadata: true, metadataPlacement: 'header' },
    }) as AppState;
    const { files } = computePipelineStages(state);
    const result = readFile(files, state.write.magicNumber);
    expect(result.success).toBe(true);
  });

  it('reads binary metadata successfully', () => {
    const state = deepMerge(DEFAULT_STATE, {
      metadata: { customEntries: [], serialization: 'binary' },
      write: { includeMetadata: true, metadataPlacement: 'header' },
    }) as AppState;
    const { files } = computePipelineStages(state);
    const result = readFile(files, state.write.magicNumber);
    expect(result.success).toBe(true);
  });
});
