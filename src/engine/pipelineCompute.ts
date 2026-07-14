import type { AppState, Variable } from '../types/state.ts';
import type { CodecStep } from '../types/codecs.ts';
import { fillFromSource } from './sourceFill.ts';
import type {
  PipelineStage,
  Chunk,
  LinearizedChunk,
  EncodedChunk,
  VirtualFile,
  ReadFileResult,
  VariableStats,
  StageName,
} from '../types/pipeline.ts';
import { STAGE_ORDER } from '../types/pipeline.ts';
import type { DtypeKey } from '../types/dtypes.ts';
import type { LinearizationOrder } from './order.ts';
import { generateValues } from './generate.ts';
import { assignType } from './typeAssign.ts';
import { chunkData, chunkDataPerVariable, computeChunkGrid } from './chunk.ts';
import { linearizeChunk } from './linearize.ts';
import { runCodecPipeline, shannonEntropy } from './codecs.ts';
import { collectMetadata, serializeMetadata } from './metadata.ts';
import { assembleFiles } from './write.ts';
import { valuesToBytes, bytesToValues } from './elements.ts';
import { readFile } from './read.ts';
import { hexToBytes, concatBytes } from './bytes.ts';
import {
  buildValueBlocksLayout,
  buildLinearizedLayout,
  buildEncodedLayout,
  buildMetadataLayout,
  encodedChunkMeta,
  type StageLayout,
  type ValueArray,
  type ValueSources,
  type LayoutRegion,
} from './layout.ts';

function makeStage(name: string, bytes: Uint8Array, layout: StageLayout): PipelineStage {
  return {
    name,
    bytes,
    layout,
    stats: {
      byteCount: bytes.length,
      entropy: shannonEntropy(bytes),
    },
  };
}

/**
 * Build a Values-stage-shaped byte blob for a set of logical (float64)
 * values per variable. Shared by the Values stage and the Read stage, which
 * both display reconstructed logical values in the same layout.
 *
 * Per-byte tracing for this stage is computed on demand from the returned
 * bytes' StageLayout (buildValueBlocksLayout) via traceAt, not materialized
 * here — see CLAUDE.md pitfall 1.
 */
function buildLogicalValuesStage(
  variables: Pick<Variable, 'name' | 'color'>[],
  valuesByName: Map<string, ValueArray>,
  byteOrder: 'little' | 'big' = 'little',
): { bytes: Uint8Array } {
  const partBytes: Uint8Array[] = [];
  for (const v of variables) {
    const vals = valuesByName.get(v.name) ?? [];

    if (vals.some((x) => typeof x === 'string')) {
      // Text variables: at the Values stage each FULL, untruncated string is
      // encoded as raw ASCII with byteCount = str.length — variable stride
      // here vs. the fixed charN stride at Typed IS the lesson. Both
      // HexView/FlatView are layout-driven, so variable stride is safe.
      for (let i = 0; i < vals.length; i++) {
        const str = String(vals[i]);
        const strBytes = new Uint8Array(str.length);
        for (let c = 0; c < str.length; c++) {
          const code = str.charCodeAt(c);
          strBytes[c] = code <= 0x7f ? code : 0x3f; // '?'
        }
        partBytes.push(strBytes);
      }
      continue;
    }

    partBytes.push(valuesToBytes(vals, 'float64', byteOrder));
  }
  return { bytes: concatBytes(partBytes) };
}

// ─── Stage 1: Values ───────────────────────────────────────────────────────
//
// Depends only on: shape, and each variable's name/color/logicalType. Does
// NOT depend on typeAssignment, chunkShape, interleaving, codecs, metadata,
// or write config.

export interface ValuesStageResult {
  stage: PipelineStage;
  variableValues: Map<string, ValueArray>;
}

/** A curated variable's fetched values plus its natural (source) shape. Keyed
 * `${datasetId}/${variableName}` — exactly the `Variable.source` ref. The
 * worker builds this map before compute; missing/wrong-length entries fail
 * loud. */
