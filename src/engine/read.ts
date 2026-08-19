import type { VirtualFile, ReadFileResult } from '../types/pipeline.ts';
import type { DtypeKey } from '../types/dtypes.ts';
import type { CodecStep } from '../types/codecs.ts';
import type { TypeAssignment } from '../types/state.ts';
import { type MetadataEntry, METADATA_KEY_GROUPS, type ChunkIndexEntry } from './metadata.ts';
import { CODEC_REGISTRY, outputDtypeFor } from './codecs.ts';
import { LINEARIZATION_ORDERS, type LinearizationOrder } from './order.ts';
import { locateMetadata, verifyMagic, describeMagicMismatch } from './readLocate.ts';
import {
  createStepRecorder,
  makeFailure,
  describeError,
  type StepRecorder,
} from './readSteps.ts';
import {
  type ReassemblyContext,
  type SchemaEntry,
  resolveChunkIndex,
  reconstructValues,
  makeSingleFileChunkReader,
  makePerChunkFileReader,
  reverseTypeAssignmentValues,
  rowModeInputDtype,
  NoChunkIndexError,
} from './readReassemble.ts';

// Read plan Task 1: read.ts keeps orchestration (readFile/parseStructure/
// reconstruct) and re-exports the public API that used to live here, so
// existing importers (ReadProcessView.tsx, tests) keep working unchanged.
export { READ_STEP_ORDER } from './readSteps.ts';

/** The runtime host's byte order — a real check, not a hardcoded assumption:
 * write 1 as a Uint16 and see whether the low byte lands first. Browsers and
 * Node are little-endian in practice, but the reader's assume-host fallback is
 * only honest if it reports the byte order the code is actually running on. */
export function hostByteOrder(): 'little' | 'big' {
  return new Uint8Array(Uint16Array.of(1).buffer)[0] === 1 ? 'little' : 'big';
}

/** Read plan Task 3: thrown by `parseStructure` when the `schema` key itself
 * is absent from located metadata entries (`metadata.include.schema` off at
 * write time). Mapped by `readFile` to failure reason 'missing-schema' at the
 * read-schema step. Distinct from a present-but-malformed `schema` value,
 * which stays a JSON.parse throw mapped to 'corrupt-metadata'. */
class MissingSchemaError extends Error {}

/** Read plan Task 3: thrown by `parseStructure` when `shape`/`chunk_shape`
 * are absent (`metadata.include.layout` off). Only checked once schema is
 * confirmed present — schema absence wins first when both are off, mirroring
 * the reader's step order (read-schema before read-layout). Mapped to
 * 'missing-layout' at the read-layout step. */
class MissingLayoutError extends Error {}

export { MissingSchemaError, MissingLayoutError };

interface VariableStatsLike {
  isLossy: boolean;
}

/** Format specification the reader was "built for" (D2) — analogous to a
 * Parquet reader knowing `PAR1` or a TIFF reader knowing `II*\0`. The reader
 * verifies the magic rather than blindly stripping it. */
export interface ReadFormatSpec {
  magic: Uint8Array;
}

/** Parsed dataset structure recovered from metadata entries — everything
 * `reconstruct` needs to reassemble values, independent of how or where the
 * entries were located. */
