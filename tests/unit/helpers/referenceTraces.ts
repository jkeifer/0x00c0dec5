/**
 * Task 10 (perf plan): reference tracer.
 *
 * Production code no longer materializes `ByteTrace[]` — traces are computed
 * on demand from `StageLayout` via `traceAt`/`byteRangesForTrace`
 * (src/engine/layout.ts). This file is a *faithful, frozen copy* of the
 * pre-Task-10 trace-building code (buildTraces, propagateTracesValuePreserving,
 * degradeTracesToChunkLevel, the Values/Typed/Read stage trace loops, and the
 * Write stage's magic/metadata/chunk trace threading), kept test-only so the
 * layout-equivalence tests have an independently-derived ground truth to pin
 * against forever. It intentionally does NOT import anything that was
 * deleted — only surviving pure engine functions (generateValues, assignType,
 * chunk enumeration, valuesToBytes/bytesToValues, formatValue,
 * collectMetadata/serializeMetadata, CODEC_REGISTRY, orderChunks) plus its own
 * local copies of the trace-shaping logic.
 *
 * Do not "clean this up" to share code with production — the entire point is
 * that this is an independent implementation an equivalence test can check
 * production against. If you need to change trace *semantics*, change
 * layout.ts and then update this file's comments to match (the frozen
 * TraceId format itself must never change either way).
 */
import type { AppState, Variable } from '../../../src/types/state.ts';
import type { ByteTrace, Chunk, EncodedChunk, StageName, VirtualFile } from '../../../src/types/pipeline.ts';
import type { CodecStep } from '../../../src/types/codecs.ts';
import type { DtypeKey } from '../../../src/types/dtypes.ts';
import { getDtype } from '../../../src/types/dtypes.ts';
import { generateValues } from '../../../src/engine/generate.ts';
import { assignType, type TypeAssignResult } from '../../../src/engine/typeAssign.ts';
import { chunkData, chunkDataPerVariable, computeChunkGrid, flatIndexToCoords } from '../../../src/engine/chunk.ts';
import type { LinearizationOrder } from '../../../src/engine/order.ts';
import { valuesToBytes, bytesToValues, formatValue, formatLogicalValue } from '../../../src/engine/elements.ts';
import type { ValueArray } from '../../../src/engine/layout.ts';
import { CODEC_REGISTRY } from '../../../src/engine/codecs.ts';
import { collectMetadata, serializeMetadata, type ChunkIndexEntry } from '../../../src/engine/metadata.ts';
import { orderChunks } from '../../../src/engine/write.ts';
import { hexToBytes, concatBytes } from '../../../src/engine/bytes.ts';
import { makeTraceId, makeChunkTraceId } from '../../../src/engine/trace.ts';
import { readFile } from '../../../src/engine/read.ts';

// ─── trace.ts's propagate/degrade (pre-Task-10 copies) ─────────────────────
//
// Exported for trace.test.ts, which pins these two functions' unit behavior
// directly (independent of the full-pipeline equivalence checks above).

/** Propagate traces through a value-preserving codec (mapping/reordering). */
export function propagateTracesValuePreserving(
  inputTraces: ByteTrace[],
  inputDtype: DtypeKey,
  outputDtype: DtypeKey,
): ByteTrace[] {
  const inputSize = getDtype(inputDtype).size;
  const outputSize = getDtype(outputDtype).size;

  if (inputSize === outputSize) {
    return inputTraces.map((t) => ({ ...t, dtype: outputDtype }));
  }

  const outputTraces: ByteTrace[] = [];
  let i = 0;
  while (i < inputTraces.length) {
    const trace = inputTraces[i];
    const inputValueByteCount = trace.byteCount;
    for (let b = 0; b < outputSize; b++) {
      outputTraces.push({ ...trace, dtype: outputDtype, byteInValue: b, byteCount: outputSize });
    }
    i += inputValueByteCount;
  }
  return outputTraces;
}