export type SourceValues = Map<string, { values: ValueArray; naturalShape: number[] }>;

export function computeValuesStage(
  shape: number[],
  variables: Variable[],
  byteOrder: 'little' | 'big' = 'little',
  sourceValues?: SourceValues,
): ValuesStageResult {
  const totalElements = shape.reduce((a, b) => a * b, 1);

  const variableValues = new Map<string, ValueArray>();
  for (const v of variables) {
    // Per-variable contract: binding is by the explicit `source` ref only. A
    // curated variable MUST get its real source values (fail loud if the ref
    // wasn't loaded — surfaces via the worker's ResultErr path); custom
    // variables generate. Renaming a row never hijacks or loses values.
    if (v.source) {
      const key = `${v.source.datasetId}/${v.source.variableName}`;
      const entry = sourceValues?.get(key);
      if (!entry) {
        throw new Error(`source values: variable "${v.name}" ref "${key}" not loaded before compute`);
      }
      const srcTotal = entry.naturalShape.reduce((a, b) => a * b, 1);
      if (entry.values.length !== srcTotal) {
        throw new Error(`source values: variable "${v.name}" ref "${key}" expected ${srcTotal} values (natural shape), got ${entry.values.length}`);
      }
      // fillFromSource returns a FRESH array (never aliases `entry.values`), so
      // the copy-on-injection discipline (DP-4) is satisfied: the worker's
      // long-lived source cache buffer is never the one transferred/detached on
      // postMessage.
      variableValues.set(v.name, fillFromSource(entry.values, entry.naturalShape, shape));
    } else {
      variableValues.set(v.name, generateValues(v.name, v.logicalType, totalElements, undefined, shape));
    }
  }

  const { bytes } = buildLogicalValuesStage(variables, variableValues, byteOrder);
  const layout = buildValueBlocksLayout(
    variables, shape, variableValues,
    (name) => (variableValues.get(name) ?? []).some((v) => typeof v === 'string') ? 'text' : 'float64',
  );
  return { stage: makeStage('Values', bytes, layout), variableValues };
}

// ─── Stage 2: Typed ──────────────────────────────────────────────────────────
//
// Depends on: the Values stage's variableValues, shape, and each variable's
// name/color/logicalType/typeAssignment. Does NOT depend on chunkShape,
// interleaving, codecs, metadata, or write config.

export interface TypedStageResult {
  stage: PipelineStage;
  typedVariableValues: Map<string, ValueArray>;
  variableStats: Map<string, VariableStats>;
}