export interface ParsedStructure {
  schema: SchemaEntry[];
  shape: number[];
  chunkShape: number[];
  interleaving: 'row' | 'column';
  /** cl-6: element linearization order within each chunk. Defaults to 'c' when
   * the metadata key is absent (old files), keeping them byte-compatible. */
  linearization: LinearizationOrder;
  /** Whether each chunk is written per its own values (`'single'`) or values
   * are laid out per-chunk before being partitioned across files
   * (`'per-chunk'`). Defaults to `'single'` when the `partitioning` key is
   * absent (old files). */
  partitioning: 'single' | 'per-chunk';
  /** Whether the `partitioning` entry was actually present in the metadata.
   * When false, reader selection falls back to the `dataFiles.length === 1`
   * heuristic (old files carried no partitioning key). Mirrors
   * `byteOrderRecorded`. */
  partitioningRecorded: boolean;
  /** Order chunks are visited when writing/laying out the chunk stream.
   * Defaults to `'row-major'` when the `chunk_order` key is absent (old
   * files). */
  chunkOrder: 'row-major' | 'column-major';
  fieldPipelines: Record<string, CodecStep[]> | null;
  chunkPipeline: CodecStep[] | null;
  chunkIndex: ChunkIndexEntry[] | null;
  typeAssignments: Record<string, TypeAssignment> | null;
  variableStatistics: Record<string, VariableStatsLike> | null;
  totalElements: number;
  /** Byte order to decode multi-byte values with. Taken from the `byte_order`
   * metadata entry when present; falls back to the host's order when absent
   * (`byteOrderRecorded === false`) — a silent assumption, NOT a failure (spec
   * risk 5): a big-endian file written with the entry omitted reads
   * successfully with garbled values, and the decode step narrates the guess. */
  byteOrder: 'little' | 'big';
  /** Whether the `byte_order` entry was actually present in the metadata. */
  byteOrderRecorded: boolean;
  /** Read plan Task 3: whether the `codec_pipelines` key was present in
   * metadata at all. When false, the reader proceeds via assume-identity
   * (empty pipelines) — `decode-chunks`' step detail distinguishes "no
   * codec info — none was needed" (honest) from "assumed raw bytes"
   * (codecs WERE applied at write time but the reader can't know that). */
  codecInfoPresent: boolean;
}

/**
 * Read a set of virtual files produced by the Write step and attempt
 * to reconstruct the original dataset values.
 *
 * Three stages: locate the metadata entries (sidecar/trailer/header/footer,
 * each with its own failure semantics), parse them into a typed dataset
 * structure, then reconstruct values from chunks. Reassembly (task 2.1) uses
 * `chunk_index` coords as the single source of truth for where each chunk's
 * elements land in the global row-major array — no filename-number sort, no
 * raw-offset fallback.
 */
