import { describe, it, expect } from 'vitest';
import { generateValues } from '../../engine/generate.ts';
import { assignType } from '../../engine/typeAssign.ts';
import { chunkData, chunkDataPerVariable, computeChunkGrid } from '../../engine/chunk.ts';
import { linearizeChunk } from '../../engine/linearize.ts';
import { runCodecPipeline } from '../../engine/codecs.ts';
import { assembleFiles } from '../../engine/write.ts';
import { isChunkLevelTrace } from '../../engine/trace.ts';
import { DEFAULT_STATE } from '../../types/state.ts';
import type { AppState } from '../../types/state.ts';
import type { EncodedChunk } from '../../types/pipeline.ts';
import type { DtypeKey } from '../../types/dtypes.ts';

/**
 * Helper: run the full pipeline from state to virtual files.
 */
function runFullPipeline(state: AppState) {
  // 1. Generate logical values
  const totalElements = state.shape.reduce((a, b) => a * b, 1);
  const variableValues = new Map<string, number[]>();
  for (const v of state.variables) {
    variableValues.set(v.name, generateValues(v.name, v.logicalType, totalElements));
  }

  // 2. Type assignment: convert to typed values
  const typedValues = new Map<string, number[]>();
  for (const v of state.variables) {
    const vals = variableValues.get(v.name)!;
    const result = assignType(vals, v.logicalType, v.typeAssignment);
    const dtypeInfo = getDtypeInfo(v.typeAssignment.storageDtype);
    const arr = new dtypeInfo.TypedArray(result.bytes.buffer, result.bytes.byteOffset, vals.length);
    typedValues.set(v.name, Array.from(arr));
  }

  // 3. Build chunkable variables
  const chunkVars = state.variables.map((v) => ({
    name: v.name,
    color: v.color,
    dtype: v.typeAssignment.storageDtype,
  }));

  // 4. Chunk
  const chunks = state.interleaving === 'column'
    ? chunkDataPerVariable(state.shape, state.chunkShape, chunkVars, typedValues)
    : chunkData(state.shape, state.chunkShape, chunkVars, typedValues);

  // 5. Linearize + encode
  const encodedChunks: EncodedChunk[] = chunks.map((chunk) => {
    const linearized = linearizeChunk(chunk, state.interleaving);

    if (state.interleaving === 'column') {
      const cv = chunk.variables[0];
      const steps = state.fieldPipelines[cv.variableName] ?? [];
      const result = runCodecPipeline(linearized.bytes, linearized.traces, steps, cv.dtype as DtypeKey);
      return {
        chunkId: linearized.chunkId,
        coords: linearized.coords,
        bytes: result.bytes,
        traces: result.traces,
        variableName: linearized.variableName,
      };
    } else {
      const steps = state.chunkPipeline;
      const uniqueDtypes = new Set(chunk.variables.map((cv) => cv.dtype));
      const inputDtype: DtypeKey = chunk.variables.length === 0
        ? 'uint8'
        : uniqueDtypes.size > 1
          ? 'uint8'
          : chunk.variables[0].dtype as DtypeKey;
      const result = runCodecPipeline(linearized.bytes, linearized.traces, steps, inputDtype);
      return {
        chunkId: linearized.chunkId,
        coords: linearized.coords,
        bytes: result.bytes,
        traces: result.traces,
      };
    }
  });

  // 6. Assemble files
  const chunkGrid = computeChunkGrid(state.shape, state.chunkShape);
  const files = assembleFiles(state, encodedChunks, chunkGrid);

  return { variableValues, typedValues, chunks, encodedChunks, files };
}

function getDtypeInfo(dtype: string) {
  const map: Record<string, { size: number; TypedArray: any }> = {
    int8: { size: 1, TypedArray: Int8Array },
    uint8: { size: 1, TypedArray: Uint8Array },
    int16: { size: 2, TypedArray: Int16Array },
    uint16: { size: 2, TypedArray: Uint16Array },
    int32: { size: 4, TypedArray: Int32Array },
    uint32: { size: 4, TypedArray: Uint32Array },
    float32: { size: 4, TypedArray: Float32Array },
    float64: { size: 8, TypedArray: Float64Array },
  };
  return map[dtype] ?? { size: 1, TypedArray: Uint8Array };
}

function getTypeSize(dtype: string): number {
  return getDtypeInfo(dtype).size;
}

describe('Integration: minimal passthrough (no codecs)', () => {
  it('produces a valid file with no codec transformations', () => {
    const state: AppState = { ...DEFAULT_STATE };
    const { files, encodedChunks } = runFullPipeline(state);

    expect(files.length).toBeGreaterThanOrEqual(1);
    const mainFile = files[0];
    expect(mainFile.bytes.length).toBeGreaterThan(0);
    expect(mainFile.traces.length).toBe(mainFile.bytes.length);

    // Encoded chunks should preserve original byte count
    const totalElements = state.shape.reduce((a, b) => a * b, 1);
    const expectedBytes = state.variables.reduce(
      (acc, v) => acc + totalElements * getTypeSize(v.typeAssignment.storageDtype),
      0,
    );
    const actualChunkBytes = encodedChunks.reduce((acc, c) => acc + c.bytes.length, 0);
    expect(actualChunkBytes).toBe(expectedBytes);
  });
});