export function computeTypedStage(
  shape: number[],
  variables: Variable[],
  variableValues: Map<string, ValueArray>,
  byteOrder: 'little' | 'big' = 'little',
): TypedStageResult {
  const typedPartBytes: Uint8Array[] = [];
  const variableStats = new Map<string, VariableStats>();
  const typedVariableValues = new Map<string, ValueArray>();

  for (const v of variables) {
    const vals = variableValues.get(v.name) ?? [];
    const result = assignType(vals, v.logicalType, v.typeAssignment, byteOrder);
    const storageDtype = v.typeAssignment.storageDtype;

    typedPartBytes.push(result.bytes);
    variableStats.set(v.name, result.stats);

    // Read back the typed values for use in chunking — bytesToValues honors the
    // same byteOrder the bytes were written with, and handles char dtypes
    // (strings) through the same single code path.
    const typedVals = bytesToValues(result.bytes, storageDtype, byteOrder);
    typedVariableValues.set(v.name, typedVals);
  }
  const typedBytes = concatBytes(typedPartBytes);
  const typedLayout = buildValueBlocksLayout(
    variables, shape, typedVariableValues,
    (name) => variables.find((v) => v.name === name)!.typeAssignment.storageDtype,
  );
  return {
    stage: makeStage('Typed', typedBytes, typedLayout),
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
}

export function computeLinearizedStage(
  shape: number[],
  chunkShape: number[],
  interleaving: 'row' | 'column',
  variables: Variable[],
  typedVariableValues: Map<string, ValueArray>,
  linearization: LinearizationOrder = 'c',
  byteOrder: 'little' | 'big' = 'little',
): LinearizedStageResult {
  const chunkVariables = variables.map((v) => ({
    ...v,
    dtype: v.typeAssignment.storageDtype as string,
  }));
  const chunks = interleaving === 'column'
    ? chunkDataPerVariable(shape, chunkShape, chunkVariables, typedVariableValues, linearization)
    : chunkData(shape, chunkShape, chunkVariables, typedVariableValues, linearization);
  const linearizedChunks = chunks.map((chunk) => linearizeChunk(chunk, interleaving, byteOrder));
  const linearizedBytes = concatBytes(linearizedChunks.map((lc) => lc.bytes));

  const linearizedLayout = buildLinearizedLayout(chunks, linearizedChunks, interleaving, shape, chunkShape, linearization);

  return {
    stage: makeStage('Linearized', linearizedBytes, linearizedLayout),
    chunks,
    linearizedChunks,
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
    const result = runCodecPipeline(linearized.bytes, steps, inputDtype);
    return interleaving === 'column'
      ? {
        chunkId: linearized.chunkId,
        coords: linearized.coords,
        bytes: result.bytes,
        variableName: linearized.variableName,
      }
      : {
        chunkId: linearized.chunkId,
        coords: linearized.coords,
        bytes: result.bytes,
      };
  });

  const encodedBytes = concatBytes(encodedChunks.map((ec) => ec.bytes));
  const encodedLayout = buildEncodedLayout(linearizedLayout, encodedChunks, outputDtypes, hasEntropy);
  return { stage: makeStage('Encoded', encodedBytes, encodedLayout), encodedChunks };
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
  return { stage: makeStage('Metadata', metaBytes, buildMetadataLayout(metaBytes.length)) };
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
  return { stage: makeStage('Write', writeBytes, writeLayout), files };
}

// ─── Stage 7: Read ──────────────────────────────────────────────────────────
//
// Depends on: the Files stage's output, shape, each variable's name/color,
// and the write magic number.

export interface ReadStageResult {
  stage: PipelineStage;
  readResult: ReadFileResult;
  logicalValues: Map<string, ValueArray>;
}

export function computeReadStage(
  files: VirtualFile[],
  shape: number[],
  variables: Variable[],
  magicNumber: string,
  byteOrder: 'little' | 'big' = 'little',
): ReadStageResult {
  // Per D2, the reader is given the format's magic number as bytes (not the
  // raw hex-string config) and verifies it rather than blindly stripping it.
  const readResult = readFile(files, { magic: hexToBytes(magicNumber) });

  if (readResult.success) {
    const logicalValues = new Map<string, ValueArray>();
    for (const v of variables) {
      logicalValues.set(v.name, readResult.reconstructedValues.get(v.name) ?? []);
    }
    const { bytes } = buildLogicalValuesStage(variables, logicalValues, byteOrder);
    const layout = buildValueBlocksLayout(variables, shape, logicalValues, () => 'float64');
    return { stage: makeStage('Read', bytes, layout), readResult, logicalValues };
  }

  const failureLayout: StageLayout = { byteLength: 0, shape, regions: [] };
  return { stage: makeStage('Read', new Uint8Array(0), failureLayout), readResult, logicalValues: new Map() };
}

// ─── Full composition (pure; used directly by tests and as the reference
// implementation for the memoized worker computer below) ───────────────────

