import type { VirtualFile, ReadFileResult, ReadFailureReason } from '../types/pipeline.ts';
import type { DtypeKey, LogicalValue } from '../types/dtypes.ts';
import type { CodecStep } from '../types/codecs.ts';
import type { TypeAssignment } from '../types/state.ts';
import { getDtype, isCharDtype } from '../types/dtypes.ts';
import { bytesToValues, valuesToBytes } from './elements.ts';
import {
  deserializeMetadata,
  serializeMetadataBinary,
  type MetadataEntry,
  type ChunkIndexEntry,
} from './metadata.ts';
import { reverseCodecPipeline } from './decode.ts';
import { reverseTypeAssignment } from './typeAssign.ts';
import { CODEC_REGISTRY } from './codecs.ts';
import { flatIndexToCoords, coordsToFlatIndex, computeChunkGrid, enumerateChunkCoords } from './chunk.ts';

/** D3: thrown by `resolveChunkIndex` when `chunk_index` is absent from
 * metadata AND at least one codec pipeline in play is size-changing, so
 * encoded chunk sizes can't be derived from chunkShape x dtype size alone.
 * Mapped by `readFile` to failure reason 'no-chunk-index'. */
class NoChunkIndexError extends Error {}

interface VariableStatsLike {
  isLossy: boolean;
}

type SchemaEntry = { name: string; dtype: DtypeKey };

/** Format specification the reader was "built for" (D2) — analogous to a
 * Parquet reader knowing `PAR1` or a TIFF reader knowing `II*\0`. The reader
 * verifies the magic rather than blindly stripping it. */
export interface ReadFormatSpec {
  magic: Uint8Array;
}

/** Parsed dataset structure recovered from metadata entries — everything
 * `reconstruct` needs to reassemble values, independent of how or where the
 * entries were located. */
interface ParsedStructure {
  schema: SchemaEntry[];
  shape: number[];
  chunkShape: number[];
  interleaving: 'row' | 'column';
  fieldPipelines: Record<string, CodecStep[]> | null;
  chunkPipeline: CodecStep[] | null;
  chunkIndex: ChunkIndexEntry[] | null;
  typeAssignments: Record<string, TypeAssignment> | null;
  variableStatistics: Record<string, VariableStatsLike> | null;
  totalElements: number;
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

  if (dataFiles.length === 0) {
    return makeFailure('no-metadata', 0);
  }

  // D2: the reader knows the format's magic number and verifies it, rather
  // than blindly stripping `magic.length` bytes from each end. Zero-length
  // magic means there is nothing to verify.
  if (magicBytes.length > 0) {
    for (const file of dataFiles) {
      if (!verifyMagic(file.bytes, magicBytes)) {
        return makeFailure('bad-magic', totalBytes(dataFiles));
      }
    }
  }

  const located = locateMetadata(files, dataFiles, magicBytes);
  if (!located.entries) {
    return makeFailure(located.reason, totalBytes(dataFiles));
  }

  let structure: ParsedStructure;
  try {
    structure = parseStructure(located.entries);
  } catch (err) {
    // Metadata was located and parsed as entries, but the entries don't
    // describe a dataset (missing fields), or a field's JSON didn't parse
    // into the shape the reader expects — located-but-unusable is corrupt,
    // not absent.
    return makeFailure('corrupt-metadata', totalBytes(dataFiles), describeError(err));
  }

  try {
    return reconstruct(structure, dataFiles, magicBytes, located.chunkDataStart);
  } catch (err) {
    // D3: chunk_index was omitted and at least one codec pipeline in play is
    // size-changing, so chunk offsets can't be computed -> its own failure
    // reason with the why-indexes-exist lesson, not the generic decode-error.
    if (err instanceof NoChunkIndexError) {
      return makeFailure('no-chunk-index', totalBytes(dataFiles));
    }
    // Codec reversal / deinterleave / reassembly threw after metadata was
    // successfully found and parsed -> decode-error, with the real
    // exception text preserved in the message for debugging.
    return makeFailure('decode-error', totalBytes(dataFiles), describeError(err));
  }
}

type LocateResult =
  | { entries: MetadataEntry[]; chunkDataStart: number }
  | { entries: null; reason: ReadFailureReason };

/**
 * Locate metadata entries: sidecar file first, then embedded (single-file
 * mode only) via trailer, header, or footer scan. `chunkDataStart` (D3) is
 * the byte offset where chunk data starts within a single data file, past
 * the leading magic and (header placement only) the header metadata itself
 * — 0 for sidecar/footer/trailer placements, which have no header.
 */
