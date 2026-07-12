import { describe, it, expect } from 'vitest';
import { DEFAULT_STATE } from '../../../src/types/state.ts';
import type { AppState } from '../../../src/types/state.ts';
import { computePipelineStages } from '../../../src/engine/pipelineCompute.ts';
import { valuesToBytes, bytesToValues } from '../../../src/engine/elements.ts';

// Two multi-byte integer variables so byte order is observable end-to-end.
const VARS = [
  {
    id: 'a', name: 'a', color: '#e06c75',
    logicalType: { type: 'integer' as const, min: 0, max: 30000, generation: 'smooth' as const },
    typeAssignment: { storageDtype: 'int32' as const },
  },
  {
    id: 'b', name: 'b', color: '#61afef',
    logicalType: { type: 'integer' as const, min: -1000, max: 1000, generation: 'sorted' as const },
    typeAssignment: { storageDtype: 'int16' as const },
  },
];

function baseState(overrides: Partial<AppState>): AppState {
  return {
    ...DEFAULT_STATE,
    dataModel: 'tabular',
    shape: [32],
    chunkShape: [32],
    variables: VARS,
    fieldPipelines: { a: [], b: [] },
    chunkPipeline: [],
    metadata: {
      ...DEFAULT_STATE.metadata,
      include: { ...DEFAULT_STATE.metadata.include },
    },
    write: { ...DEFAULT_STATE.write, includeMetadata: true },
    ...overrides,
  };
}

describe('valuesToBytes / bytesToValues byte order', () => {
  it('big-endian int16 writes MSB first', () => {
    expect(Array.from(valuesToBytes([0x1234], 'int16', 'big'))).toEqual([0x12, 0x34]);
  });

  it('little-endian int16 writes LSB first', () => {
    expect(Array.from(valuesToBytes([0x1234], 'int16', 'little'))).toEqual([0x34, 0x12]);
  });

  it('default byteOrder is little (byte-identical to pre-task behavior)', () => {
    expect(Array.from(valuesToBytes([0x1234], 'int16'))).toEqual([0x34, 0x12]);
  });

  it('big-endian roundtrips through bytesToValues', () => {
    const bytes = valuesToBytes([0x1234, -1], 'int16', 'big');
    expect(Array.from(bytesToValues(bytes, 'int16', 'big'))).toEqual([0x1234, -1]);
  });

  it('char dtypes ignore byteOrder (byte-per-char)', () => {
    expect(Array.from(valuesToBytes(['ab'], 'char4', 'big')))
      .toEqual(Array.from(valuesToBytes(['ab'], 'char4', 'little')));
  });
});

describe('endianness full-pipeline roundtrip', () => {
  it('big-endian with endianness recorded roundtrips exactly', () => {
    const state = baseState({ byteOrder: 'big' });
    const result = computePipelineStages(state);
    expect(result.readResult.success).toBe(true);
    for (const v of VARS) {
      const logical = result.logicalValues.get(v.name)!;
      const recon = result.readResult.success
        ? result.readResult.reconstructedValues.get(v.name)!
        : [];
      expect(Array.from(recon)).toEqual(Array.from(logical));
    }
  });

  it('big-endian bytes differ from little-endian at the Typed stage', () => {
    const be = computePipelineStages(baseState({ byteOrder: 'big' }))
      .stages.find((s) => s.name === 'Typed')!.bytes;
    const le = computePipelineStages(baseState({ byteOrder: 'little' }))
      .stages.find((s) => s.name === 'Typed')!.bytes;
    expect(Array.from(be)).not.toEqual(Array.from(le));
  });

  it('little-endian with endianness excluded still roundtrips (host matches authoring)', () => {
    const state = baseState({
      byteOrder: 'little',
      metadata: {
        ...DEFAULT_STATE.metadata,
        include: { ...DEFAULT_STATE.metadata.include, endianness: false },
      },
    });
    const result = computePipelineStages(state);
    expect(result.readResult.success).toBe(true);
    for (const v of VARS) {
      const logical = result.logicalValues.get(v.name)!;
      const recon = result.readResult.success
        ? result.readResult.reconstructedValues.get(v.name)!
        : [];
      expect(Array.from(recon)).toEqual(Array.from(logical));
    }
  });
});

describe('endianness silent-corruption lesson', () => {
  it('big-endian file + endianness excluded → silent success with garbled values', () => {
    const state = baseState({
      byteOrder: 'big',
      metadata: {
        ...DEFAULT_STATE.metadata,
        include: { ...DEFAULT_STATE.metadata.include, endianness: false },
      },
    });
    const result = computePipelineStages(state);

    // The read MUST succeed — silent corruption is the point (spec risk 5).
    expect(result.readResult.success).toBe(true);
    if (!result.readResult.success) return;
    // No failed step.
    expect(result.readResult.steps.every((s) => s.outcome !== 'failed')).toBe(true);

    // Reconstructed values are garbled for a multi-byte numeric variable:
    // written big-endian, read little-endian (host assumption).
    const logical = result.logicalValues.get('a')!;
    const recon = result.readResult.reconstructedValues.get('a')!;
    const differ = Array.from(logical).some((v, i) => v !== recon[i]);
    expect(differ).toBe(true);

    // The decode step narrates the assumption.
    const decodeStep = result.readResult.steps.find((s) => s.id === 'decode-chunks')!;
    expect(decodeStep.detail).toContain('assuming host');
  });
});