export interface PipelineResult {
  stages: PipelineStage[];
  files: VirtualFile[];
  readResult: ReadFileResult;
  variableStats: Map<string, VariableStats>;
  /**
   * D6 (remediation-plan.md, Phase 3.3): Values-stage source arrays, keyed by
   * variable NAME (matching `readResult.reconstructedValues`). Viewers
   * consume this instead of re-decoding `stages[0].bytes` themselves — fixes
   * UI-9 and the two other byte-slicing copies in TableView/GridView.
   */
  logicalValues: Map<string, ValueArray>;
  /** D6: Typed-stage source arrays, keyed by variable NAME. */
  typedValues: Map<string, ValueArray>;
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
  logicalValues: Map<string, ValueArray>,
  typedValues: Map<string, ValueArray>,
  readLogicalValues: Map<string, ValueArray>,
): Map<StageName, ValueSources> {
  const logical: ValueSources = { values: logicalValues, format: 'logical' };
  const typed: ValueSources = { values: typedValues, format: 'typed' };
  const read: ValueSources = { values: readLogicalValues, format: 'logical' };
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

export function computePipelineStages(
  state: AppState,
  onStage?: (stage: StageName, ms: number) => void,
  sourceValues?: SourceValues,
): PipelineResult {
  const timed = <T,>(stage: StageName, fn: () => T): T => {
    if (!onStage) return fn();
    const t0 = performance.now();
    const out = fn();
    onStage(stage, performance.now() - t0);
    return out;
  };

  const values = timed('values', () => computeValuesStage(state.shape, state.variables, state.byteOrder, sourceValues));
  const typed = timed('typed', () => computeTypedStage(state.shape, state.variables, values.variableValues, state.byteOrder));
  const linearized = timed('linearized', () => computeLinearizedStage(
    state.shape,
    state.chunkShape,
    state.interleaving,
    state.variables,
    typed.typedVariableValues,
    state.linearization,
    state.byteOrder,
  ));
  const encoded = timed('encoded', () => computeEncodedStage(
    linearized.chunks,
    linearized.linearizedChunks,
    state.interleaving,
    state.variables,
    state.fieldPipelines,
    state.chunkPipeline,
    linearized.stage.layout,
  ));
  const metadata = timed('metadata', () => computeMetadataStage(state, encoded.encodedChunks, typed.variableStats));
  const files = timed('write', () => computeFilesStage(state, encoded.encodedChunks, typed.variableStats, encoded.stage.layout));
  const read = timed('read', () => computeReadStage(files.files, state.shape, state.variables, state.write.magicNumber, state.byteOrder));

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
    readResult: read.readResult,
    variableStats: typed.variableStats,
    logicalValues: values.variableValues,
    typedValues: typed.typedVariableValues,
    stageSources: buildStageSources(values.variableValues, typed.typedVariableValues, read.logicalValues),
  };
}

// ─── Stage-delta protocol (PERF-1) ──────────────────────────────────────────
//
// The worker never posts a full PipelineResult: at ~8.38M values the
// structured clone of one (~400MB) throws "Data cannot be cloned, out of
// memory". Instead each compute returns a per-stage delta — the client sends
// the memo keys it already holds (`knownKeys`), and a stage's payload is
// included only when its key changed. Included payloads are posted with a
// transfer list (zero-copy, no clone ceiling); the client keeps a per-stage
// payload store and reassembles a PipelineResult via assemblePipelineResult.

/** The client-facing slice of each stage's output. Only what viewers/UI
 * consume crosses the thread boundary — worker-internal intermediates
 * (chunks, linearizedChunks, encodedChunks) stay in the worker cache. */
export interface StagePayloads {
  values: { stage: PipelineStage; logicalValues: Map<string, ValueArray> };
  typed: { stage: PipelineStage; typedValues: Map<string, ValueArray>; variableStats: Map<string, VariableStats> };
  linearized: { stage: PipelineStage };
  encoded: { stage: PipelineStage };
  metadata: { stage: PipelineStage };
  write: { stage: PipelineStage; files: VirtualFile[] };
  read: { stage: PipelineStage; readResult: ReadFileResult; readLogicalValues: Map<string, ValueArray> };
}

export type StageKnownKeys = Partial<Record<StageName, string>>;

export type PipelineDelta = {
  [S in StageName]: { key: string; payload?: StagePayloads[S] };
};

/** Client-side reassembly of a full PipelineResult from the per-stage payload
 * store (all seven stages must be present — the first delta always carries
 * all of them, and later deltas only replace entries). */