export function readFile(
  files: VirtualFile[],
  formatSpec: ReadFormatSpec,
): ReadFileResult {
  const magicBytes = formatSpec.magic;
  const dataFiles = files.filter((f) => f.name !== 'metadata');
  const recorder = createStepRecorder();

  if (dataFiles.length === 0) {
    return makeFailure('no-metadata', 0, recorder, 'verify-magic', 'no data files');
  }

  // D2: the reader knows the format's magic number and verifies it, rather
  // than blindly stripping `magic.length` bytes from each end. Zero-length
  // magic means there is nothing to verify.
  if (magicBytes.length > 0) {
    for (const file of dataFiles) {
      if (!verifyMagic(file.bytes, magicBytes)) {
        const found = describeMagicMismatch(file.bytes, magicBytes);
        return makeFailure('bad-magic', totalBytes(dataFiles), recorder, 'verify-magic', found);
      }
    }
    recorder.ok('verify-magic', `leading/trailing bytes match expected magic (${magicBytes.length} bytes)`);
  } else {
    recorder.ok('verify-magic', 'zero-length magic — nothing to verify');
  }

  const located = locateMetadata(files, dataFiles, magicBytes);
  if (!located.entries) {
    return makeFailure(located.reason, totalBytes(dataFiles), recorder, 'locate-metadata', located.found);
  }
  recorder.ok('locate-metadata', located.found);

  let structure: ParsedStructure;
  try {
    structure = parseStructure(located.entries);
  } catch (err) {
    // Read plan Task 3: schema/layout presence checks are split out of
    // parseStructure's single combined throw — a genuinely missing `schema`
    // or `shape`/`chunk_shape` key gets its own reason and step, distinct
    // from a present-but-malformed key (which still falls through to the
    // generic corrupt-metadata branch below).
    if (err instanceof MissingSchemaError) {
      recorder.ok('parse-metadata', `${located.entries.length} entries parsed`);
      return makeFailure(
        'missing-schema',
        totalBytes(dataFiles),
        recorder,
        'read-schema',
        'metadata parsed, but no "schema" entry describing variables/types',
        describeError(err),
      );
    }
    if (err instanceof MissingLayoutError) {
      recorder.ok('parse-metadata', `${located.entries.length} entries parsed`);
      recorder.ok('read-schema', `${located.entries.length} entries parsed, schema present`);
      return makeFailure(
        'missing-layout',
        totalBytes(dataFiles),
        recorder,
        'read-layout',
        'metadata parsed, but no "shape"/"chunk_shape" entries describing the dataset geometry',
        describeError(err),
      );
    }
    // Metadata was located and parsed as entries, but a field's JSON didn't
    // parse into the shape the reader expects — located-but-unusable is
    // corrupt, not absent.
    return makeFailure(
      'corrupt-metadata',
      totalBytes(dataFiles),
      recorder,
      'parse-metadata',
      'entries located but did not parse into a dataset structure',
      describeError(err),
    );
  }
  recorder.ok('parse-metadata', `${located.entries.length} entries parsed`);
  recorder.ok('read-schema', describeSchemaFound(structure, located.entries));
  recorder.ok('read-layout', `shape [${structure.shape.join(',')}], chunk shape [${structure.chunkShape.join(',')}], ${structure.interleaving} interleaving`);

  try {
    return reconstruct(structure, dataFiles, magicBytes, located.chunkDataStart, recorder);
  } catch (err) {
    // D3: chunk_index was omitted and at least one codec pipeline in play is
    // size-changing, so chunk offsets can't be computed -> its own failure
    // reason with the why-indexes-exist lesson, not the generic decode-error.
    if (err instanceof NoChunkIndexError) {
      return makeFailure('no-chunk-index', totalBytes(dataFiles), recorder, 'locate-chunks', 'chunk_index absent, cannot compute');
    }
    // Codec reversal / deinterleave / reassembly threw after metadata was
    // successfully found and parsed -> decode-error, with the real
    // exception text preserved in the message for debugging. The recorder
    // doesn't know which of decode-chunks/reassemble was in progress when an
    // arbitrary reconstruction error is thrown, so attribute it to
    // decode-chunks — the far more common failure point (a bad codec
    // reversal or dtype mismatch) — rather than guess from the exception.
    return makeFailure('decode-error', totalBytes(dataFiles), recorder, 'decode-chunks', 'reconstruction failed', describeError(err));
  }
}

/** Parse located metadata entries into a typed dataset structure.
 *
 * Presence checks are split by group, checked in reader-step order (read plan
 * Task 3): schema (`schema` key) first, then layout (`shape`/`chunk_shape`)
 * — throwing typed `MissingSchemaError`/`MissingLayoutError` respectively, so
 * `readFile` can attribute the failure to the right step. `type_assignments`
 * and `logical_types` are schema-group per `METADATA_KEY_GROUPS`
 * (metadata.ts) but are optional even when schema IS present (a variable's
 * dtype lives in `schema` itself) — they are not gated here. `interleaving`
 * is layout-group but already defaults to 'column' when absent and keeps
 * that default; it isn't a presence-check trigger.
 *
 * Once both groups are confirmed present, malformed JSON in any key throws a
 * plain `Error`; the caller maps that to 'corrupt-metadata' — located-and-
 * present-but-unusable is corrupt, not absent. */
