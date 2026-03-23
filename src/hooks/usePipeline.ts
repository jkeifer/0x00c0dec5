import { useMemo } from 'react';
import type { AppState } from '../types/state.ts';
import type { PipelineStage, ByteTrace, EncodedChunk, VirtualFile } from '../types/pipeline.ts';
import { buildChunkRegions } from '../components/viewers/viewerUtils.ts';
import type { DtypeKey } from '../types/dtypes.ts';
import { getDtype } from '../types/dtypes.ts';
import { generateValues } from '../engine/generate.ts';
import { chunkData, chunkDataPerVariable, computeChunkGrid, flatIndexToCoords } from '../engine/chunk.ts';
import { linearizeChunk } from '../engine/linearize.ts';
import { runCodecPipeline, shannonEntropy } from '../engine/codecs.ts';
import { collectMetadata, serializeMetadata } from '../engine/metadata.ts';
import { assembleFiles } from '../engine/write.ts';
import { valuesToBytes } from '../engine/elements.ts';
import { formatValue } from '../engine/elements.ts';
import { isChunkLevelTrace } from '../engine/trace.ts';

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
    chunkRegions: buildChunkRegions(traces),
    stats: {
      byteCount: bytes.length,
      entropy: shannonEntropy(bytes),
    },
  };
}

export interface PipelineResult {
  stages: PipelineStage[];
  files: VirtualFile[];
  chunkTraceMap: Map<string, Set<string>>;
  traceChunkMap: Map<string, string>;
}

export function computePipelineStages(state: AppState): PipelineResult {
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
      const coords = flatIndexToCoords(i, state.shape);
      const traceId = `${v.name}:${coords.join(',')}`;
      const display = formatValue(vals[i], v.dtype);
      for (let b = 0; b < dtypeInfo.size; b++) {
        valuesTraces.push({
          traceId,
          variableName: v.name,
          variableColor: v.color,
          coords,
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
  const chunks = state.interleaving === 'column'
    ? chunkDataPerVariable(state.shape, state.chunkShape, state.variables, variableValues)
    : chunkData(state.shape, state.chunkShape, state.variables, variableValues);
  const linearizedChunks = chunks.map((chunk) => linearizeChunk(chunk, state.interleaving));
  const linearizedBytes = concatBytes(linearizedChunks.map((lc) => lc.bytes));
  const linearizedTraces = linearizedChunks.flatMap((lc) => lc.traces);
  stages.push(makeStage('Linearized', linearizedBytes, linearizedTraces));

  // Build chunk↔trace maps from linearized traces
  const chunkTraceMap = new Map<string, Set<string>>();
  const traceChunkMap = new Map<string, string>();
  for (const t of linearizedTraces) {
    if (t.chunkId && !isChunkLevelTrace(t.traceId)) {
      if (!chunkTraceMap.has(t.chunkId)) chunkTraceMap.set(t.chunkId, new Set());
      chunkTraceMap.get(t.chunkId)!.add(t.traceId);
      if (!traceChunkMap.has(t.traceId)) traceChunkMap.set(t.traceId, t.chunkId);
    }
  }

  // 3. Encode
  const encodedChunks: EncodedChunk[] = chunks.map((chunk, idx) => {
    const linearized = linearizedChunks[idx];

    if (state.interleaving === 'column') {
      // Per-variable chunks: each chunk has exactly one variable
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
  const writeBytes = concatBytes(files.map((f) => f.bytes));
  const writeTraces = files.flatMap((f) => f.traces);
  stages.push(makeStage('Write', writeBytes, writeTraces));

  return { stages, files, chunkTraceMap, traceChunkMap };
}

export function usePipeline(state: AppState): PipelineResult {
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