describe('Integration: full codec chain (delta + shuffle + rle)', () => {
  it('applies delta → shuffle → rle', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      variables: [
        {
          id: 'temp', name: 'temp', color: '#f00',
          logicalType: { type: 'integer', min: 0, max: 1000 },
          typeAssignment: { storageDtype: 'int16' },
        },
      ],
      fieldPipelines: {
        temp: [
          { codec: 'delta', params: { order: 1 } },
          { codec: 'byte-shuffle', params: { elementSize: 2 } },
          { codec: 'rle', params: {} },
        ],
      },
      chunkPipeline: [],
    };

    const { files, encodedChunks } = runFullPipeline(state);
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files[0].bytes.length).toBeGreaterThan(0);

    // After RLE (entropy codec), traces should be chunk-level
    for (const chunk of encodedChunks) {
      for (const trace of chunk.traces) {
        expect(isChunkLevelTrace(trace.traceId)).toBe(true);
      }
    }
  });
});

describe('Integration: multi-variable column-oriented', () => {
  it('applies per-variable pipelines independently', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      variables: [
        {
          id: 'a', name: 'a', color: '#f00',
          logicalType: { type: 'decimal', min: -50, max: 50, decimalPlaces: 1 },
          typeAssignment: { storageDtype: 'float32' },
        },
        {
          id: 'b', name: 'b', color: '#0f0',
          logicalType: { type: 'integer', min: 0, max: 1000 },
          typeAssignment: { storageDtype: 'uint16' },
        },
      ],
      fieldPipelines: {
        a: [],
        b: [
          { codec: 'delta', params: { order: 1 } },
        ],
      },
    };

    const { encodedChunks } = runFullPipeline(state);
    // Column mode: 1 chunk per variable * 1 spatial chunk = 2 chunks
    expect(encodedChunks.length).toBe(2);

    // 'a' is float32 (4 bytes * 32) = 128 bytes
    // 'b' is uint16 (2 bytes * 32), delta preserves size = 64 bytes
    // Total across both chunks: 128 + 64 = 192 bytes
    const totalBytes = encodedChunks.reduce((acc, c) => acc + c.bytes.length, 0);
    expect(totalBytes).toBe(192);
  });
});

describe('Integration: multi-variable row-oriented', () => {
  it('applies single chunk pipeline to interleaved data', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      interleaving: 'row',
      variables: [
        {
          id: 'a', name: 'a', color: '#f00',
          logicalType: { type: 'decimal', min: -50, max: 50, decimalPlaces: 1 },
          typeAssignment: { storageDtype: 'float32' },
        },
        {
          id: 'b', name: 'b', color: '#0f0',
          logicalType: { type: 'decimal', min: -50, max: 50, decimalPlaces: 1 },
          typeAssignment: { storageDtype: 'float32' },
        },
      ],
      chunkPipeline: [
        { codec: 'delta', params: { order: 1 } },
      ],
    };

    const { encodedChunks } = runFullPipeline(state);
    expect(encodedChunks.length).toBe(1);
    // 2 variables * 32 elements * 4 bytes = 256 bytes
    expect(encodedChunks[0].bytes.length).toBe(256);
  });
});

describe('Integration: per-chunk partitioning', () => {
  it('creates separate files for each chunk', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      shape: [8],
      chunkShape: [4],
      variables: [
        {
          id: 'x', name: 'x', color: '#f00',
          logicalType: { type: 'integer', min: -1000, max: 1000 },
          typeAssignment: { storageDtype: 'int32' },
        },
      ],
      fieldPipelines: { x: [] },
      write: {
        ...DEFAULT_STATE.write,
        includeMetadata: true,
        partitioning: 'per-chunk',
      },
    };

    const { files } = runFullPipeline(state);
    // 2 chunk files + 1 metadata sidecar
    expect(files.length).toBe(3);
    expect(files[0].name).toContain('chunk');
    expect(files[2].name).toBe('metadata');

    // Each chunk file should have magic + data + magic
    const magicSize = 4; // "00C0DEC5"
    const chunkDataSize = 4 * 4; // 4 int32 values = 16 bytes
    expect(files[0].bytes.length).toBe(magicSize + chunkDataSize + magicSize);
  });
});

describe('Integration: determinism', () => {
  it('produces identical output on repeated runs', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      fieldPipelines: {
        temperature: [
          { codec: 'delta', params: { order: 1 } },
        ],
        pressure: [
          { codec: 'delta', params: { order: 1 } },
        ],
        humidity: [],
      },
    };

    const run1 = runFullPipeline(state);
    const run2 = runFullPipeline(state);

    expect(run1.files.length).toBe(run2.files.length);
    for (let i = 0; i < run1.files.length; i++) {
      expect(Array.from(run1.files[i].bytes)).toEqual(Array.from(run2.files[i].bytes));
      expect(run1.files[i].traces.length).toBe(run2.files[i].traces.length);
    }
  });
});