/** Degrade traces to chunk-level after entropy coding. */
export function degradeTracesToChunkLevel(inputTraces: ByteTrace[], outputByteCount: number): ByteTrace[] {
  if (inputTraces.length === 0 || outputByteCount === 0) return [];

  const sample = inputTraces[0];
  const chunkTraceId = sample.chunkId;
  const sharedVariable = sample.variableName !== '' &&
    inputTraces.every((t) => t.variableName === sample.variableName);

  return Array.from({ length: outputByteCount }, () => ({
    traceId: chunkTraceId,
    variableName: sharedVariable ? sample.variableName : '',
    variableColor: sharedVariable ? sample.variableColor : '',
    coords: [],
    displayValue: '',
    dtype: 'uint8',
    chunkId: sample.chunkId,
    byteInValue: 0,
    byteCount: 1,
  }));
}

// ─── linearize.ts's buildTraces (pre-Task-10 copy) ─────────────────────────

function buildChunkTraces(chunk: Chunk, interleaving: 'row' | 'column', chunkId: string): ByteTrace[] {
  const traces: ByteTrace[] = [];

  if (interleaving === 'column') {
    for (const cv of chunk.variables) {
      const dtypeInfo = getDtype(cv.dtype as DtypeKey);
      for (let i = 0; i < cv.values.length; i++) {
        const traceId = makeTraceId(cv.variableName, cv.sourceCoords[i]);
        for (let b = 0; b < dtypeInfo.size; b++) {
          traces.push({
            traceId,
            variableName: cv.variableName,
            variableColor: cv.variableColor,
            coords: cv.sourceCoords[i],
            displayValue: formatValue(cv.values[i], cv.dtype as DtypeKey),
            dtype: cv.dtype,
            chunkId,
            byteInValue: b,
            byteCount: dtypeInfo.size,
          });
        }
      }
    }
  } else {
    const elementCount = chunk.variables.length > 0 ? chunk.variables[0].values.length : 0;
    for (let i = 0; i < elementCount; i++) {
      for (const cv of chunk.variables) {
        const dtypeInfo = getDtype(cv.dtype as DtypeKey);
        const traceId = makeTraceId(cv.variableName, cv.sourceCoords[i]);
        for (let b = 0; b < dtypeInfo.size; b++) {
          traces.push({
            traceId,
            variableName: cv.variableName,
            variableColor: cv.variableColor,
            coords: cv.sourceCoords[i],
            displayValue: formatValue(cv.values[i], cv.dtype as DtypeKey),
            dtype: cv.dtype,
            chunkId,
            byteInValue: b,
            byteCount: dtypeInfo.size,
          });
        }
      }
    }
  }

  return traces;
}

function chunkIdFor(chunk: Chunk, interleaving: 'row' | 'column'): string {
  const isSingleVarColumn = interleaving === 'column' && chunk.variables.length === 1;
  return isSingleVarColumn
    ? makeChunkTraceId(`${chunk.variables[0].variableName}:${chunk.coords.join(',')}`)
    : makeChunkTraceId(chunk.coords.join(','));
}

// ─── write.ts's makeMagicTraces/makeMetadataTraces (pre-Task-10 copies) ────

function makeMagicTraces(length: number, isStart: boolean): ByteTrace[] {
  return Array.from({ length }, (_, i) => ({
    traceId: isStart ? 'magic:start' : 'magic:end',
    variableName: '',
    variableColor: '',
    coords: [],
    displayValue: isStart ? 'magic (start)' : 'magic (end)',
    dtype: 'uint8',
    chunkId: '',
    byteInValue: i,
    byteCount: length,
  }));
}

function makeMetadataTraces(length: number): ByteTrace[] {
  return Array.from({ length }, (_, i) => ({
    traceId: 'metadata',
    variableName: '',
    variableColor: '',
    coords: [],
    displayValue: 'metadata',
    dtype: 'uint8',
    chunkId: '',
    byteInValue: i,
    byteCount: length,
  }));
}

// ─── usePipeline.ts's buildLogicalValuesStage trace loop (pre-Task-10 copy) ─