export function assemblePipelineResult(payloads: StagePayloads): PipelineResult {
  return {
    stages: STAGE_ORDER.map((s) => payloads[s].stage),
    files: payloads.write.files,
    readResult: payloads.read.readResult,
    variableStats: payloads.typed.variableStats,
    logicalValues: payloads.values.logicalValues,
    typedValues: payloads.typed.typedValues,
    stageSources: buildStageSources(
      payloads.values.logicalValues,
      payloads.typed.typedValues,
      payloads.read.readLogicalValues,
    ),
  };
}

// ─── Worker-side stateful memoizer ──────────────────────────────────────────
//
// Replaces the old chained-useMemo hook's dependency boundaries (SW-3): a
// change to a later-stage-only input (e.g. a metadata custom entry, or the
// write magic number) must not recompute generation/typing/chunking/encoding.
// One instance lives for the worker's lifetime (module-scope in
// pipeline.worker.ts) and is called once per incoming message. Each stage's
// memo key is a JSON string of exactly the state slices that stage's compute
// function reads — see the per-stage doc comments above each compute*Stage
// for the dependency rationale — with the upstream stage's memo key folded
// into the downstream key so an upstream change invalidates every stage after
// it, matching the useMemo dependency chain this replaces.
//
// Transfer vs. memoization (PERF-1, superseding Task 13's clone-everything
// fix): a payload included in the returned delta is about to have its buffers
// TRANSFERRED (detached) by the worker's postMessage, so its stage is evicted
// from the cache — a later hit would hand back detached memory (the Task 13
// bug). Eviction is safe because a sent stage's key changed, which (chained
// keys) means every downstream stage was sent and evicted too; an omitted
// stage's buffers never enter the message, so its cache entry stays valid.
// Cost: one extra recompute per stage the first time it's needed again after
// being resent — steady-state edits recompute only stages that changed anyway.