function locateMetadata(
  files: VirtualFile[],
  dataFiles: VirtualFile[],
  magicBytes: Uint8Array,
): LocateResult {
  const sidecarFile = files.find((f) => f.name === 'metadata');
  // D1: set when a best-effort scan (trailer probe or backward scan) found
  // *something* structured but couldn't turn it into usable entries — that's
  // 'metadata-not-found' (metadata was written, the locator/scan just failed),
  // as opposed to 'no-metadata' (no evidence metadata was ever written).
  let foundPlausibleButUnparseable = false;

  if (sidecarFile && sidecarFile.bytes.length > 0) {
    try {
      const entries = deserializeMetadata(sidecarFile.bytes);
      if (entries.length > 0) return { entries, chunkDataStart: 0 };
      return { entries: null, reason: 'no-metadata' };
    } catch {
      // Sidecar bytes existed but failed to parse as metadata at all -> the
      // metadata is corrupt, not absent.
      return { entries: null, reason: 'corrupt-metadata' };
    }
  }

  if (dataFiles.length === 1) {
    const dataBytes = stripMagic(dataFiles[0].bytes, magicBytes);

    // D1 trailer path: try this first, unconditionally — it's self-describing
    // (a valid trailer is recognizable by construction: last 4 bytes-before-
    // magic decode to a length that exactly reaches a parseable metadata
    // blob) and works identically for JSON and binary. Only footer-placement
    // with footerLocator='trailer' ever produces one, but the reader doesn't
    // (and per D2 shouldn't need to) know the write-side config — it just
    // looks for the trailer shape.
    const trailerResult = tryParseTrailerMetadata(dataBytes);
    if (trailerResult.entries) return { entries: trailerResult.entries, chunkDataStart: 0 };
    if (trailerResult.plausible) foundPlausibleButUnparseable = true;

    const headerResult = tryParseEmbeddedMetadata(dataBytes, 'header');
    if (headerResult.entries) {
      return { entries: headerResult.entries, chunkDataStart: headerResult.headerByteLength ?? 0 };
    }
    if (headerResult.plausible) foundPlausibleButUnparseable = true;

    const footerResult = tryParseEmbeddedMetadata(dataBytes, 'footer');
    if (footerResult.entries) return { entries: footerResult.entries, chunkDataStart: 0 };
    if (footerResult.plausible) foundPlausibleButUnparseable = true;
  }

  // D1: a best-effort scan found plausible-but-unparseable structure ->
  // metadata was written but the locator/scanner couldn't pin it down
  // exactly (the intended lesson for footerLocator='none'). Otherwise there
  // is no evidence metadata was ever written (includeMetadata=false).
  return { entries: null, reason: foundPlausibleButUnparseable ? 'metadata-not-found' : 'no-metadata' };
}

/** Parse located metadata entries into a typed dataset structure. Throws on
 * missing required fields or malformed JSON; caller maps that to
 * 'corrupt-metadata'. */
function parseStructure(metadataEntries: MetadataEntry[]): ParsedStructure {
  const metaMap = new Map(metadataEntries.map((e) => [e.key, e.value]));

  const schemaStr = metaMap.get('schema');
  const shapeStr = metaMap.get('shape');
  const chunkShapeStr = metaMap.get('chunk_shape');
  const interleavingStr = metaMap.get('interleaving') ?? 'column';
  const codecPipelinesStr = metaMap.get('codec_pipelines');
  const chunkIndexStr = metaMap.get('chunk_index');
  const typeAssignmentsStr = metaMap.get('type_assignments');
  const variableStatisticsStr = metaMap.get('variable_statistics');

  if (!schemaStr || !shapeStr || !chunkShapeStr) {
    throw new Error('metadata is missing required fields (schema, shape, chunk_shape)');
  }

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
    fieldPipelines,
    chunkPipeline,
    chunkIndex: chunkIndexStr ? JSON.parse(chunkIndexStr) : null,
    typeAssignments: typeAssignmentsStr ? JSON.parse(typeAssignmentsStr) : null,
    variableStatistics: variableStatisticsStr ? JSON.parse(variableStatisticsStr) : null,
    totalElements: shape.reduce((a, b) => a * b, 1),
  };
}

