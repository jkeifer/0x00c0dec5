import { useMemo } from 'react';
import type { AppState, Variable } from '../types/state.ts';
import type { CodecStep } from '../types/codecs.ts';
import type {
  PipelineStage,
  ByteTrace,
  Chunk,
  LinearizedChunk,
  EncodedChunk,
  VirtualFile,
  ReadFileResult,
  VariableStats,
  StageName,
} from '../types/pipeline.ts';
import type { DtypeKey, LogicalValue } from '../types/dtypes.ts';
import { getDtype } from '../types/dtypes.ts';
import { generateValues } from '../engine/generate.ts';
import { assignType } from '../engine/typeAssign.ts';
import { chunkData, chunkDataPerVariable, computeChunkGrid, flatIndexToCoords } from '../engine/chunk.ts';
import { linearizeChunk } from '../engine/linearize.ts';
import { runCodecPipeline, shannonEntropy } from '../engine/codecs.ts';
import { collectMetadata, serializeMetadata } from '../engine/metadata.ts';
import { assembleFiles } from '../engine/write.ts';
import { valuesToBytes, bytesToValues } from '../engine/elements.ts';
import { formatValue, formatLogicalValue } from '../engine/elements.ts';
import { isChunkLevelTrace, makeTraceId } from '../engine/trace.ts';
import { readFile } from '../engine/read.ts';
import { hexToBytes, concatBytes } from '../engine/bytes.ts';
import {
  buildValueBlocksLayout,
  buildLinearizedLayout,
  buildEncodedLayout,
  buildMetadataLayout,
  encodedChunkMeta,
  chunkRegionsOf,
  type StageLayout,
  type ValueArray,
  type ValueSources,
  type LayoutRegion,
} from '../engine/layout.ts';

function makeStage(name: string, bytes: Uint8Array, traces: ByteTrace[], layout: StageLayout): PipelineStage {
  return {
    name,
    bytes,
    traces,
    chunkRegions: chunkRegionsOf(layout),
    layout,
    stats: {
      byteCount: bytes.length,
      entropy: shannonEntropy(bytes),
    },
  };
}

/**
 * Build a Values-stage-shaped byte blob + per-byte traces for a set of logical
 * (float64) values per variable. Shared by the Values stage and the Read
 * stage, which both display reconstructed logical values in the same layout.
 */