function buildLogicalValuesTraces(
  variables: Pick<Variable, 'name' | 'color'>[],
  shape: number[],
  valuesByName: Map<string, ValueArray>,
): ByteTrace[] {
  const traces: ByteTrace[] = [];
  for (const v of variables) {
    const vals = valuesByName.get(v.name) ?? [];

    if (vals.some((x) => typeof x === 'string')) {
      for (let i = 0; i < vals.length; i++) {
        const str = String(vals[i]);
        const coords = flatIndexToCoords(i, shape);
        const traceId = makeTraceId(v.name, coords);
        for (let b = 0; b < str.length; b++) {
          traces.push({
            traceId,
            variableName: v.name,
            variableColor: v.color,
            coords,
            displayValue: str,
            dtype: 'text',
            chunkId: '',
            byteInValue: b,
            byteCount: str.length,
          });
        }
      }
      continue;
    }

    for (let i = 0; i < vals.length; i++) {
      const coords = flatIndexToCoords(i, shape);
      const traceId = makeTraceId(v.name, coords);
      const display = formatLogicalValue(vals[i]);
      for (let b = 0; b < 8; b++) {
        traces.push({
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
  return traces;
}

// ─── usePipeline.ts's computeTypedStage trace loop (pre-Task-10 copy) ──────

function buildTypedTraces(
  shape: number[],
  variables: Variable[],
  variableValues: Map<string, ValueArray>,
): { traces: ByteTrace[]; typedVariableValues: Map<string, ValueArray> } {
  const traces: ByteTrace[] = [];
  const typedVariableValues = new Map<string, ValueArray>();

  for (const v of variables) {
    const vals = variableValues.get(v.name) ?? [];
    const result = assignType(vals, v.logicalType, v.typeAssignment);
    const storageDtype = v.typeAssignment.storageDtype;
    const dtypeInfo = getDtype(storageDtype);
    const typedVals = bytesToValues(result.bytes, storageDtype);
    typedVariableValues.set(v.name, typedVals);

    for (let i = 0; i < vals.length; i++) {
      const coords = flatIndexToCoords(i, shape);
      const traceId = makeTraceId(v.name, coords);
      const display = formatValue(typedVals[i], storageDtype);
      for (let b = 0; b < dtypeInfo.size; b++) {
        traces.push({
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
  return { traces, typedVariableValues };
}

// ─── codecs.ts's runCodecPipeline (pre-Task-10 copy: threads traces) ───────

function runCodecPipelineWithTraces(
  inputBytes: Uint8Array,
  inputTraces: ByteTrace[],
  steps: CodecStep[],
  inputDtype: DtypeKey,
): { bytes: Uint8Array; traces: ByteTrace[]; outputDtype: DtypeKey } {
  let currentBytes = inputBytes;
  let currentTraces = inputTraces;
  let currentDtype: DtypeKey = inputDtype;

  for (const step of steps) {
    const codec = CODEC_REGISTRY[step.codec];
    if (!codec) continue;

    const result = codec.encode(currentBytes, currentDtype, step.params);
    const outputDtype = result.outputDtype as DtypeKey;

    if (codec.category === 'entropy') {
      currentTraces = degradeTracesToChunkLevel(currentTraces, result.bytes.length);
    } else {
      currentTraces = propagateTracesValuePreserving(currentTraces, currentDtype, outputDtype);
    }

    currentBytes = result.bytes;
    currentDtype = outputDtype;
  }

  return { bytes: currentBytes, traces: currentTraces, outputDtype: currentDtype };
}

// ─── Full-state reference pipeline ──────────────────────────────────────────
//
// Mirrors computePipelineStages(state)'s stage sequence (usePipeline.ts) and
// assembleFiles's file assembly (write.ts) exactly, but threads ByteTrace[]
// through every step the old way instead of building a StageLayout.

interface ReferenceChunkResult {
  chunks: Chunk[];
  linearizedBytes: Uint8Array[];
  linearizedTraces: ByteTrace[][];
  chunkIds: string[];
  variableNames: (string | undefined)[];
}

function referenceLinearize(
  shape: number[],
  chunkShape: number[],
  interleaving: 'row' | 'column',
  variables: Variable[],
  typedVariableValues: Map<string, ValueArray>,
  order: LinearizationOrder = 'c',
): ReferenceChunkResult {
  const chunkVariables = variables.map((v) => ({ ...v, dtype: v.typeAssignment.storageDtype as string }));
  const chunks = interleaving === 'column'
    ? chunkDataPerVariable(shape, chunkShape, chunkVariables, typedVariableValues, order)
    : chunkData(shape, chunkShape, chunkVariables, typedVariableValues, order);

  const linearizedBytes: Uint8Array[] = [];
  const linearizedTraces: ByteTrace[][] = [];
  const chunkIds: string[] = [];
  const variableNames: (string | undefined)[] = [];

  for (const chunk of chunks) {
    const chunkId = chunkIdFor(chunk, interleaving);
    const traces = buildChunkTraces(chunk, interleaving, chunkId);
    const bytes = buildLinearizedBytes(chunk, interleaving);
    linearizedBytes.push(bytes);
    linearizedTraces.push(traces);
    chunkIds.push(chunkId);
    const isSingleVarColumn = interleaving === 'column' && chunk.variables.length === 1;
    variableNames.push(isSingleVarColumn ? chunk.variables[0].variableName : undefined);
  }

  return { chunks, linearizedBytes, linearizedTraces, chunkIds, variableNames };
}

function buildLinearizedBytes(chunk: Chunk, interleaving: 'row' | 'column'): Uint8Array {
  if (interleaving === 'column') {
    return concatBytes(chunk.variables.map((cv) => valuesToBytes(cv.values, cv.dtype as DtypeKey)));
  }
  const elementCount = chunk.variables.length > 0 ? chunk.variables[0].values.length : 0;
  const parts: Uint8Array[] = [];
  for (let i = 0; i < elementCount; i++) {
    for (const cv of chunk.variables) {
      parts.push(valuesToBytes([cv.values[i]], cv.dtype as DtypeKey));
    }
  }
  return concatBytes(parts);
}

function referenceEncode(
  lin: ReferenceChunkResult,
  interleaving: 'row' | 'column',
  variables: Variable[],
  fieldPipelines: Record<string, CodecStep[]>,
  chunkPipeline: CodecStep[],
): { encodedChunks: (EncodedChunk & { traces: ByteTrace[] })[] } {
  const nameToId = new Map(variables.map((v) => [v.name, v.id]));

  const encodedChunks = lin.chunks.map((chunk, idx) => {
    let steps: CodecStep[];
    let inputDtype: DtypeKey;
    if (interleaving === 'column') {
      const cv = chunk.variables[0];
      const variableId = nameToId.get(cv?.variableName ?? '');
      steps = (variableId !== undefined ? fieldPipelines[variableId] : undefined) ?? [];
      inputDtype = cv.dtype as DtypeKey;
    } else {
      steps = chunkPipeline;
      const uniqueDtypes = new Set(chunk.variables.map((cv) => cv.dtype));
      inputDtype = chunk.variables.length === 0
        ? 'uint8'
        : uniqueDtypes.size > 1
          ? 'uint8'
          : chunk.variables[0].dtype as DtypeKey;
    }

    const result = runCodecPipelineWithTraces(lin.linearizedBytes[idx], lin.linearizedTraces[idx], steps, inputDtype);
    return interleaving === 'column'
      ? {
        chunkId: lin.chunkIds[idx],
        coords: chunk.coords,
        bytes: result.bytes,
        traces: result.traces,
        variableName: lin.variableNames[idx],
      }
      : {
        chunkId: lin.chunkIds[idx],
        coords: chunk.coords,
        bytes: result.bytes,
        traces: result.traces,
      };
  });

  return { encodedChunks };
}

/** Mirrors write.ts's assembleFiles ordering/branching exactly, but builds
 *  ByteTrace[] per file instead of a StageLayout. `variableStats` must match
 *  what production threads through (typeAssign.ts's per-variable stats) —
 *  it feeds collectMetadata's schema entries, which affects serialized
 *  metadata byte length and therefore header-placement offset convergence. */
function referenceAssembleFileTraces(
  state: AppState,
  encodedChunks: (EncodedChunk & { traces: ByteTrace[] })[],
  variableStats: Map<string, TypeAssignResult['stats']>,
): { name: string; bytes: Uint8Array; traces: ByteTrace[] }[] {
  const magic = state.write.magicNumber ? hexToBytes(state.write.magicNumber) : new Uint8Array(0);
  const variableOrder = state.interleaving === 'column' ? state.variables.map((v) => v.name) : undefined;
  const chunkGrid = computeChunkGrid(state.shape, state.chunkShape);
  const orderedChunks = orderChunks(encodedChunks, chunkGrid, state.write.chunkOrder, variableOrder) as
    (EncodedChunk & { traces: ByteTrace[] })[];

  if (state.write.partitioning === 'per-chunk') {
    return referenceAssemblePerChunkFiles(state, orderedChunks, magic, variableStats);
  }
  return referenceAssembleSingleFile(state, orderedChunks, magic, variableStats);
}

function referenceBuildSingleFile(
  magic: Uint8Array,
  metaBytes: Uint8Array,
  orderedChunks: (EncodedChunk & { traces: ByteTrace[] })[],
  placement: 'header' | 'footer' | 'none',
  options?: { trailer?: boolean },
): { name: string; bytes: Uint8Array; traces: ByteTrace[] }[] {
  const parts: Uint8Array[] = [];
  const traceParts: ByteTrace[][] = [];

  const pushMagic = (isStart: boolean) => {
    parts.push(magic);
    traceParts.push(makeMagicTraces(magic.length, isStart));
  };
  const pushMetadata = (bytes: Uint8Array) => {
    parts.push(bytes);
    traceParts.push(makeMetadataTraces(bytes.length));
  };

  pushMagic(true);

  if (placement === 'header' && metaBytes.length > 0) {
    pushMetadata(metaBytes);
  }

  for (const chunk of orderedChunks) {
    parts.push(chunk.bytes);
    traceParts.push(chunk.traces);
  }

  if (placement === 'footer' && metaBytes.length > 0) {
    pushMetadata(metaBytes);
    if (options?.trailer) {
      const lenBuf = new ArrayBuffer(4);
      new DataView(lenBuf).setUint32(0, metaBytes.length, true);
      pushMetadata(new Uint8Array(lenBuf));
    }
  }

  pushMagic(false);

  const totalLength = parts.reduce((acc, p) => acc + p.length, 0);
  const bytes = new Uint8Array(totalLength);
  const traces: ByteTrace[] = [];
  let offset = 0;
  for (let i = 0; i < parts.length; i++) {
    bytes.set(parts[i], offset);
    traces.push(...traceParts[i]);
    offset += parts[i].length;
  }

  return [{ name: 'data', bytes, traces }];
}

function referenceComputeChunkOffsets(chunks: EncodedChunk[], startOffset: number): ChunkIndexEntry[] {
  let offset = startOffset;
  return chunks.map((c) => {
    const entry: ChunkIndexEntry = {
      coords: c.coords,
      offset,
      size: c.bytes.length,
      ...(c.variableName ? { variableName: c.variableName } : {}),
    };
    offset += c.bytes.length;
    return entry;
  });
}

const MAX_CONVERGENCE_ITERATIONS = 6;

function referenceConvergeHeaderMetadata(
  state: AppState,
  orderedChunks: EncodedChunk[],
  magic: Uint8Array,
  variableStats: Map<string, TypeAssignResult['stats']>,
): Uint8Array {
  const serializeWithOffsetsFor = (assumedMetaLength: number): Uint8Array => {
    const chunkOffsets = referenceComputeChunkOffsets(orderedChunks, magic.length + assumedMetaLength);
    const meta = collectMetadata(state, orderedChunks, variableStats, chunkOffsets);
    return serializeMetadata(meta, state.metadata.serialization);
  };

  const baseMeta = collectMetadata(state, orderedChunks, variableStats);
  let metaBytes = serializeMetadata(baseMeta, state.metadata.serialization);
  let maxLengthSeen = metaBytes.length;
  let converged = false;

  for (let i = 0; i < MAX_CONVERGENCE_ITERATIONS; i++) {
    const next = serializeWithOffsetsFor(metaBytes.length);
    maxLengthSeen = Math.max(maxLengthSeen, next.length);
    if (next.length === metaBytes.length) {
      metaBytes = next;
      converged = true;
      break;
    }
    metaBytes = next;
  }

  if (!converged) {
    const atMaxLength = serializeWithOffsetsFor(maxLengthSeen);
    if (state.metadata.serialization === 'json' && atMaxLength.length < maxLengthSeen) {
      const padded = new Uint8Array(maxLengthSeen);
      padded.set(atMaxLength, 0);
      padded.fill(0x20, atMaxLength.length);
      metaBytes = padded;
    } else {
      metaBytes = atMaxLength;
    }
  }

  return metaBytes;
}

function referenceAssembleSingleFile(
  state: AppState,
  orderedChunks: (EncodedChunk & { traces: ByteTrace[] })[],
  magic: Uint8Array,
  variableStats: Map<string, TypeAssignResult['stats']>,
): { name: string; bytes: Uint8Array; traces: ByteTrace[] }[] {
  if (state.write.includeMetadata === false) {
    return referenceBuildSingleFile(magic, new Uint8Array(0), orderedChunks, 'none');
  }

  const placement = state.write.metadataPlacement;

  if (placement === 'header') {
    const metaBytes = referenceConvergeHeaderMetadata(state, orderedChunks, magic, variableStats);
    return referenceBuildSingleFile(magic, metaBytes, orderedChunks, 'header');
  }

  if (placement === 'footer') {
    const chunkOffsets = referenceComputeChunkOffsets(orderedChunks, magic.length);
    const meta = collectMetadata(state, orderedChunks, variableStats, chunkOffsets);
    const metaBytes = serializeMetadata(meta, state.metadata.serialization);
    return referenceBuildSingleFile(magic, metaBytes, orderedChunks, 'footer', {
      trailer: state.write.footerLocator === 'trailer',
    });
  }

  // Sidecar
  const chunkOffsets = referenceComputeChunkOffsets(orderedChunks, magic.length);
  const meta = collectMetadata(state, orderedChunks, variableStats, chunkOffsets);
  const metaBytes = serializeMetadata(meta, state.metadata.serialization);

  const dataFile = referenceBuildSingleFile(magic, new Uint8Array(0), orderedChunks, 'none');
  const sidecarFile = { name: 'metadata', bytes: metaBytes, traces: makeMetadataTraces(metaBytes.length) };
  return [...dataFile, sidecarFile];
}

function referenceAssemblePerChunkFiles(
  state: AppState,
  orderedChunks: (EncodedChunk & { traces: ByteTrace[] })[],
  magic: Uint8Array,
  variableStats: Map<string, TypeAssignResult['stats']>,
): { name: string; bytes: Uint8Array; traces: ByteTrace[] }[] {
  const files: { name: string; bytes: Uint8Array; traces: ByteTrace[] }[] = [];

  for (const chunk of orderedChunks) {
    const name = chunk.variableName
      ? `${chunk.variableName}_chunk_${chunk.coords.join('_')}`
      : `chunk_${chunk.coords.join('_')}`;
    const parts: Uint8Array[] = [magic, chunk.bytes, magic];
    const totalLength = parts.reduce((acc, p) => acc + p.length, 0);
    const bytes = new Uint8Array(totalLength);
    const traces: ByteTrace[] = [];

    let offset = 0;
    bytes.set(magic, offset);
    traces.push(...makeMagicTraces(magic.length, true));
    offset += magic.length;

    bytes.set(chunk.bytes, offset);
    traces.push(...chunk.traces);
    offset += chunk.bytes.length;

    bytes.set(magic, offset);
    traces.push(...makeMagicTraces(magic.length, false));

    files.push({ name, bytes, traces });
  }

  if (state.write.includeMetadata !== false) {
    const chunkOffsets: ChunkIndexEntry[] = orderedChunks.map((c) => ({
      coords: c.coords,
      offset: magic.length,
      size: c.bytes.length,
      ...(c.variableName ? { variableName: c.variableName } : {}),
    }));
    const meta = collectMetadata(state, orderedChunks, variableStats, chunkOffsets);
    const metaBytes = serializeMetadata(meta, state.metadata.serialization);
    files.push({ name: 'metadata', bytes: metaBytes, traces: makeMetadataTraces(metaBytes.length) });
  }

  return files;
}

// ─── Public API ──────────────────────────────────────────────────────────

/** Recompute every stage's ByteTrace[] the pre-Task-10 way, from `state`
 *  alone. Keyed by StageName (lowercase, matches types/pipeline.ts's
 *  STAGE_ORDER) so callers can look up the stage they're checking without
 *  caring about array index. */
export function referenceStageTraces(state: AppState): Map<StageName, ByteTrace[]> {
  const totalElements = state.shape.reduce((a, b) => a * b, 1);
  const variableValues = new Map<string, ValueArray>();
  for (const v of state.variables) {
    variableValues.set(v.name, generateValues(v.name, v.logicalType, totalElements));
  }
  const valuesTraces = buildLogicalValuesTraces(state.variables, state.shape, variableValues);

  const { traces: typedTraces, typedVariableValues } = buildTypedTraces(state.shape, state.variables, variableValues);

  const lin = referenceLinearize(state.shape, state.chunkShape, state.interleaving, state.variables, typedVariableValues, state.linearization);
  const linearizedTraces = lin.linearizedTraces.flat();

  const { encodedChunks } = referenceEncode(lin, state.interleaving, state.variables, state.fieldPipelines, state.chunkPipeline);
  const encodedTraces = encodedChunks.flatMap((ec) => ec.traces);

  const variableStats = referenceVariableStats(state.variables, variableValues);
  const metaEntries = collectMetadata(state, encodedChunks, variableStats);
  const metaBytes = serializeMetadata(metaEntries, state.metadata.serialization);
  const metadataTraces = makeMetadataTraces(metaBytes.length);

  const refFiles = referenceAssembleFileTraces(state, encodedChunks, variableStats);
  const writeTraces = refFiles.flatMap((f) => f.traces);

  const readTraces = referenceReadTraces(state, refFiles, variableValues);

  return new Map<StageName, ByteTrace[]>([
    ['values', valuesTraces],
    ['typed', typedTraces],
    ['linearized', linearizedTraces],
    ['encoded', encodedTraces],
    ['metadata', metadataTraces],
    ['write', writeTraces],
    ['read', readTraces],
  ]);
}

/** Per-file reference traces (mirrors VirtualFile[] order from assembleFiles),
 *  for tests that check individual file trace arrays rather than the
 *  concatenated Write stage. */
export function referenceFileTraces(state: AppState): { name: string; traces: ByteTrace[] }[] {
  const totalElements = state.shape.reduce((a, b) => a * b, 1);
  const variableValues = new Map<string, ValueArray>();
  for (const v of state.variables) {
    variableValues.set(v.name, generateValues(v.name, v.logicalType, totalElements));
  }
  const { typedVariableValues } = buildTypedTraces(state.shape, state.variables, variableValues);
  const lin = referenceLinearize(state.shape, state.chunkShape, state.interleaving, state.variables, typedVariableValues, state.linearization);
  const { encodedChunks } = referenceEncode(lin, state.interleaving, state.variables, state.fieldPipelines, state.chunkPipeline);
  const variableStats = referenceVariableStats(state.variables, variableValues);
  const refFiles = referenceAssembleFileTraces(state, encodedChunks, variableStats);
  return refFiles.map((f) => ({ name: f.name, traces: f.traces }));
}

// Minimal VariableStats reconstruction, matching typeAssign.ts's assignType
// stats output — needed because collectMetadata's `truncated`/`isLossy`
// fields feed into the schema JSON (byte count-affecting for header
// convergence), so metadata trace length must match production exactly.
function referenceVariableStats(variables: Variable[], variableValues: Map<string, ValueArray>) {
  const stats = new Map<string, ReturnType<typeof assignType>['stats']>();
  for (const v of variables) {
    const vals = variableValues.get(v.name) ?? [];
    const result = assignType(vals, v.logicalType, v.typeAssignment);
    stats.set(v.name, result.stats);
  }
  return stats;
}

function referenceReadTraces(
  state: AppState,
  refFiles: { name: string; bytes: Uint8Array; traces: ByteTrace[] }[],
  logicalValues: Map<string, ValueArray>,
): ByteTrace[] {
  // readFile only needs VirtualFile-shaped { name, bytes } — traces/layout
  // are irrelevant to it (confirmed: readFile has no trace dependency).
  const asVirtualFiles = refFiles.map((f) => ({
    name: f.name,
    bytes: f.bytes,
    traces: [],
    layout: { byteLength: f.bytes.length, shape: [], regions: [] },
  })) as unknown as VirtualFile[];

  const readResult = readFile(asVirtualFiles, { magic: hexToBytes(state.write.magicNumber) });
  if (!readResult.success) return [];

  const reconstructed = new Map<string, ValueArray>();
  for (const v of state.variables) {
    reconstructed.set(v.name, readResult.reconstructedValues.get(v.name) ?? logicalValues.get(v.name) ?? []);
  }
  return buildLogicalValuesTraces(state.variables, state.shape, reconstructed);
}