export function parseStructure(metadataEntries: MetadataEntry[]): ParsedStructure {
  const metaMap = new Map(metadataEntries.map((e) => [e.key, e.value]));

  const schemaStr = metaMap.get('schema');
  if (!schemaStr) {
    throw new MissingSchemaError('metadata is missing the schema (no "schema" key)');
  }

  const shapeStr = metaMap.get('shape');
  const chunkShapeStr = metaMap.get('chunk_shape');
  if (!shapeStr || !chunkShapeStr) {
    throw new MissingLayoutError('metadata is missing layout fields (shape, chunk_shape)');
  }

  const interleavingStr = metaMap.get('interleaving') ?? 'column';
  // cl-6: absent key (old files, or 1-D/identity cases) => 'c'. Guard against a
  // hand-edited/unknown value falling through as a bogus order string.
  const linearizationStr = metaMap.get('linearization');
  const linearization: LinearizationOrder =
    linearizationStr && (LINEARIZATION_ORDERS as string[]).includes(linearizationStr)
      ? (linearizationStr as LinearizationOrder)
      : 'c';
  // Same allow-list guard pattern as linearization above: absent or unknown
  // value falls back to the default rather than propagating a bogus string.
  const partitioningStr = metaMap.get('partitioning');
  const partitioningRecorded = partitioningStr === 'single' || partitioningStr === 'per-chunk';
  const partitioning: 'single' | 'per-chunk' = partitioningRecorded ? partitioningStr : 'single';
  const chunkOrderStr = metaMap.get('chunk_order');
  const chunkOrder: 'row-major' | 'column-major' =
    chunkOrderStr === 'row-major' || chunkOrderStr === 'column-major'
      ? chunkOrderStr
      : 'row-major';
  const byteOrderStr = metaMap.get('byte_order');
  const byteOrderRecorded = byteOrderStr === 'little' || byteOrderStr === 'big';
  const byteOrder: 'little' | 'big' = byteOrderRecorded
    ? (byteOrderStr as 'little' | 'big')
    : hostByteOrder();

  const codecPipelinesStr = metaMap.get('codec_pipelines');
  const chunkIndexStr = metaMap.get('chunk_index');
  const typeAssignmentsStr = metaMap.get('type_assignments');
  const variableStatisticsStr = metaMap.get('variable_statistics');

  const shape: number[] = JSON.parse(shapeStr);
  let fieldPipelines: Record<string, CodecStep[]> | null = null;
  let chunkPipeline: CodecStep[] | null = null;

  if (codecPipelinesStr) {
    const parsed = JSON.parse(codecPipelinesStr);
    if (Array.isArray(parsed)) {
      chunkPipeline = parsed;
    } else {
      fieldPipelines = parsed;
    }
  }

  return {
    schema: JSON.parse(schemaStr),
    shape,
    chunkShape: JSON.parse(chunkShapeStr),
    interleaving: interleavingStr as 'row' | 'column',
    linearization,
    partitioning,
    partitioningRecorded,
    chunkOrder,
    fieldPipelines,
    chunkPipeline,
    chunkIndex: chunkIndexStr ? JSON.parse(chunkIndexStr) : null,
    typeAssignments: typeAssignmentsStr ? JSON.parse(typeAssignmentsStr) : null,
    variableStatistics: variableStatisticsStr ? JSON.parse(variableStatisticsStr) : null,
    totalElements: shape.reduce((a, b) => a * b, 1),
    codecInfoPresent: codecPipelinesStr !== undefined,
    byteOrder,
    byteOrderRecorded,
  };
}

/** Read plan Task 3: read-schema step's `found` text. When descriptive
 * metadata (`variable_statistics` + custom entries) is absent, says so
 * explicitly — the structural-vs-descriptive lesson: the reader read the
 * schema just fine without it, because descriptive content was never needed
 * to interpret bytes, only to help a human understand values. `metadata_format`
 * and `byte_order` are the only other non-schema/layout/codec/chunk-index
 * keys (envelope, always present), so anything else present alongside schema
 * counts as descriptive content having been included. */