/** Resolve the chunk index, reconstruct all variables' values from their
 * chunks, reverse type assignment, and compute lossy variables. Throws
 * `NoChunkIndexError` or a decode error; caller maps those to failure
 * reasons. */
function reconstruct(
  structure: ParsedStructure,
  dataFiles: VirtualFile[],
  magicBytes: Uint8Array,
  chunkDataStart: number,
): ReadFileResult {
  const { schema, shape, chunkShape, interleaving, fieldPipelines, chunkPipeline, typeAssignments, variableStatistics, totalElements } = structure;

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
    { schema, shape, chunkShape, interleaving, fieldPipelines, chunkPipeline },
    magicBytes.length + chunkDataStart,
  );

  const context: ReassemblyContext = {
    schema,
    shape,
    chunkShape,
    interleaving,
    fieldPipelines,
    chunkPipeline,
    chunkIndex: resolvedChunkIndex,
    totalElements,
  };

  const getChunkBytes = dataFiles.length === 1
    ? makeSingleFileChunkReader(dataFiles[0].bytes)
    : makePerChunkFileReader(dataFiles, magicBytes);
  const reconstructedValues = reconstructValues(context, getChunkBytes);

  if (typeAssignments) {
    for (const [varName, assignment] of Object.entries(typeAssignments)) {
      const values = reconstructedValues.get(varName);
      if (!values) continue;
      reconstructedValues.set(varName, reverseTypeAssignmentValues(values, assignment));
    }
  }

  return {
    success: true,
    reconstructedValues,
    lossyVariables: new Set<string>([...typeAssignLossy, ...codecLossyVariables]),
  };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function totalBytes(dataFiles: VirtualFile[]): number {
  return dataFiles.reduce((sum, f) => sum + f.bytes.length, 0);
}

const FAILURE_MESSAGES: Record<ReadFailureReason, (byteCount: number, detail?: string) => string> = {
  'no-metadata': (byteCount) =>
    `Cannot read file.\n\n` +
    `The file contains ${byteCount} bytes of data but no metadata describing how to interpret them. ` +
    `A reader needs to know: the variable names and types, the data shape, how the data was chunked ` +
    `and interleaved, and what codecs were applied — in order to reverse the encoding and reconstruct values.\n\n` +
    `Enable "Include metadata" in the Write step to make this file self-describing.`,
  'metadata-not-found': (byteCount) =>
    `Cannot read file.\n\n` +
    `The file contains ${byteCount} bytes of data and metadata was written, but this reader's best-effort ` +
    `scan could not locate it. Without a length trailer, a scanner has to guess where structured metadata ` +
    `starts and ends — real formats avoid this by recording an exact length (Parquet ends every file with ` +
    `[footer][4-byte length]['PAR1']).\n\n` +
    `Set the Footer locator to "trailer" so the reader can seek directly to the metadata instead of scanning for it.`,
  'bad-magic': (byteCount) =>
    `Cannot read file.\n\n` +
    `The file's leading bytes (of ${byteCount} total) do not match the expected magic number. ` +
    `This reader only understands files it was built for — exactly as a Parquet reader expects "PAR1" or a ` +
    `TIFF reader expects "II*\\0". A magic-number mismatch means either this isn't the right kind of file, ` +
    `or it was corrupted before the reader ever got to interpret its contents.`,
  'corrupt-metadata': (byteCount, detail) =>
    `Cannot read file.\n\n` +
    `Metadata was located within the ${byteCount} bytes of file data, but it could not be parsed into a ` +
    `usable description of the dataset (missing fields, or malformed JSON/binary structure).` +
    (detail ? ` Underlying error: ${detail}` : '') +
    `\n\nA reader that finds metadata but can't trust its contents has to fail rather than guess at the ` +
    `data's layout.`,
  'no-chunk-index': (byteCount) =>
    `Cannot read file.\n\n` +
    `The file contains ${byteCount} bytes of data using one or more size-changing codecs (e.g. RLE, LZ), ` +
    `so encoded chunk sizes can't be computed from chunk shape and dtype alone — and nothing in the file ` +
    `records where each chunk actually starts.\n\n` +
    `Re-enable the chunk index, or remove the size-changing codecs from the pipeline. This is exactly why ` +
    `real chunked/columnar formats (Zarr, Parquet) always carry an index: variable-size compressed chunks ` +
    `are unlocatable without one.`,
  'decode-error': (byteCount, detail) =>
    `Cannot read file.\n\n` +
    `Metadata for the ${byteCount} bytes of file data was found and parsed successfully, but reconstructing ` +
    `values from it failed while reversing codecs, deinterleaving, or reassembling chunks.` +
    (detail ? ` Underlying error: ${detail}` : '') +
    `\n\nThis usually means the encoded bytes don't actually match what the metadata claims about them ` +
    `(wrong dtype, wrong chunk geometry, or a codec that isn't a true inverse of its encode step).`,
};