export function createPipelineComputer(): (
  state: AppState,
  knownKeys?: StageKnownKeys,
  onStage?: (stage: StageName, ms: number) => void,
  sourceValues?: SourceValues,
) => PipelineDelta {
  const cache = new Map<StageName, { key: string; value: unknown }>();

  const memo = <T,>(stage: StageName, deps: unknown, fn: () => T): { value: T; key: string; hit: boolean } => {
    const key = JSON.stringify(deps);
    const hit = cache.get(stage);
    if (hit && hit.key === key) return { value: hit.value as T, key, hit: true };
    const value = fn();
    cache.set(stage, { key, value });
    return { value, key, hit: false };
  };

  return (state, knownKeys = {}, onStage, sourceValues) => {
    // Per-variable fail-loud lives in computeValuesStage: a variable with a
    // `source` ref but no matching loaded entry throws there. No schema-wide
    // guard needed.
    // memo() has already run (and decided hit vs. miss) by the time `report`
    // sees it, so per the brief: report 0ms for a hit, and the wall-clock
    // time actually spent for a miss (measured by the caller wrapping the
    // memo() call in t0/performance.now(), since memo() itself doesn't know
    // about timing).
    const report = <T,>(stage: StageName, t0: number, m: { value: T; hit: boolean }): T => {
      onStage?.(stage, m.hit ? 0 : performance.now() - t0);
      return m.value;
    };

    let t0 = performance.now();
    const valuesM = memo(
      'values',
      // buildLogicalValuesStage writes the Values-stage display bytes with
      // state.byteOrder, so the Values stage's OUTPUT bytes depend on it.
      // `variables` carries each row's `source` ref, so a source change busts
      // the memo (values content itself was never keyed — unchanged).
      { shape: state.shape, variables: state.variables, byteOrder: state.byteOrder },
      () => computeValuesStage(state.shape, state.variables, state.byteOrder, sourceValues),
    );
    const values = report('values', t0, valuesM);

    t0 = performance.now();
    const typedM = memo(
      'typed',
      { valuesKey: valuesM.key, shape: state.shape, variables: state.variables, byteOrder: state.byteOrder },
      () => computeTypedStage(state.shape, state.variables, values.variableValues, state.byteOrder),
    );
    const typed = report('typed', t0, typedM);

    t0 = performance.now();
    const linearizedM = memo(
      'linearized',
      {
        typedKey: typedM.key,
        shape: state.shape,
        chunkShape: state.chunkShape,
        interleaving: state.interleaving,
        linearization: state.linearization,
        byteOrder: state.byteOrder,
        variables: state.variables,
      },
      () => computeLinearizedStage(
        state.shape,
        state.chunkShape,
        state.interleaving,
        state.variables,
        typed.typedVariableValues,
        state.linearization,
        state.byteOrder,
      ),
    );
    const linearized = report('linearized', t0, linearizedM);

    t0 = performance.now();
    const encodedM = memo(
      'encoded',
      {
        linearizedKey: linearizedM.key,
        interleaving: state.interleaving,
        variables: state.variables,
        fieldPipelines: state.fieldPipelines,
        chunkPipeline: state.chunkPipeline,
      },
      () => computeEncodedStage(
        linearized.chunks,
        linearized.linearizedChunks,
        state.interleaving,
        state.variables,
        state.fieldPipelines,
        state.chunkPipeline,
        linearized.stage.layout,
      ),
    );
    const encoded = report('encoded', t0, encodedM);

    // metadata/write's compute functions read the full AppState (they
    // re-derive schema/codec config from state directly), but `state.ui`
    // (pane selections, view modes, diff toggle) affects nothing either
    // stage computes — key on a ui-less copy so a ui-only change is a memo
    // hit here, matching useWorkerPipeline's comment that these memos never
    // key on it.
    const { ui: _ui, ...stateForKey } = state;

    t0 = performance.now();
    const metadataM = memo(
      'metadata',
      { encodedKey: encodedM.key, typedKey: typedM.key, state: stateForKey },
      () => computeMetadataStage(state, encoded.encodedChunks, typed.variableStats),
    );
    const metadata = report('metadata', t0, metadataM);

    t0 = performance.now();
    const filesM = memo(
      'write',
      { encodedKey: encodedM.key, typedKey: typedM.key, state: stateForKey },
      () => computeFilesStage(state, encoded.encodedChunks, typed.variableStats, encoded.stage.layout),
    );
    const files = report('write', t0, filesM);

    t0 = performance.now();
    const readM = memo(
      'read',
      { filesKey: filesM.key, shape: state.shape, variables: state.variables, magicNumber: state.write.magicNumber, byteOrder: state.byteOrder },
      () => computeReadStage(files.files, state.shape, state.variables, state.write.magicNumber, state.byteOrder),
    );
    const read = report('read', t0, readM);

    const delta = {} as PipelineDelta;
    const emit = <S extends StageName>(s: S, key: string, payload: StagePayloads[S]) => {
      if (knownKeys[s] === key) {
        delta[s] = { key };
        return;
      }
      // TS can't prove a generic mapped-type write (delta[s] is the union of
      // all per-stage entry types from inside the generic); each call site
      // pairs s with its own StagePayloads[S], so the assertion is sound.
      (delta as Record<S, { key: string; payload: StagePayloads[S] }>)[s] = { key, payload };
      // Evict-on-send: this payload's buffers are about to be transferred
      // (detached) by postMessage — the cached value would be garbage.
      cache.delete(s);
    };

    emit('values', valuesM.key, { stage: values.stage, logicalValues: values.variableValues });
    emit('typed', typedM.key, {
      stage: typed.stage,
      typedValues: typed.typedVariableValues,
      variableStats: typed.variableStats,
    });
    emit('linearized', linearizedM.key, { stage: linearized.stage });
    emit('encoded', encodedM.key, { stage: encoded.stage });
    emit('metadata', metadataM.key, { stage: metadata.stage });
    emit('write', filesM.key, { stage: files.stage, files: files.files });
    emit('read', readM.key, {
      stage: read.stage,
      readResult: read.readResult,
      readLogicalValues: read.logicalValues,
    });

    return delta;
  };
}
