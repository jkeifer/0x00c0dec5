import { useMemo } from 'react';
import type { AppState } from '../types/state.ts';
import type { PipelineStage, ByteTrace, EncodedChunk } from '../types/pipeline.ts';
import type { DtypeKey } from '../types/dtypes.ts';
import { getDtype } from '../types/dtypes.ts';
import { generateValues } from '../engine/generate.ts';
import { chunkData, computeChunkGrid } from '../engine/chunk.ts';
import { linearizeChunk } from '../engine/linearize.ts';
import { runCodecPipeline, shannonEntropy } from '../engine/codecs.ts';
import { collectMetadata, serializeMetadata } from '../engine/metadata.ts';
import { assembleFiles } from '../engine/write.ts';
import { valuesToBytes } from '../engine/elements.ts';
import { formatValue } from '../engine/elements.ts';

function concatBytes(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((acc, a) => acc + a.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

function makeStage(name: string, bytes: Uint8Array, traces: ByteTrace[]): PipelineStage {
  return {
    name,
    bytes,
    traces,
    stats: {
      byteCount: bytes.length,
      entropy: shannonEntropy(bytes),
    },
  };
}

export function computePipelineStages(state: AppState): PipelineStage[] {
  const totalElements = state.shape.reduce((a, b) => a * b, 1);

  // 1. Generate values for all variables
  const variableValues = new Map<string, number[]>();
  for (const v of state.variables) {
    variableValues.set(v.name, generateValues(v.name, v.dtype, totalElements));
  }

  // Build "Values" stage: raw bytes with per-byte traces
  const valuesPartBytes: Uint8Array[] = [];
  const valuesTraces: ByteTrace[] = [];
  for (const v of state.variables) {
    const vals = variableValues.get(v.name)!;
    const dtypeInfo = getDtype(v.dtype);
    const bytes = valuesToBytes(vals, v.dtype);
    valuesPartBytes.push(bytes);

    for (let i = 0; i < vals.length; i++) {
      const traceId = `${v.name}:${i}`;
      const display = formatValue(vals[i], v.dtype);
      for (let b = 0; b < dtypeInfo.size; b++) {
        valuesTraces.push({
          traceId,
          variableName: v.name,
          variableColor: v.color,
          coords: [i],
          displayValue: display,
          dtype: v.dtype,
          chunkId: '',
          byteInValue: b,
          byteCount: dtypeInfo.size,
        });
      }
    }
  }
  const valuesBytes = concatBytes(valuesPartBytes);
  const stages: PipelineStage[] = [makeStage('Values', valuesBytes, valuesTraces)];

  // 2. Chunk + Linearize
  const chunks = chunkData(state.shape, state.chunkShape, state.variables, variableValues);
  const linearizedChunks = chunks.map((chunk) => linearizeChunk(chunk, state.interleaving));
  const linearizedBytes = concatBytes(linearizedChunks.map((lc) => lc.bytes));
  const linearizedTraces = linearizedChunks.flatMap((lc) => lc.traces);
  stages.push(makeStage('Linearized', linearizedBytes, linearizedTraces));

  // 3. Encode
  const encodedChunks: EncodedChunk[] = chunks.map((chunk, idx) => {
    const linearized = linearizedChunks[idx];

    if (state.interleaving === 'column') {
      let offset = 0;
      const encodedParts: { bytes: Uint8Array; traces: ByteTrace[] }[] = [];

      for (const cv of chunk.variables) {
        const varByteCount = cv.values.length * getDtype(cv.dtype as DtypeKey).size;
        const varBytes = linearized.bytes.slice(offset, offset + varByteCount);
        const varTraces = linearized.traces.slice(offset, offset + varByteCount);

        const steps = state.fieldPipelines[cv.variableName] ?? [];
        const result = runCodecPipeline(varBytes, varTraces, steps, cv.dtype as DtypeKey);
        encodedParts.push({ bytes: result.bytes, traces: result.traces });

        offset += varByteCount;
      }

      const combinedBytes = concatBytes(encodedParts.map((p) => p.bytes));
      const combinedTraces = encodedParts.flatMap((p) => p.traces);

      return {
        chunkId: linearized.chunkId,
        coords: linearized.coords,
        bytes: combinedBytes,
        traces: combinedTraces,
      };
    } else {
      const steps = state.chunkPipeline;
      const inputDtype = chunk.variables.length > 0 ? (chunk.variables[0].dtype as DtypeKey) : 'uint8' as DtypeKey;
      const result = runCodecPipeline(linearized.bytes, linearized.traces, steps, inputDtype);
      return {
        chunkId: linearized.chunkId,
        coords: linearized.coords,
        bytes: result.bytes,
        traces: result.traces,
      };
    }
  });

  const encodedBytes = concatBytes(encodedChunks.map((ec) => ec.bytes));
  const encodedTraces = encodedChunks.flatMap((ec) => ec.traces);
  stages.push(makeStage('Encoded', encodedBytes, encodedTraces));

  // 4. Metadata
  const chunkGrid = computeChunkGrid(state.shape, state.chunkShape);
  const metaEntries = collectMetadata(state, encodedChunks);
  const metaBytes = serializeMetadata(metaEntries, state.metadata.serialization);
  const metaTraces: ByteTrace[] = Array.from({ length: metaBytes.length }, (_, i) => ({
    traceId: 'metadata',
    variableName: '',
    variableColor: '',
    coords: [],
    displayValue: 'metadata',
    dtype: 'uint8',
    chunkId: '',
    byteInValue: i,
    byteCount: metaBytes.length,
  }));
  stages.push(makeStage('Metadata', metaBytes, metaTraces));

  // 5. Write (assembled file)
  const files = assembleFiles(state, encodedChunks, chunkGrid);
  const primaryFile = files[0];
  stages.push(makeStage('Write', primaryFile.bytes, primaryFile.traces));

  return stages;
}

export function usePipeline(state: AppState): PipelineStage[] {
  return useMemo(
    () => computePipelineStages(state),
    [
      state.shape,
      state.chunkShape,
      state.interleaving,
      state.variables,
      state.fieldPipelines,
      state.chunkPipeline,
      state.metadata,
      state.write,
    ],
  );
}
