import { useMemo } from 'react';
import type { AppState } from '../types/state.ts';
import type { PipelineStage, ByteTrace, EncodedChunk, VirtualFile, ReadFileResult, VariableStats } from '../types/pipeline.ts';
import { buildChunkRegions } from '../components/viewers/viewerUtils.ts';
import type { DtypeKey } from '../types/dtypes.ts';
import { getDtype } from '../types/dtypes.ts';
import { generateValues } from '../engine/generate.ts';
import { assignType } from '../engine/typeAssign.ts';
import { chunkData, chunkDataPerVariable, computeChunkGrid, flatIndexToCoords } from '../engine/chunk.ts';
import { linearizeChunk } from '../engine/linearize.ts';
import { runCodecPipeline, shannonEntropy } from '../engine/codecs.ts';
import { collectMetadata, serializeMetadata } from '../engine/metadata.ts';
import { assembleFiles } from '../engine/write.ts';
import { valuesToBytes } from '../engine/elements.ts';
import { formatValue, formatLogicalValue } from '../engine/elements.ts';
import { isChunkLevelTrace } from '../engine/trace.ts';
import { readFile } from '../engine/read.ts';

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
  readResult: ReadFileResult;
  variableStats: Map<string, VariableStats>;
}

export function computePipelineStages(state: AppState): PipelineResult {
  const totalElements = state.shape.reduce((a, b) => a * b, 1);

  // 1. Generate logical values for all variables
  const variableValues = new Map<string, number[]>();
  for (const v of state.variables) {
    variableValues.set(v.name, generateValues(v.name, v.logicalType, totalElements));
  }

  // Build "Values" stage: logical values stored as float64 bytes with per-byte traces
  const valuesPartBytes: Uint8Array[] = [];
  const valuesTraces: ByteTrace[] = [];
  for (const v of state.variables) {
    const vals = variableValues.get(v.name)!;
    const bytes = valuesToBytes(vals, 'float64');
    valuesPartBytes.push(bytes);

    for (let i = 0; i < vals.length; i++) {
      const coords = flatIndexToCoords(i, state.shape);
      const traceId = `${v.name}:${coords.join(',')}`;
      const display = formatLogicalValue(vals[i]);
      for (let b = 0; b < 8; b++) { // float64 = 8 bytes
        valuesTraces.push({
          traceId,
          variableName: v.name,
          variableColor: v.color,
          coords,
          displayValue: display,
          dtype: 'float64',
          chunkId: '',
          byteInValue: b,
          byteCount: 8,
        });
      }
    }
  }
  const valuesBytes = concatBytes(valuesPartBytes);
  const stages: PipelineStage[] = [makeStage('Values', valuesBytes, valuesTraces)];

  // 2. Type assignment: convert logical values to typed bytes
  const typedPartBytes: Uint8Array[] = [];
  const typedTraces: ByteTrace[] = [];
  const variableStats = new Map<string, VariableStats>();
  const typedVariableValues = new Map<string, number[]>(); // typed values for chunking

  for (const v of state.variables) {
    const vals = variableValues.get(v.name)!;
    const result = assignType(vals, v.logicalType, v.typeAssignment);
    const storageDtype = v.typeAssignment.storageDtype;
    const dtypeInfo = getDtype(storageDtype);

    typedPartBytes.push(result.bytes);
    variableStats.set(v.name, result.stats);

    // Read back the typed values for use in chunking
    const typedVals = Array.from(
      new (dtypeInfo.TypedArray)(result.bytes.buffer, result.bytes.byteOffset, vals.length)
    );
    typedVariableValues.set(v.name, typedVals);

    for (let i = 0; i < vals.length; i++) {
      const coords = flatIndexToCoords(i, state.shape);
      const traceId = `${v.name}:${coords.join(',')}`;
      const display = formatValue(typedVals[i], storageDtype);
      for (let b = 0; b < dtypeInfo.size; b++) {
        typedTraces.push({
          traceId,
          variableName: v.name,
          variableColor: v.color,
          coords,
          displayValue: display,
          dtype: storageDtype,
          chunkId: '',
          byteInValue: b,
          byteCount: dtypeInfo.size,
        });
      }
    }
  }
  const typedBytes = concatBytes(typedPartBytes);
  stages.push(makeStage('Typed', typedBytes, typedTraces));

  // 3. Chunk + Linearize (using storageDtype from typeAssignment)
  // Build variables with storage dtypes for chunking
  const chunkVariables = state.variables.map((v) => ({
    ...v,
    dtype: v.typeAssignment.storageDtype as string,
  }));
  const chunks = state.interleaving === 'column'
    ? chunkDataPerVariable(state.shape, state.chunkShape, chunkVariables, typedVariableValues)
    : chunkData(state.shape, state.chunkShape, chunkVariables, typedVariableValues);
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

  // 4. Encode (only byte-level codecs: delta, byte-shuffle, RLE, LZ)
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

  // 5. Metadata
  const chunkGrid = computeChunkGrid(state.shape, state.chunkShape);
  const metaEntries = collectMetadata(state, encodedChunks, variableStats);
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

  // 6. Write (assembled file)
  const files = assembleFiles(state, encodedChunks, chunkGrid, variableStats);
  const writeBytes = concatBytes(files.map((f) => f.bytes));
  const writeTraces = files.flatMap((f) => f.traces);
  stages.push(makeStage('Write', writeBytes, writeTraces));

  // 7. Read (reconstruct from file bytes)
  const readResult = readFile(files, state.write.magicNumber);

  if (readResult.success) {
    // Build a Values-like stage with reconstructed values
    const readPartBytes: Uint8Array[] = [];
    const readTraces: ByteTrace[] = [];
    for (const v of state.variables) {
      const vals = readResult.reconstructedValues.get(v.name) ?? [];
      // Read stage shows logical values (float64), same as Values stage
      const bytes = valuesToBytes(vals, 'float64');
      readPartBytes.push(bytes);

      for (let i = 0; i < vals.length; i++) {
        const coords = flatIndexToCoords(i, state.shape);
        const traceId = `${v.name}:${coords.join(',')}`;
        const display = formatLogicalValue(vals[i]);
        for (let b = 0; b < 8; b++) {
          readTraces.push({
            traceId,
            variableName: v.name,
            variableColor: v.color,
            coords,
            displayValue: display,
            dtype: 'float64',
            chunkId: '',
            byteInValue: b,
            byteCount: 8,
          });
        }
      }
    }
    const readBytes = concatBytes(readPartBytes);
    stages.push(makeStage('Read', readBytes, readTraces));
  } else {
    // Failed read — push empty stage
    stages.push(makeStage('Read', new Uint8Array(0), []));
  }

  return { stages, files, chunkTraceMap, traceChunkMap, readResult, variableStats };
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
