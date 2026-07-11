import type { AppState, Variable } from '../types/state.ts';
import type { CodecStep } from '../types/codecs.ts';
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
import type { DtypeKey } from '../types/dtypes.ts';
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
  chunkRegionsOf,
  type StageLayout,
  type ValueArray,
  type ValueSources,
  type LayoutRegion,
} from './layout.ts';

function makeStage(name: string, bytes: Uint8Array, layout: StageLayout): PipelineStage {
  return {
    name,
    bytes,
    chunkRegions: chunkRegionsOf(layout),
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

    partBytes.push(valuesToBytes(vals, 'float64'));
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

export function computeValuesStage(
  shape: number[],
  variables: Variable[],
): ValuesStageResult {
  const totalElements = shape.reduce((a, b) => a * b, 1);

  const variableValues = new Map<string, ValueArray>();
  for (const v of variables) {
    variableValues.set(v.name, generateValues(v.name, v.logicalType, totalElements));
  }

  const { bytes } = buildLogicalValuesStage(variables, variableValues);
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
): TypedStageResult {
  const typedPartBytes: Uint8Array[] = [];
  const variableStats = new Map<string, VariableStats>();
  const typedVariableValues = new Map<string, ValueArray>();

  for (const v of variables) {
    const vals = variableValues.get(v.name) ?? [];
    const result = assignType(vals, v.logicalType, v.typeAssignment);
    const storageDtype = v.typeAssignment.storageDtype;

    typedPartBytes.push(result.bytes);
    variableStats.set(v.name, result.stats);

    // Read back the typed values for use in chunking — bytesToValues has the
    // same LE semantics as the TypedArray view it replaced, and handles char
    // dtypes (strings) through the same single code path.
    const typedVals = bytesToValues(result.bytes, storageDtype);
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

  const linearizedLayout = buildLinearizedLayout(chunks, linearizedChunks, interleaving, shape, chunkShape);

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
): ReadStageResult {
  // Per D2, the reader is given the format's magic number as bytes (not the
  // raw hex-string config) and verifies it rather than blindly stripping it.
  const readResult = readFile(files, { magic: hexToBytes(magicNumber) });

  if (readResult.success) {
    const logicalValues = new Map<string, ValueArray>();
    for (const v of variables) {
      logicalValues.set(v.name, readResult.reconstructedValues.get(v.name) ?? []);
    }
    const { bytes } = buildLogicalValuesStage(variables, logicalValues);
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
): PipelineResult {
  const timed = <T,>(stage: StageName, fn: () => T): T => {
    if (!onStage) return fn();
    const t0 = performance.now();
    const out = fn();
    onStage(stage, performance.now() - t0);
    return out;
  };

  const values = timed('values', () => computeValuesStage(state.shape, state.variables));
  const typed = timed('typed', () => computeTypedStage(state.shape, state.variables, values.variableValues));
  const linearized = timed('linearized', () => computeLinearizedStage(
    state.shape,
    state.chunkShape,
    state.interleaving,
    state.variables,
    typed.typedVariableValues,
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
  const read = timed('read', () => computeReadStage(files.files, state.shape, state.variables, state.write.magicNumber));

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

export function createPipelineComputer(): (
  state: AppState,
  onStage?: (stage: StageName, ms: number) => void,
) => PipelineResult {
  const cache = new Map<StageName, { key: string; value: unknown }>();

  const memo = <T,>(stage: StageName, deps: unknown, fn: () => T): { value: T; key: string; hit: boolean } => {
    const key = JSON.stringify(deps);
    const hit = cache.get(stage);
    if (hit && hit.key === key) return { value: hit.value as T, key, hit: true };
    const value = fn();
    cache.set(stage, { key, value });
    return { value, key, hit: false };
  };

  return (state, onStage) => {
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
      { shape: state.shape, variables: state.variables },
      () => computeValuesStage(state.shape, state.variables),
    );
    const values = report('values', t0, valuesM);

    t0 = performance.now();
    const typedM = memo(
      'typed',
      { valuesKey: valuesM.key, shape: state.shape, variables: state.variables },
      () => computeTypedStage(state.shape, state.variables, values.variableValues),
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
        variables: state.variables,
      },
      () => computeLinearizedStage(
        state.shape,
        state.chunkShape,
        state.interleaving,
        state.variables,
        typed.typedVariableValues,
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

    t0 = performance.now();
    const metadataM = memo(
      'metadata',
      { encodedKey: encodedM.key, typedKey: typedM.key, state },
      () => computeMetadataStage(state, encoded.encodedChunks, typed.variableStats),
    );
    const metadata = report('metadata', t0, metadataM);

    t0 = performance.now();
    const filesM = memo(
      'write',
      { encodedKey: encodedM.key, typedKey: typedM.key, state },
      () => computeFilesStage(state, encoded.encodedChunks, typed.variableStats, encoded.stage.layout),
    );
    const files = report('write', t0, filesM);

    t0 = performance.now();
    const readM = memo(
      'read',
      { filesKey: filesM.key, shape: state.shape, variables: state.variables, magicNumber: state.write.magicNumber },
      () => computeReadStage(files.files, state.shape, state.variables, state.write.magicNumber),
    );
    const read = report('read', t0, readM);

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
  };
}
