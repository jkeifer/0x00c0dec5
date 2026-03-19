import { describe, it, expect } from 'vitest';
import { generateValues } from '../../engine/generate.ts';
import { chunkData, computeChunkGrid } from '../../engine/chunk.ts';
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
  // 1. Generate values
  const totalElements = state.shape.reduce((a, b) => a * b, 1);
  const variableValues = new Map<string, number[]>();
  for (const v of state.variables) {
    variableValues.set(v.name, generateValues(v.name, v.dtype, totalElements));
  }

  // 2. Chunk
  const chunks = chunkData(state.shape, state.chunkShape, state.variables, variableValues);

  // 3. Linearize + encode
  const encodedChunks: EncodedChunk[] = chunks.map((chunk) => {
    const linearized = linearizeChunk(chunk, state.interleaving);

    if (state.interleaving === 'column') {
      // Per-variable codec pipelines
      let offset = 0;
      const encodedParts: { bytes: Uint8Array; traces: import('../../types/pipeline.ts').ByteTrace[] }[] = [];

      for (const cv of chunk.variables) {
        const varByteCount = cv.values.length * getTypeSize(cv.dtype as DtypeKey);
        const varBytes = linearized.bytes.slice(offset, offset + varByteCount);
        const varTraces = linearized.traces.slice(offset, offset + varByteCount);

        const steps = state.fieldPipelines[cv.variableName] ?? [];
        const result = runCodecPipeline(varBytes, varTraces, steps, cv.dtype as DtypeKey);
        encodedParts.push({ bytes: result.bytes, traces: result.traces });

        offset += varByteCount;
      }

      const totalBytes = encodedParts.reduce((acc, p) => acc + p.bytes.length, 0);
      const combinedBytes = new Uint8Array(totalBytes);
      const combinedTraces: import('../../types/pipeline.ts').ByteTrace[] = [];
      let writeOffset = 0;
      for (const part of encodedParts) {
        combinedBytes.set(part.bytes, writeOffset);
        combinedTraces.push(...part.traces);
        writeOffset += part.bytes.length;
      }

      return {
        chunkId: linearized.chunkId,
        coords: linearized.coords,
        bytes: combinedBytes,
        traces: combinedTraces,
      };
    } else {
      // Single chunk pipeline for row interleaving
      const steps = state.chunkPipeline;
      // Use the first variable's dtype as input dtype (or uint8 if mixed)
      const inputDtype = chunk.variables.length > 0 ? chunk.variables[0].dtype as DtypeKey : 'uint8';
      const result = runCodecPipeline(linearized.bytes, linearized.traces, steps, inputDtype);
      return {
        chunkId: linearized.chunkId,
        coords: linearized.coords,
        bytes: result.bytes,
        traces: result.traces,
      };
    }
  });

  // 4. Assemble files
  const chunkGrid = computeChunkGrid(state.shape, state.chunkShape);
  const files = assembleFiles(state, encodedChunks, chunkGrid);

  return { variableValues, chunks, encodedChunks, files };
}

function getTypeSize(dtype: DtypeKey): number {
  const sizes: Record<string, number> = {
    int8: 1, uint8: 1, int16: 2, uint16: 2,
    int32: 4, uint32: 4, float32: 4, float64: 8,
  };
  return sizes[dtype] ?? 1;
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
      (acc, v) => acc + totalElements * getTypeSize(v.dtype),
      0,
    );
    const actualChunkBytes = encodedChunks.reduce((acc, c) => acc + c.bytes.length, 0);
    expect(actualChunkBytes).toBe(expectedBytes);
  });
});

describe('Integration: full codec chain', () => {
  it('applies scale/offset → delta → shuffle → rle', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      variables: [
        { id: 'temp', name: 'temp', dtype: 'float32', color: '#f00' },
      ],
      fieldPipelines: {
        temp: [
          { codec: 'scale-offset', params: { scale: 100, offset: 0, outputDtype: 'int16' } },
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
        { id: 'a', name: 'a', dtype: 'float32', color: '#f00' },
        { id: 'b', name: 'b', dtype: 'uint16', color: '#0f0' },
      ],
      fieldPipelines: {
        a: [
          { codec: 'scale-offset', params: { scale: 10, offset: 0, outputDtype: 'int16' } },
        ],
        b: [
          { codec: 'delta', params: { order: 1 } },
        ],
      },
    };

    const { encodedChunks } = runFullPipeline(state);
    expect(encodedChunks.length).toBe(1);

    // 'a' was float32 (4 bytes * 32) → int16 (2 bytes * 32) = 64 bytes
    // 'b' was uint16 (2 bytes * 32), delta preserves size = 64 bytes
    // Total: 128 bytes
    expect(encodedChunks[0].bytes.length).toBe(128);
  });
});

describe('Integration: multi-variable row-oriented', () => {
  it('applies single chunk pipeline to interleaved data', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      interleaving: 'row',
      variables: [
        { id: 'a', name: 'a', dtype: 'float32', color: '#f00' },
        { id: 'b', name: 'b', dtype: 'float32', color: '#0f0' },
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
        { id: 'x', name: 'x', dtype: 'int32', color: '#f00' },
      ],
      fieldPipelines: { x: [] },
      write: {
        ...DEFAULT_STATE.write,
        partitioning: 'per-chunk',
      },
    };

    const { files } = runFullPipeline(state);
    // 2 chunk files + 1 metadata sidecar
    expect(files.length).toBe(3);
    expect(files[0].name).toBe('chunk_0');
    expect(files[1].name).toBe('chunk_1');
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
          { codec: 'scale-offset', params: { scale: 100, offset: 0, outputDtype: 'int16' } },
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