export function describeSchemaFound(structure: ParsedStructure, entries: MetadataEntry[]): string {
  const base = `${structure.schema.length} variable(s): ${structure.schema.map((s) => s.name).join(', ')}`;
  const knownKeys = new Set([...Object.keys(METADATA_KEY_GROUPS), 'metadata_format', 'byte_order']);
  const hasDescriptive = entries.some((e) => e.key === 'variable_statistics' || !knownKeys.has(e.key));
  if (hasDescriptive) return base;
  return `${base} (statistics and custom entries were absent — not needed to read the schema)`;
}

/** Resolve the chunk index, reconstruct all variables' values from their
 * chunks, reverse type assignment, and compute lossy variables. Throws
 * `NoChunkIndexError` or a decode error; caller maps those to failure
 * reasons. */
export function reconstruct(
  structure: ParsedStructure,
  dataFiles: VirtualFile[],
  magicBytes: Uint8Array,
  chunkDataStart: number,
  recorder: StepRecorder,
): ReadFileResult {
  const { schema, shape, chunkShape, interleaving, linearization, fieldPipelines, chunkPipeline, typeAssignments, variableStatistics, totalElements, codecInfoPresent, byteOrder, byteOrderRecorded } = structure;

  const typeAssignLossy = new Set<string>();
  if (variableStatistics) {
    for (const [varName, stats] of Object.entries(variableStatistics)) {
      if (stats.isLossy) {
        typeAssignLossy.add(varName);
      }
    }
  }

  // Task 2.6 (surfacing half): codec lossiness. dtype flow comes from the
  // metadata's codec specs: each variable's pipeline starts at its storage
  // dtype (from `schema`) and each reordering step preserves dtype while
  // each entropy step's *output* becomes uint8 for the next step's input —
  // but lossiness is evaluated on each step's own *input* dtype, so we only
  // need to track dtype forward through the chain, not the reversal.
  const codecLossyVariables = computeCodecLossyVariables(
    schema,
    interleaving,
    fieldPipelines,
    chunkPipeline,
  );

  // D3: chunk_index may be absent (metadata.includeChunkIndex=false).
  // Compute it from chunkShape x dtype size when every codec pipeline in
  // play is size-preserving; throws NoChunkIndexError otherwise.
  const resolvedChunkIndex = resolveChunkIndex(
    structure.chunkIndex,
    { schema, shape, chunkShape, interleaving, fieldPipelines, chunkPipeline, partitioning: structure.partitioning, chunkOrder: structure.chunkOrder },
    magicBytes.length + chunkDataStart,
  );
  recorder.ok('locate-chunks', `${resolvedChunkIndex.length} chunk(s) located`);

  const context: ReassemblyContext = {
    schema,
    shape,
    chunkShape,
    interleaving,
    linearization,
    fieldPipelines,
    chunkPipeline,
    chunkIndex: resolvedChunkIndex,
    totalElements,
    codecInfoPresent,
    byteOrder,
  };

  // Reader selection by recorded partitioning; when the `partitioning` key
  // was absent (old files), fall back to the pre-Task-5 file-count heuristic.
  const perChunk = structure.partitioningRecorded
    ? structure.partitioning === 'per-chunk'
    : dataFiles.length > 1;
  const getChunkBytes = perChunk
    ? makePerChunkFileReader(dataFiles, magicBytes)
    : makeSingleFileChunkReader(dataFiles[0].bytes);
  const reconstructedValues = reconstructValues(context, getChunkBytes);
  recorder.ok(
    'decode-chunks',
    `${schema.length} variable(s) decoded through their codec pipeline(s)`,
    describeDecodeDetail(codecInfoPresent, byteOrderRecorded, byteOrder),
  );

  if (typeAssignments) {
    for (const [varName, assignment] of Object.entries(typeAssignments)) {
      const values = reconstructedValues.get(varName);
      if (!values) continue;
      reconstructedValues.set(varName, reverseTypeAssignmentValues(values, assignment, byteOrder));
    }
  }
  recorder.ok('reassemble', `${totalElements} element(s) reassembled per variable`);

  return {
    success: true,
    reconstructedValues,
    lossyVariables: new Set<string>([...typeAssignLossy, ...codecLossyVariables]),
    steps: recorder.finish(),
  };
}