function buildLogicalValuesStage(
  variables: Pick<Variable, 'name' | 'color'>[],
  shape: number[],
  valuesByName: Map<string, LogicalValue[]>,
): { bytes: Uint8Array; traces: ByteTrace[] } {
  const partBytes: Uint8Array[] = [];
  const traces: ByteTrace[] = [];
  for (const v of variables) {
    const vals = valuesByName.get(v.name) ?? [];

    if (vals.some((x) => typeof x === 'string')) {
      // Text variables: at the Values stage each FULL, untruncated string is
      // encoded as raw ASCII with byteCount = str.length — variable stride
      // here vs. the fixed charN stride at Typed IS the lesson. Both
      // HexView/FlatView are trace-driven, so variable stride is safe.
      for (let i = 0; i < vals.length; i++) {
        const str = String(vals[i]);
        const strBytes = new Uint8Array(str.length);
        for (let c = 0; c < str.length; c++) {
          const code = str.charCodeAt(c);
          strBytes[c] = code <= 0x7f ? code : 0x3f; // '?'
        }
        partBytes.push(strBytes);

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

    const bytes = valuesToBytes(vals, 'float64');
    partBytes.push(bytes);

    for (let i = 0; i < vals.length; i++) {
      const coords = flatIndexToCoords(i, shape);
      const traceId = makeTraceId(v.name, coords);
      const display = formatLogicalValue(vals[i]);
      for (let b = 0; b < 8; b++) { // float64 = 8 bytes
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
  return { bytes: concatBytes(partBytes), traces };
}

// ─── Stage 1: Values ───────────────────────────────────────────────────────
//
// Depends only on: shape, and each variable's name/color/logicalType. Does
// NOT depend on typeAssignment, chunkShape, interleaving, codecs, metadata,
// or write config.

export interface ValuesStageResult {
  stage: PipelineStage;
  variableValues: Map<string, LogicalValue[]>;
}

export function computeValuesStage(
  shape: number[],
  variables: Variable[],
): ValuesStageResult {
  const totalElements = shape.reduce((a, b) => a * b, 1);

  const variableValues = new Map<string, LogicalValue[]>();
  for (const v of variables) {
    variableValues.set(v.name, generateValues(v.name, v.logicalType, totalElements));
  }

  const { bytes, traces } = buildLogicalValuesStage(variables, shape, variableValues);
  const layout = buildValueBlocksLayout(
    variables, shape, variableValues,
    (name) => (variableValues.get(name) ?? []).some((v) => typeof v === 'string') ? 'text' : 'float64',
  );
  return { stage: makeStage('Values', bytes, traces, layout), variableValues };
}

// ─── Stage 2: Typed ──────────────────────────────────────────────────────────
//
// Depends on: the Values stage's variableValues, shape, and each variable's
// name/color/logicalType/typeAssignment. Does NOT depend on chunkShape,
// interleaving, codecs, metadata, or write config.

export interface TypedStageResult {
  stage: PipelineStage;
  typedVariableValues: Map<string, LogicalValue[]>;
  variableStats: Map<string, VariableStats>;
}

export function computeTypedStage(
  shape: number[],
  variables: Variable[],
  variableValues: Map<string, LogicalValue[]>,
): TypedStageResult {
  const typedPartBytes: Uint8Array[] = [];
  const typedTraces: ByteTrace[] = [];
  const variableStats = new Map<string, VariableStats>();
  const typedVariableValues = new Map<string, LogicalValue[]>();

  for (const v of variables) {
    const vals = variableValues.get(v.name) ?? [];
    const result = assignType(vals, v.logicalType, v.typeAssignment);
    const storageDtype = v.typeAssignment.storageDtype;
    const dtypeInfo = getDtype(storageDtype);

    typedPartBytes.push(result.bytes);
    variableStats.set(v.name, result.stats);

    // Read back the typed values for use in chunking — bytesToValues has the
    // same LE semantics as the TypedArray view it replaced, and handles char
    // dtypes (strings) through the same single code path.
    const typedVals = bytesToValues(result.bytes, storageDtype);
    typedVariableValues.set(v.name, typedVals);

    for (let i = 0; i < vals.length; i++) {
      const coords = flatIndexToCoords(i, shape);
      const traceId = makeTraceId(v.name, coords);
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
  const typedLayout = buildValueBlocksLayout(
    variables, shape, typedVariableValues,
    (name) => variables.find((v) => v.name === name)!.typeAssignment.storageDtype,
  );
  return {
    stage: makeStage('Typed', typedBytes, typedTraces, typedLayout),
    typedVariableValues,
    variableStats,
  };
}

// ─── Stage 3: Linearized (chunk + linearize) ───────────────────────────────
//
// Depends on: the Typed stage's typedVariableValues, shape, chunkShape,
// interleaving, and each variable's name/color/typeAssignment.storageDtype.
// Does NOT depend on logicalType, codecs, metadata, or write config.

export interface LinearizedStageResult {
  stage: PipelineStage;
  chunks: Chunk[];
  linearizedChunks: LinearizedChunk[];
  chunkTraceMap: Map<string, Set<string>>;
  traceChunkMap: Map<string, string>;
}

export function computeLinearizedStage(
  shape: number[],
  chunkShape: number[],
  interleaving: 'row' | 'column',
  variables: Variable[],
  typedVariableValues: Map<string, LogicalValue[]>,
): LinearizedStageResult {
  const chunkVariables = variables.map((v) => ({
    ...v,
    dtype: v.typeAssignment.storageDtype as string,
  }));
  const chunks = interleaving === 'column'
    ? chunkDataPerVariable(shape, chunkShape, chunkVariables, typedVariableValues)
    : chunkData(shape, chunkShape, chunkVariables, typedVariableValues);
  const linearizedChunks = chunks.map((chunk) => linearizeChunk(chunk, interleaving));
  const linearizedBytes = concatBytes(linearizedChunks.map((lc) => lc.bytes));
  const linearizedTraces = linearizedChunks.flatMap((lc) => lc.traces);

  // Build chunk<->trace maps from linearized traces
  const chunkTraceMap = new Map<string, Set<string>>();
  const traceChunkMap = new Map<string, string>();
  for (const t of linearizedTraces) {
    if (t.chunkId && !isChunkLevelTrace(t.traceId)) {
      if (!chunkTraceMap.has(t.chunkId)) chunkTraceMap.set(t.chunkId, new Set());
      chunkTraceMap.get(t.chunkId)!.add(t.traceId);
      if (!traceChunkMap.has(t.traceId)) traceChunkMap.set(t.traceId, t.chunkId);
    }
  }

  const linearizedLayout = buildLinearizedLayout(chunks, linearizedChunks, interleaving, shape, chunkShape);

  return {
    stage: makeStage('Linearized', linearizedBytes, linearizedTraces, linearizedLayout),
    chunks,
    linearizedChunks,
    chunkTraceMap,
    traceChunkMap,
  };
}

// ─── Stage 4: Encoded (codec pipelines) ────────────────────────────────────
//
// Depends on: the Linearized stage's chunks/linearizedChunks, interleaving,
// fieldPipelines, chunkPipeline, and each variable's id/name (for the
// name -> id lookup — fieldPipelines is id-keyed per D5). Does NOT depend on
// shape/chunkShape/logicalType/metadata/write config directly (only via the
// already-computed chunks).

export interface EncodedStageResult {
  stage: PipelineStage;
  encodedChunks: EncodedChunk[];
}

/** Per-chunk codec steps + input dtype — single source of truth for "which
 * pipeline applies to this chunk", used by computeEncodedStage to both run
 * the codecs and derive encodedChunkMeta for the chunk's layout region.
 * Mirrors the equivalence tests' inline derivation. */
function chunkCodecInput(
  chunk: Chunk,
  interleaving: 'row' | 'column',
  nameToId: Map<string, string>,
  fieldPipelines: Record<string, CodecStep[]>,
  chunkPipeline: CodecStep[],
): { steps: CodecStep[]; inputDtype: DtypeKey } {
  if (interleaving === 'column') {
    const cv = chunk.variables[0];
    const variableId = nameToId.get(cv?.variableName ?? '');
    const steps = (variableId !== undefined ? fieldPipelines[variableId] : undefined) ?? [];
    return { steps, inputDtype: cv.dtype as DtypeKey };
  }
  const uniqueDtypes = new Set(chunk.variables.map((cv) => cv.dtype));
  const inputDtype: DtypeKey = chunk.variables.length === 0
    ? 'uint8'
    : uniqueDtypes.size > 1
      ? 'uint8'
      : chunk.variables[0].dtype as DtypeKey;
  return { steps: chunkPipeline, inputDtype };
}

export function computeEncodedStage(
  chunks: Chunk[],
  linearizedChunks: LinearizedChunk[],
  interleaving: 'row' | 'column',
  variables: Variable[],
  fieldPipelines: Record<string, CodecStep[]>,
  chunkPipeline: CodecStep[],
  linearizedLayout: StageLayout,
): EncodedStageResult {
  // fieldPipelines is keyed by Variable.id (D5); ChunkVariable only carries the
  // variable's name (the file format's key), so resolve name -> id here.
  const nameToId = new Map(variables.map((v) => [v.name, v.id]));
  const outputDtypes: string[] = [];
  const hasEntropy: boolean[] = [];
  const encodedChunks: EncodedChunk[] = chunks.map((chunk, idx) => {
    const linearized = linearizedChunks[idx];
    const { steps, inputDtype } = chunkCodecInput(chunk, interleaving, nameToId, fieldPipelines, chunkPipeline);
    const meta = encodedChunkMeta(steps, inputDtype);
    outputDtypes.push(meta.outputDtype);
    hasEntropy.push(meta.hasEntropy);
    const result = runCodecPipeline(linearized.bytes, linearized.traces, steps, inputDtype);
    return interleaving === 'column'
      ? {
        chunkId: linearized.chunkId,
        coords: linearized.coords,
        bytes: result.bytes,
        traces: result.traces,
        variableName: linearized.variableName,
      }
      : {
        chunkId: linearized.chunkId,
        coords: linearized.coords,
        bytes: result.bytes,
        traces: result.traces,
      };
  });

  const encodedBytes = concatBytes(encodedChunks.map((ec) => ec.bytes));
  const encodedTraces = encodedChunks.flatMap((ec) => ec.traces);
  const encodedLayout = buildEncodedLayout(linearizedLayout, encodedChunks, outputDtypes, hasEntropy);
  return { stage: makeStage('Encoded', encodedBytes, encodedTraces, encodedLayout), encodedChunks };
}

// ─── Stage 5: Metadata ──────────────────────────────────────────────────────
//
// Depends on: the full AppState (collectMetadata re-derives schema/shape/
// codec config from state directly rather than from prior stage outputs) plus
// the Encoded stage's encodedChunks and the Typed stage's variableStats.
// Typing a metadata custom entry re-runs only this stage (and Files/Read
// after it) — NOT generation/typing/chunking/encoding.

export interface MetadataStageResult {
  stage: PipelineStage;
}

export function computeMetadataStage(
  state: AppState,
  encodedChunks: EncodedChunk[],
  variableStats: Map<string, VariableStats>,
): MetadataStageResult {
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
  return { stage: makeStage('Metadata', metaBytes, metaTraces, buildMetadataLayout(metaBytes.length)) };
}

// ─── Stage 6: Write (assembled files) ──────────────────────────────────────
//
// Depends on: the full AppState (assembleFiles re-derives metadata bytes from
// state directly — see collectMetadata calls inside engine/write.ts) plus the
// Encoded stage's encodedChunks and the Typed stage's variableStats.

export interface FilesStageResult {
  stage: PipelineStage;
  files: VirtualFile[];
}

export function computeFilesStage(
  state: AppState,
  encodedChunks: EncodedChunk[],
  variableStats: Map<string, VariableStats>,
  encodedLayout: StageLayout,
): FilesStageResult {
  const chunkGrid = computeChunkGrid(state.shape, state.chunkShape);
  const files = assembleFiles(state, encodedChunks, chunkGrid, variableStats, encodedLayout);
  const writeBytes = concatBytes(files.map((f) => f.bytes));
  const writeTraces = files.flatMap((f) => f.traces);
  // Write-stage layout: per-file layouts concatenated in file order,
  // re-based (copy with adjusted `start`) to write-stage byte offsets —
  // files are concatenated in the same order above.
  const regions: LayoutRegion[] = [];
  let cursor = 0;
  for (const file of files) {
    for (const r of file.layout.regions) {
      regions.push({ ...r, start: r.start + cursor });
    }
    cursor += file.bytes.length;
  }
  const writeLayout: StageLayout = { byteLength: writeBytes.length, shape: state.shape, regions };
  return { stage: makeStage('Write', writeBytes, writeTraces, writeLayout), files };
}

// ─── Stage 7: Read ──────────────────────────────────────────────────────────
//
// Depends on: the Files stage's output, shape, each variable's name/color,
// and the write magic number.

export interface ReadStageResult {
  stage: PipelineStage;
  readResult: ReadFileResult;
  logicalValues: Map<string, LogicalValue[]>;
}

export function computeReadStage(
  files: VirtualFile[],
  shape: number[],
  variables: Variable[],
  magicNumber: string,
): ReadStageResult {
  // Per D2, the reader is given the format's magic number as bytes (not the
  // raw hex-string config) and verifies it rather than blindly stripping it.
  const readResult = readFile(files, { magic: hexToBytes(magicNumber) });

  if (readResult.success) {
    const logicalValues = new Map<string, LogicalValue[]>();
    for (const v of variables) {
      logicalValues.set(v.name, readResult.reconstructedValues.get(v.name) ?? []);
    }
    const { bytes, traces } = buildLogicalValuesStage(variables, shape, logicalValues);
    const layout = buildValueBlocksLayout(variables, shape, logicalValues, () => 'float64');
    return { stage: makeStage('Read', bytes, traces, layout), readResult, logicalValues };
  }

  const failureLayout: StageLayout = { byteLength: 0, shape, regions: [] };
  return { stage: makeStage('Read', new Uint8Array(0), [], failureLayout), readResult, logicalValues: new Map() };
}

// ─── Full composition (pure; used directly by tests and as the reference
// implementation for the memoized hook below) ───────────────────────────────

export interface PipelineResult {
  stages: PipelineStage[];
  files: VirtualFile[];
  chunkTraceMap: Map<string, Set<string>>;
  traceChunkMap: Map<string, string>;
  readResult: ReadFileResult;
  variableStats: Map<string, VariableStats>;
  /**
   * D6 (remediation-plan.md, Phase 3.3): Values-stage source arrays, keyed by
   * variable NAME (matching `readResult.reconstructedValues`). Viewers
   * consume this instead of re-decoding `stages[0].bytes` themselves — fixes
   * UI-9 and the two other byte-slicing copies in TableView/GridView.
   */
  logicalValues: Map<string, LogicalValue[]>;
  /** D6: Typed-stage source arrays, keyed by variable NAME. */
  typedValues: Map<string, LogicalValue[]>;
  /** Per-stage ValueSources for traceAt: values/read stages -> logicalValues
   *  (format 'logical'; read uses its reconstructed map), others -> typedValues
   *  (format 'typed'). */
  stageSources: Map<StageName, ValueSources>;
}

/** Build the stageSources map (brief, Task 7): values/read -> logical
 * (float64) source arrays, typed/linearized/encoded/metadata/write -> typed
 * source arrays (metadata/write have no per-value regions, so their sources
 * are structurally unused by traceAt, but 'typed' is the correct family). */
function buildStageSources(
  logicalValues: Map<string, LogicalValue[]>,
  typedValues: Map<string, LogicalValue[]>,
  readLogicalValues: Map<string, LogicalValue[]>,
): Map<StageName, ValueSources> {
  const logical: ValueSources = { values: logicalValues as Map<string, ValueArray>, format: 'logical' };
  const typed: ValueSources = { values: typedValues as Map<string, ValueArray>, format: 'typed' };
  const read: ValueSources = { values: readLogicalValues as Map<string, ValueArray>, format: 'logical' };
  return new Map<StageName, ValueSources>([
    ['values', logical],
    ['typed', typed],
    ['linearized', typed],
    ['encoded', typed],
    ['metadata', typed],
    ['write', typed],
    ['read', read],
  ]);
}

export function computePipelineStages(state: AppState): PipelineResult {
  const values = computeValuesStage(state.shape, state.variables);
  const typed = computeTypedStage(state.shape, state.variables, values.variableValues);
  const linearized = computeLinearizedStage(
    state.shape,
    state.chunkShape,
    state.interleaving,
    state.variables,
    typed.typedVariableValues,
  );
  const encoded = computeEncodedStage(
    linearized.chunks,
    linearized.linearizedChunks,
    state.interleaving,
    state.variables,
    state.fieldPipelines,
    state.chunkPipeline,
    linearized.stage.layout,
  );
  const metadata = computeMetadataStage(state, encoded.encodedChunks, typed.variableStats);
  const files = computeFilesStage(state, encoded.encodedChunks, typed.variableStats, encoded.stage.layout);
  const read = computeReadStage(files.files, state.shape, state.variables, state.write.magicNumber);

  const stages: PipelineStage[] = [
    values.stage,
    typed.stage,
    linearized.stage,
    encoded.stage,
    metadata.stage,
    files.stage,
    read.stage,
  ];

  return {
    stages,
    files: files.files,
    chunkTraceMap: linearized.chunkTraceMap,
    traceChunkMap: linearized.traceChunkMap,
    readResult: read.readResult,
    variableStats: typed.variableStats,
    logicalValues: values.variableValues,
    typedValues: typed.typedVariableValues,
    stageSources: buildStageSources(values.variableValues, typed.typedVariableValues, read.logicalValues),
  };
}

// ─── Memoized hook ──────────────────────────────────────────────────────────
//
// Chained useMemos with real dependency boundaries (SW-3): a change to a
// later-stage-only input (e.g. a metadata custom entry, or the write magic
// number) must not recompute generation/typing/chunking/encoding. Each memo
// below lists exactly the state slices its stage function reads — see the
// per-stage doc comments above for the full dependency rationale.

export function usePipeline(state: AppState): PipelineResult {
  const values = useMemo(
    () => computeValuesStage(state.shape, state.variables),
    [state.shape, state.variables],
  );

  const typed = useMemo(
    () => computeTypedStage(state.shape, state.variables, values.variableValues),
    [state.shape, state.variables, values.variableValues],
  );

  const linearized = useMemo(
    () => computeLinearizedStage(
      state.shape,
      state.chunkShape,
      state.interleaving,
      state.variables,
      typed.typedVariableValues,
    ),
    [state.shape, state.chunkShape, state.interleaving, state.variables, typed.typedVariableValues],
  );

  const encoded = useMemo(
    () => computeEncodedStage(
      linearized.chunks,
      linearized.linearizedChunks,
      state.interleaving,
      state.variables,
      state.fieldPipelines,
      state.chunkPipeline,
      linearized.stage.layout,
    ),
    [
      linearized.chunks,
      linearized.linearizedChunks,
      state.interleaving,
      state.variables,
      state.fieldPipelines,
      state.chunkPipeline,
      linearized.stage.layout,
    ],
  );

  const metadata = useMemo(
    () => computeMetadataStage(state, encoded.encodedChunks, typed.variableStats),
    [state, encoded.encodedChunks, typed.variableStats],
  );

  const files = useMemo(
    () => computeFilesStage(state, encoded.encodedChunks, typed.variableStats, encoded.stage.layout),
    [state, encoded.encodedChunks, typed.variableStats, encoded.stage.layout],
  );

  const read = useMemo(
    () => computeReadStage(files.files, state.shape, state.variables, state.write.magicNumber),
    [files.files, state.shape, state.variables, state.write.magicNumber],
  );

  return useMemo(
    () => ({
      stages: [
        values.stage,
        typed.stage,
        linearized.stage,
        encoded.stage,
        metadata.stage,
        files.stage,
        read.stage,
      ],
      files: files.files,
      chunkTraceMap: linearized.chunkTraceMap,
      traceChunkMap: linearized.traceChunkMap,
      readResult: read.readResult,
      variableStats: typed.variableStats,
      logicalValues: values.variableValues,
      typedValues: typed.typedVariableValues,
      stageSources: buildStageSources(values.variableValues, typed.typedVariableValues, read.logicalValues),
    }),
    [values, typed, linearized, encoded.stage, metadata.stage, files, read],
  );
}