function makeFailure(reason: ReadFailureReason, byteCount: number, detail?: string): ReadFileResult {
  return {
    success: false,
    reason,
    message: FAILURE_MESSAGES[reason](byteCount, detail),
    byteCount,
  };
}

/** Verify a file's leading and trailing magic bytes (write.ts always ends a
 * file with the same magic it started with). Never strips bytes, only checks. */
function verifyMagic(fileBytes: Uint8Array, magic: Uint8Array): boolean {
  if (magic.length === 0) return true;
  if (fileBytes.length < magic.length * 2) return false;
  for (let i = 0; i < magic.length; i++) {
    if (fileBytes[i] !== magic[i]) return false;
  }
  const end = fileBytes.length - magic.length;
  for (let i = 0; i < magic.length; i++) {
    if (fileBytes[end + i] !== magic[i]) return false;
  }
  return true;
}

/** Strip leading/trailing magic bytes. Only called after `verifyMagic` has
 * confirmed the magic actually matches. */
function stripMagic(fileBytes: Uint8Array, magic: Uint8Array): Uint8Array {
  if (magic.length === 0) return fileBytes;
  const start = magic.length;
  const end = fileBytes.length - magic.length;
  if (end <= start) return new Uint8Array(0);
  return fileBytes.slice(start, end);
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
function computeCodecLossyVariables(
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
function isPipelineLossy(steps: CodecStep[], startDtype: DtypeKey): boolean {
  let currentDtype: DtypeKey = startDtype;
  for (const step of steps) {
    const codec = CODEC_REGISTRY[step.codec];
    if (!codec) continue;
    if (codec.isLossy(currentDtype)) {
      return true;
    }
    // Dtype flow: reordering codecs preserve dtype, entropy codecs output uint8.
    currentDtype = codec.category === 'entropy' ? 'uint8' : currentDtype;
  }
  return false;
}

/** Result of a best-effort metadata scan: either usable entries, or a signal
 * that *something* structured was spotted but couldn't be turned into
 * entries (D1: distinguishes 'metadata-not-found' from 'no-metadata').
 * `headerByteLength` (HEADER-position finds only) is the byte length the
 * located metadata occupied at the start of `dataBytes`, needed when there's
 * no chunk_index to read a real chunk-data-start offset from. */
interface ScanResult {
  entries: MetadataEntry[] | null;
  plausible: boolean;
  headerByteLength?: number;
}

const NOT_FOUND: ScanResult = { entries: null, plausible: false };

/**
 * D1/D4: best-effort embedded-metadata scan, used as the `footerLocator='none'`
 * fallback (and symmetrically for header placement, which has always been
 * locator-free since the header's own start is unambiguous). Deliberately
 * best-effort and kept honest — string-literal-aware JSON brace scan plus a
 * bounded binary plausibility scan, and stops there. No further heuristics.
 */
function tryParseEmbeddedMetadata(
  dataBytes: Uint8Array,
  position: 'header' | 'footer',
): ScanResult {
  if (dataBytes.length === 0) return NOT_FOUND;

  try {
    if (position === 'header') {
      if (dataBytes[0] === 0x7b) {
        const text = new TextDecoder().decode(dataBytes);
        const endIdx = findJsonObjectEnd(text, 0);
        if (endIdx > 0) {
          const jsonBytes = new TextEncoder().encode(text.slice(0, endIdx));
          try {
            const entries = deserializeMetadata(jsonBytes);
            if (entries.length > 0) return { entries, plausible: true, headerByteLength: jsonBytes.length };
          } catch {
            return { entries: null, plausible: true };
          }
        }
        return { entries: null, plausible: true };
      }
      return scanBinaryForward(dataBytes, 0);
    } else {
      if (dataBytes[dataBytes.length - 1] === 0x7d) {
        const text = new TextDecoder().decode(dataBytes);
        const lastBrace = text.lastIndexOf('}');
        const startIdx = lastBrace >= 0 ? findJsonObjectStart(text, lastBrace) : -1;
        if (startIdx >= 0) {
          const jsonStr = text.slice(startIdx, lastBrace + 1);
          const jsonBytes = new TextEncoder().encode(jsonStr);
          try {
            const entries = deserializeMetadata(jsonBytes);
            if (entries.length > 0) return { entries, plausible: true };
          } catch {
            return { entries: null, plausible: true };
          }
        }
        return { entries: null, plausible: false };
      }
      return scanBinaryBackward(dataBytes);
    }
  } catch {
    return NOT_FOUND;
  }
}

/**
 * D1 trailer layout: [magic][chunks][metadata][u32 LE metadata-length][magic].
 * `dataBytes` has its outer magic already stripped, so a trailer — if present
 * — occupies its last 4 bytes (the length). Self-describing: a real trailer
 * is recognized by the length actually reaching back to a byte offset that
 * parses as metadata; this essentially never fires for files without one.
 */
function tryParseTrailerMetadata(dataBytes: Uint8Array): ScanResult {
  if (dataBytes.length < 4) return NOT_FOUND;
  const view = new DataView(dataBytes.buffer, dataBytes.byteOffset, dataBytes.byteLength);
  const len = view.getUint32(dataBytes.length - 4, true);
  if (len <= 0 || len > dataBytes.length - 4) return NOT_FOUND;
  const metaStart = dataBytes.length - 4 - len;
  const metaBytes = dataBytes.slice(metaStart, dataBytes.length - 4);
  try {
    const entries = deserializeMetadata(metaBytes);
    if (entries.length > 0) return { entries, plausible: true };
  } catch {
    // A 4-byte trailer-length read is a coincidence of ordinary chunk data
    // often enough that a parse failure alone isn't "plausible" — only report
    // plausible when the byte before the length also looks like a metadata
    // terminator ('}' for JSON, or a trailer-consistent binary frame).
    if (metaBytes.length > 0 && (metaBytes[metaBytes.length - 1] === 0x7d || looksLikeBinaryMetadataHeader(metaBytes))) {
      return { entries: null, plausible: true };
    }
  }
  return NOT_FOUND;
}

function looksLikeBinaryMetadataHeader(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  return count > 0 && count < 1000;
}

/**
 * Binary "entry-count plausibility scan", forward direction (header
 * placement — binary metadata always starts with its 4-byte entry count, so
 * this is a direct attempt, not really a scan; "plausible" means a small
 * positive count that also parses).
 */
function scanBinaryForward(dataBytes: Uint8Array, start: number): ScanResult {
  if (dataBytes.length - start < 4) return NOT_FOUND;
  const view = new DataView(dataBytes.buffer, dataBytes.byteOffset, dataBytes.byteLength);
  const count = view.getUint32(start, true);
  if (count <= 0 || count >= 1000) return NOT_FOUND;
  try {
    const entries = deserializeMetadata(dataBytes.slice(start));
    if (entries.length > 0) {
      // Binary framing has no terminator either — re-serialize to learn how
      // many bytes the header metadata actually occupied, since there's no
      // chunk_index to read a real chunk-data-start offset from otherwise.
      const headerByteLength = start + serializeMetadataBinary(entries).length;
      return { entries, plausible: true, headerByteLength };
    }
    return { entries: null, plausible: true };
  } catch {
    return { entries: null, plausible: true };
  }
}

/**
 * D1: binary "entry-count plausibility scan", backward direction (footer
 * placement with `footerLocator='none'` — no trailer/index to consult). This
 * is the deliberate failure case D1 calls out: binary metadata has no
 * self-describing terminator the way JSON has a closing `}`, so there is no
 * honest way to pin down where it *starts* by inspecting bytes alone — that's
 * the lesson, not a bug. Checks only a small bounded window near the end for
 * an entry-count-shaped value and never treats a match as a real find; it
 * just reports plausibility, distinguishing 'metadata-not-found' from
 * 'no-metadata'.
 */
const BINARY_PLAUSIBILITY_WINDOW = 64;

function scanBinaryBackward(dataBytes: Uint8Array): ScanResult {
  if (dataBytes.length < 4) return NOT_FOUND;
  const view = new DataView(dataBytes.buffer, dataBytes.byteOffset, dataBytes.byteLength);
  const lo = Math.max(0, dataBytes.length - BINARY_PLAUSIBILITY_WINDOW);
  for (let start = dataBytes.length - 4; start >= lo; start--) {
    const count = view.getUint32(start, true);
    if (count > 0 && count < 1000) {
      return { entries: null, plausible: true };
    }
  }
  return NOT_FOUND;
}

/** Find the index just past the closing `}` of the JSON object starting at
 * `startIdx`, tracking string-literal/escape state so unescaped `{`/`}`
 * *inside* string values (task 2.4 / RP-2 — e.g. a custom metadata value like
 * `weird { value`) don't perturb the brace count. Returns -1 if unbalanced. */
function findJsonObjectEnd(text: string, startIdx: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Counterpart of `findJsonObjectEnd`: given the index of a closing `}`,
 * find the matching opening `{`. String-literal-aware for the same reason
 * (RP-2's backward footer scan was equally brace-blind) — but note this
 * scans '{' occurrences FORWARD from the start of `text`, not backward from
 * `endIdx`: a nested value that is itself a JSON-encoded string (e.g.
 * `variable_statistics`'s stringified object) can look like a perfectly
 * balanced top-level span in isolation, since starting a fresh scan at its
 * '{' has no way to know it's really inside an outer string. The true
 * top-level object always starts at or before any such false candidate, so
 * taking the first forward match that lands exactly on `endIdx` is reliable.
 * Returns -1 if unbalanced. */
function findJsonObjectStart(text: string, endIdx: number): number {
  for (let i = 0; i <= endIdx; i++) {
    if (text[i] !== '{') continue;
    const candidateEnd = findJsonObjectEnd(text, i);
    if (candidateEnd === endIdx + 1) {
      return i;
    }
  }
  return -1;
}

// ─── Chunk reassembly ──────────────────────────────────────────────────────

interface ReassemblyContext {
  schema: SchemaEntry[];
  shape: number[];
  chunkShape: number[];
  interleaving: 'row' | 'column';
  fieldPipelines: Record<string, CodecStep[]> | null;
  chunkPipeline: CodecStep[] | null;
  chunkIndex: ChunkIndexEntry[] | null;
  totalElements: number;
}

interface ChunkGeometry {
  /** Global start index per dimension (coords x clamped chunkShape). */
  startIndices: number[];
  /** Clamped per-dimension extent — smaller than chunkShape at ragged edges. */
  extent: number[];
  /** Product of extent (this chunk's own element count). */
  elementCount: number;
}

/** Compute a chunk's geometry at `coords`, matching `chunk.ts`'s
 * `extractChunkValues` — chunks at the ragged edge of a shape that doesn't
 * evenly divide by chunkShape are smaller than chunkShape. */
function chunkGeometry(coords: number[], chunkShape: number[], shape: number[]): ChunkGeometry {
  const clampedChunkShape = chunkShape.map((cs, d) => Math.min(cs, shape[d]));
  const startIndices = coords.map((c, d) => c * clampedChunkShape[d]);
  const extent = startIndices.map((s, d) => Math.min(s + clampedChunkShape[d], shape[d]) - s);
  const elementCount = extent.reduce((acc, e) => acc * e, 1);
  return { startIndices, extent, elementCount };
}

/** Scatter a chunk's decoded, chunk-local row-major values into `target` at
 * their global row-major positions — the exact inverse of `chunk.ts`'s
 * `extractChunkValues`. */
function scatterChunkValues(
  target: LogicalValue[],
  chunkValues: LogicalValue[],
  coords: number[],
  chunkShape: number[],
  shape: number[],
): void {
  const { startIndices, extent, elementCount } = chunkGeometry(coords, chunkShape, shape);

  for (let i = 0; i < elementCount && i < chunkValues.length; i++) {
    const localCoords = flatIndexToCoords(i, extent);
    const globalCoords = localCoords.map((lc, d) => lc + startIndices[d]);
    const globalFlatIndex = coordsToFlatIndex(globalCoords, shape);
    target[globalFlatIndex] = chunkValues[i];
  }
}

/** Resolves a chunk_index entry (optionally scoped to a variable, for column
 * mode) to that chunk's raw encoded bytes. Single-file mode slices by
 * offset/size; per-chunk-file mode looks up the file by name derived from
 * coords/variableName. Either way, chunks are matched to data by coords (and
 * variableName) — never by a shared byte offset across files or filename
 * number-parsing. */
type ChunkBytesReader = (entry: ChunkIndexEntry, variableName?: string) => Uint8Array | null;

function makeSingleFileChunkReader(fileBytes: Uint8Array): ChunkBytesReader {
  return (entry) => fileBytes.slice(entry.offset, entry.offset + entry.size);
}

function makePerChunkFileReader(dataFiles: VirtualFile[], magicBytes: Uint8Array): ChunkBytesReader {
  return (entry, variableName) => {
    const suffix = `chunk_${entry.coords.join('_')}`;
    const expectedName = variableName ? `${variableName}_${suffix}` : suffix;
    const file = dataFiles.find((f) => f.name === expectedName);
    return file ? stripMagic(file.bytes, magicBytes) : null;
  };
}

/**
 * D3: when `chunk_index` is absent from metadata (`includeChunkIndex` off),
 * compute synthetic entries instead — possible only when every codec
 * pipeline in play is size-preserving. Any size-changing (entropy: rle/lz)
 * codec means encoded chunk size can't be derived from chunkShape x dtype
 * size alone, and nothing else records where a chunk starts — throws
 * `NoChunkIndexError`, mapped by the caller to 'no-chunk-index'.
 *
 * Offsets assume chunks are laid out back-to-back in row-major chunk order;
 * column-major `chunkOrder` requires a real index to reassemble.
 */
function resolveChunkIndex(
  chunkIndex: ChunkIndexEntry[] | null,
  ctx: Omit<ReassemblyContext, 'chunkIndex' | 'totalElements'>,
  magicLength: number,
): ChunkIndexEntry[] {
  if (chunkIndex) return chunkIndex;

  const { schema, shape, chunkShape, interleaving, fieldPipelines, chunkPipeline } = ctx;
  const chunkGrid = computeChunkGrid(shape, chunkShape);
  const coordsList = enumerateChunkCoords(chunkGrid);

  if (interleaving === 'column') {
    for (const varInfo of schema) {
      const steps = fieldPipelines?.[varInfo.name] ?? [];
      if (hasSizeChangingCodec(steps)) {
        throw new NoChunkIndexError(`variable "${varInfo.name}" has a size-changing codec with no chunk index`);
      }
    }
    const bytesPerElement = new Map(schema.map((v) => [v.name, getDtype(v.dtype).size]));
    const entries: ChunkIndexEntry[] = [];
    // Offset accumulates ACROSS variables: write.ts lays out a column-mode
    // single file variable-grouped (all of var A's chunks, then var B's), so
    // each variable's chunks start where the previous variable's ended.
    // (Resetting per variable was a latent bug only visible with 2+ variables
    // and includeChunkIndex=false.)
    let offset = magicLength;
    for (const varInfo of schema) {
      const elemSize = bytesPerElement.get(varInfo.name)!;
      for (const coords of coordsList) {
        const size = chunkGeometry(coords, chunkShape, shape).elementCount * elemSize;
        entries.push({ coords, offset, size, variableName: varInfo.name });
        offset += size;
      }
    }
    return entries;
  }

  const steps = chunkPipeline ?? [];
  if (hasSizeChangingCodec(steps)) {
    throw new NoChunkIndexError('row-mode chunk pipeline has a size-changing codec with no chunk index');
  }
  const bytesPerElement = schema.reduce((sum, v) => sum + getDtype(v.dtype).size, 0);
  const entries: ChunkIndexEntry[] = [];
  let offset = magicLength;
  for (const coords of coordsList) {
    const size = chunkGeometry(coords, chunkShape, shape).elementCount * bytesPerElement;
    entries.push({ coords, offset, size });
    offset += size;
  }
  return entries;
}

/** Whether any step in a codec pipeline changes the encoded byte count
 * (category 'entropy' — rle/lz), determined from the metadata's own codec
 * specs, never from app config (the reader only ever sees the file). */
function hasSizeChangingCodec(steps: CodecStep[]): boolean {
  return steps.some((step) => CODEC_REGISTRY[step.codec]?.category === 'entropy');
}

/** Reassemble all variables' values from their chunks, using `getChunkBytes`
 * to resolve each chunk_index entry to bytes (works identically for
 * single-file and per-chunk-file modes — see `ChunkBytesReader`). */
function reconstructValues(
  ctx: ReassemblyContext,
  getChunkBytes: ChunkBytesReader,
): Map<string, LogicalValue[]> {
  const { schema, shape, chunkShape, interleaving, fieldPipelines, chunkPipeline, chunkIndex, totalElements } = ctx;
  const result = new Map<string, LogicalValue[]>();

  if (interleaving === 'column') {
    // Column mode: each chunk_index entry belongs to exactly one variable
    // (carries variableName); decode it with that variable's field pipeline
    // and scatter its chunk-local row-major values to global positions.
    for (const varInfo of schema) {
      // Char variables reconstruct into '' (the text analogue of 0) so a
      // missing chunk leaves an empty string, not a bogus numeric zero.
      const fill: LogicalValue = isCharDtype(varInfo.dtype) ? '' : 0;
      const values: LogicalValue[] = new Array(totalElements).fill(fill);
      const steps = fieldPipelines?.[varInfo.name] ?? [];
      const varEntries = (chunkIndex ?? []).filter((e) => e.variableName === varInfo.name);

      for (const entry of varEntries) {
        const chunkBytes = getChunkBytes(entry, varInfo.name);
        if (!chunkBytes) continue;
        const decoded = reverseCodecPipeline(chunkBytes, steps, varInfo.dtype);
        const chunkValues = bytesToValues(decoded.bytes, decoded.outputDtype as DtypeKey);
        scatterChunkValues(values, chunkValues, entry.coords, chunkShape, shape);
      }

      result.set(varInfo.name, values);
    }
  } else {
    // Row mode: each chunk_index entry covers all variables' interleaved
    // bytes for that chunk. Decode, deinterleave locally into per-variable
    // chunk-local arrays, then scatter each into its global position.
    const steps = chunkPipeline ?? [];
    const inputDtype = rowModeInputDtype(schema);

    for (const varInfo of schema) {
      result.set(varInfo.name, new Array(totalElements).fill(isCharDtype(varInfo.dtype) ? '' : 0));
    }

    for (const entry of chunkIndex ?? []) {
      const chunkBytes = getChunkBytes(entry);
      if (!chunkBytes) continue;
      const decoded = reverseCodecPipeline(chunkBytes, steps, inputDtype);
      const chunkElementN = chunkGeometry(entry.coords, chunkShape, shape).elementCount;
      const perVarChunkValues = deinterleaveRowChunk(decoded.bytes, schema, chunkElementN);
      for (const varInfo of schema) {
        scatterChunkValues(
          result.get(varInfo.name)!,
          perVarChunkValues.get(varInfo.name)!,
          entry.coords,
          chunkShape,
          shape,
        );
      }
    }
  }

  return result;
}

function rowModeInputDtype(schema: SchemaEntry[]): DtypeKey {
  const uniqueDtypes = new Set(schema.map((v) => v.dtype));
  return uniqueDtypes.size > 1 ? 'uint8' : schema[0]?.dtype ?? 'uint8';
}

/** Deinterleave one chunk's decoded row-interleaved bytes into per-variable,
 * chunk-local (row-major within the chunk) value arrays. `chunkElementCount`
 * is this chunk's own element count (ragged edge chunks are smaller). */
function deinterleaveRowChunk(
  bytes: Uint8Array,
  schema: SchemaEntry[],
  chunkElementCount: number,
): Map<string, LogicalValue[]> {
  const bytesPerElement = schema.reduce((sum, v) => sum + getDtype(v.dtype).size, 0);
  const result = new Map<string, LogicalValue[]>();
  for (const varInfo of schema) {
    result.set(varInfo.name, []);
  }

  for (let elem = 0; elem < chunkElementCount; elem++) {
    let varByteOffset = 0;
    for (const varInfo of schema) {
      const dtypeInfo = getDtype(varInfo.dtype);
      const start = elem * bytesPerElement + varByteOffset;
      const elemBytes = bytes.slice(start, start + dtypeInfo.size);
      const values = bytesToValues(elemBytes, varInfo.dtype);
      if (values.length > 0) {
        result.get(varInfo.name)!.push(values[0]);
      }
      varByteOffset += dtypeInfo.size;
    }
  }

  return result;
}

/** Reverse a type assignment on already-decoded numeric values: re-encode to
 * bytes and call the shared `reverseTypeAssignment` rather than
 * re-implementing scale/offset reversal inline here. */
function reverseTypeAssignmentValues(values: LogicalValue[], assignment: TypeAssignment): LogicalValue[] {
  const bytes = valuesToBytes(values, assignment.storageDtype);
  return reverseTypeAssignment(bytes, assignment);
}