/** Read plan Task 3 §3: decode-chunks step detail for the assume-identity
 * path (`codec_pipelines` absent from metadata). The reader genuinely cannot
 * tell, from parsed metadata alone, whether that means "no codecs were ever
 * applied" (honest — the empty pipeline it assumes IS correct) or "codecs
 * WERE applied at write time but their record was omitted" (the pipeline it
 * assumes is wrong, and reconstructed values will be garbled for anything
 * beyond identity) — both look identical from inside `reconstruct`: an
 * absent `codec_pipelines` key either way. One honest detail string covers
 * both readings rather than claiming certainty the reader doesn't have; the
 * size-changing sub-case never reaches this text at all (caught earlier, as
 * a genuine decode-error, by the byte-count check in `reconstructValues`).
 * When codec info WAS present, no extra detail is needed — the step's plain
 * `found` text already says the pipeline was used.
 *
 * The endianness mini-lesson (spec §3b, risk 5) is orthogonal and additive:
 * when the `byte_order` entry was ABSENT, the reader silently assumed the host
 * order and decoded anyway (no failure, no lossy mark) — a big-endian file
 * written with the entry omitted reads successfully with garbled values. That
 * assumption is narrated here so the Read-process view can show the guess the
 * diff view then exposes as corruption. */
function describeDecodeDetail(
  codecInfoPresent: boolean,
  byteOrderRecorded: boolean,
  byteOrder: 'little' | 'big',
): string | undefined {
  const codecDetail = codecInfoPresent
    ? undefined
    : 'no codec info — assumed raw bytes (honest if none were applied at write time; garbled if they were)';
  const endianDetail = byteOrderRecorded
    ? undefined
    : `byte order not recorded — assuming host (${byteOrder}-endian)`;
  return [codecDetail, endianDetail].filter(Boolean).join('; ') || undefined;
}

export function totalBytes(dataFiles: VirtualFile[]): number {
  return dataFiles.reduce((sum, f) => sum + f.bytes.length, 0);
}

/**
 * Determine which variables have a lossy codec somewhere in their pipeline,
 * from the metadata's codec specs alone (the reader only has the file's
 * metadata to go on, not app config). Column mode: each variable has its own
 * field pipeline, starting at its storage dtype. Row mode: one shared chunk
 * pipeline — if ANY step is lossy for the row-mode input dtype, that
 * lossiness applies to every variable (no way to isolate one variable's
 * contribution to a shared, interleaved pipeline).
 */
export function computeCodecLossyVariables(
  schema: SchemaEntry[],
  interleaving: 'row' | 'column',
  fieldPipelines: Record<string, CodecStep[]> | null,
  chunkPipeline: CodecStep[] | null,
): Set<string> {
  const lossy = new Set<string>();

  if (interleaving === 'column') {
    for (const varInfo of schema) {
      const steps = fieldPipelines?.[varInfo.name] ?? [];
      if (isPipelineLossy(steps, varInfo.dtype)) {
        lossy.add(varInfo.name);
      }
    }
  } else {
    const steps = chunkPipeline ?? [];
    const inputDtype = rowModeInputDtype(schema);
    if (isPipelineLossy(steps, inputDtype)) {
      for (const varInfo of schema) {
        lossy.add(varInfo.name);
      }
    }
  }

  return lossy;
}

/** Walk a codec pipeline's dtype flow forward, checking each step's own input dtype for lossiness. */
export function isPipelineLossy(steps: CodecStep[], startDtype: DtypeKey): boolean {
  let currentDtype: DtypeKey = startDtype;
  for (const step of steps) {
    const codec = CODEC_REGISTRY[step.codec];
    if (!codec) continue;
    if (codec.isLossy(currentDtype)) {
      return true;
    }
    currentDtype = outputDtypeFor(codec, currentDtype, step.params);
  }
  return false;
}
