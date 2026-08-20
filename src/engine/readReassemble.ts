import type { VirtualFile } from '../types/pipeline.ts';
import type { DtypeKey, LogicalValue } from '../types/dtypes.ts';
import type { CodecStep } from '../types/codecs.ts';
import type { TypeAssignment } from '../types/state.ts';
import { getDtype, isCharDtype } from '../types/dtypes.ts';
import { bytesToValues, valuesToBytes } from './elements.ts';
import type { ValueArray } from './layout.ts';
import type { ChunkIndexEntry } from './metadata.ts';
import { reverseCodecPipeline } from './decode.ts';
import { reverseTypeAssignment } from './typeAssign.ts';
import { encodedByteLength } from './codecs.ts';
import { coordsToFlatIndex, computeChunkGrid, enumerateChunkCoords } from './chunk.ts';
import { orderCoordsOf, type LinearizationOrder } from './order.ts';
import { stripMagic } from './readLocate.ts';

export type SchemaEntry = { name: string; dtype: DtypeKey };

/** D3: thrown by `resolveChunkIndex` when `chunk_index` is absent from
 * metadata AND at least one codec pipeline in play is size-changing, so
 * encoded chunk sizes can't be derived from chunkShape x dtype size alone.
 * Mapped by `readFile` to failure reason 'no-chunk-index'. */
export class NoChunkIndexError extends Error {}

/** Read plan Task 3 §3: thrown by `reconstructValues` when assume-identity
 * (codec_pipelines absent) is active and a chunk's raw byte count doesn't
 * match what chunk geometry x dtype size predicts — the detectable half of
 * the three-way assume-identity outcome (the other two, honest-success and
 * garbled-but-same-size, can't be distinguished from a byte count alone and
 * both fall through as ordinary decode-chunks 'ok'). Mapped by `readFile` to
 * 'decode-error' at decode-chunks, with both counts named in the message. */
export class AssumedIdentitySizeMismatchError extends Error {}

// ─── Chunk reassembly ──────────────────────────────────────────────────────

export interface ReassemblyContext {
  schema: SchemaEntry[];
  shape: number[];
  chunkShape: number[];
  interleaving: 'row' | 'column';
  /** cl-6: element linearization order within each chunk (see ParsedStructure). */
  linearization: LinearizationOrder;
  fieldPipelines: Record<string, CodecStep[]> | null;
  chunkPipeline: CodecStep[] | null;
  chunkIndex: ChunkIndexEntry[] | null;
  totalElements: number;
  /** Byte order for decoding multi-byte values (see ParsedStructure). */
  byteOrder: 'little' | 'big';
  /** Read plan Task 3 §3: whether `codec_pipelines` was present in metadata.
   * When false, the reader assumes an empty (identity) pipeline per variable/
   * chunk — correct if no codecs were actually applied at write time, wrong
   * (garbled values) if a non-size-changing codec was applied, and *detectably*
   * wrong if a size-changing codec was applied: the assumed-raw chunk byte
   * count won't match what chunk geometry x dtype size predicts, since the
   * codec compressed it. `reconstructValues` checks that expected-vs-actual
   * count in exactly that situation and throws (mapped to decode-error). */
  codecInfoPresent: boolean;
}

export interface ChunkGeometry {
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
export function chunkGeometry(coords: number[], chunkShape: number[], shape: number[]): ChunkGeometry {
  const clampedChunkShape = chunkShape.map((cs, d) => Math.min(cs, shape[d]));
  const startIndices = coords.map((c, d) => c * clampedChunkShape[d]);
  const extent = startIndices.map((s, d) => Math.min(s + clampedChunkShape[d], shape[d]) - s);
  const elementCount = extent.reduce((acc, e) => acc * e, 1);
  return { startIndices, extent, elementCount };
}

/** Scatter a chunk's decoded, chunk-local row-major values into `target` at
 * their global row-major positions — the exact inverse of `chunk.ts`'s
 * `extractChunkValues`. */
export function scatterChunkValues(
  target: ValueArray,
  chunkValues: ValueArray,
  coords: number[],
  chunkShape: number[],
  shape: number[],
  order: LinearizationOrder,
): void {
  const { startIndices, extent, elementCount } = chunkGeometry(coords, chunkShape, shape);

  for (let i = 0; i < elementCount && i < chunkValues.length; i++) {
    // Inverse of chunk.ts's extractChunkValues gather: the i-th decoded value
    // (its position in the linearized byte sequence) came from the element at
    // orderCoordsOf(i, extent, order). For 'c' this is flatIndexToCoords.
    const localCoords = orderCoordsOf(i, extent, order);
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
export type ChunkBytesReader = (entry: ChunkIndexEntry, variableName?: string) => Uint8Array | null;

export function makeSingleFileChunkReader(fileBytes: Uint8Array): ChunkBytesReader {
  return (entry) => fileBytes.slice(entry.offset, entry.offset + entry.size);
}

export function makePerChunkFileReader(dataFiles: VirtualFile[], magicBytes: Uint8Array): ChunkBytesReader {
  return (entry, variableName) => {
    const suffix = `chunk_${entry.coords.join('_')}`;
    const expectedName = variableName ? `${variableName}_${suffix}` : suffix;
    const file = dataFiles.find((f) => f.name === expectedName);
    return file ? stripMagic(file.bytes, magicBytes) : null;
  };
}

/** Order chunk coords the way `write.ts`'s `orderChunks` lays them out for a
 * single file: row-major keeps `enumerateChunkCoords` order; column-major
 * sorts so the LAST dimension varies slowest (comparing dims high→low, first
 * differing dim wins) — mirror of the column-major comparator there, so a
 * synthetic index enumerates chunks in exactly the written byte order. */
function orderCoordsForChunkOrder(
  coordsList: number[][],
  chunkGrid: number[],
  chunkOrder: 'row-major' | 'column-major',
): number[][] {
  if (chunkOrder !== 'column-major' || chunkGrid.length <= 1) return coordsList;
  return [...coordsList].sort((a, b) => {
    for (let d = chunkGrid.length - 1; d >= 0; d--) {
      if (a[d] !== b[d]) return a[d] - b[d];
    }
    return 0;
  });
}

/**
 * D3: when `chunk_index` is absent from metadata (`includeChunkIndex` off),
 * compute synthetic entries instead.
 *
 * Per-chunk partitioning: chunks are resolved by FILENAME from coords (see
 * `makePerChunkFileReader`), which ignores offset/size entirely, so a
 * synthetic index only needs coords (and variableName in column mode) — with
 * NO size-changing-codec check, since size is never consulted.
 *
 * Single-file partitioning: offsets are derived from chunk geometry x dtype
 * size, laid out back-to-back in `chunkOrder` (row- or column-major) so they
 * match what `write.ts` wrote. Only possible when every codec pipeline in
 * play is size-preserving; any size-changing (entropy: rle/lz) codec makes
 * offsets underivable and throws `NoChunkIndexError` (mapped to
 * 'no-chunk-index').
 */
export function resolveChunkIndex(
  chunkIndex: ChunkIndexEntry[] | null,
  // `linearization` intentionally excluded: chunk byte SIZE (and thus offset)
  // depends only on chunk geometry x dtype size, not on intra-chunk element
  // order, so this function never needs it.
  ctx: Omit<ReassemblyContext, 'chunkIndex' | 'totalElements' | 'codecInfoPresent' | 'linearization' | 'byteOrder'>
    & { partitioning: 'single' | 'per-chunk'; chunkOrder: 'row-major' | 'column-major' },
  magicLength: number,
): ChunkIndexEntry[] {
  if (chunkIndex) return chunkIndex;

  const { schema, shape, chunkShape, interleaving, fieldPipelines, chunkPipeline, partitioning, chunkOrder } = ctx;
  const chunkGrid = computeChunkGrid(shape, chunkShape);
  const coordsList = orderCoordsForChunkOrder(enumerateChunkCoords(chunkGrid), chunkGrid, chunkOrder);

  // Per-chunk files are matched by filename (coords/variableName), not offset,
  // so a coords-only synthetic index suffices regardless of codec — no size,
  // no NoChunkIndexError.
  if (partitioning === 'per-chunk') {
    const entries: ChunkIndexEntry[] = [];
    if (interleaving === 'column') {
      for (const varInfo of schema) {
        for (const coords of coordsList) {
          entries.push({ coords, offset: 0, size: 0, variableName: varInfo.name });
        }
      }
    } else {
      for (const coords of coordsList) {
        entries.push({ coords, offset: 0, size: 0 });
      }
    }
    return entries;
  }

  if (interleaving === 'column') {
    const entries: ChunkIndexEntry[] = [];
    // Offset accumulates ACROSS variables: write.ts lays out a column-mode
    // single file variable-grouped (all of var A's chunks, then var B's), so
    // each variable's chunks start where the previous variable's ended.
    // (Resetting per variable was a latent bug only visible with 2+ variables
    // and includeChunkIndex=false.)
    let offset = magicLength;
    for (const varInfo of schema) {
      const steps = fieldPipelines?.[varInfo.name] ?? [];
      const elemSize = getDtype(varInfo.dtype).size;
      for (const coords of coordsList) {
        const raw = chunkGeometry(coords, chunkShape, shape).elementCount * elemSize;
        const size = encodedByteLength(steps, varInfo.dtype, raw);
        if (size === null) {
          throw new NoChunkIndexError(`variable "${varInfo.name}" has a size-changing codec with no chunk index`);
        }
        entries.push({ coords, offset, size, variableName: varInfo.name });
        offset += size;
      }
    }
    return entries;
  }

  const steps = chunkPipeline ?? [];
  const bytesPerElement = schema.reduce((sum, v) => sum + getDtype(v.dtype).size, 0);
  const entries: ChunkIndexEntry[] = [];
  let offset = magicLength;
  for (const coords of coordsList) {
    const raw = chunkGeometry(coords, chunkShape, shape).elementCount * bytesPerElement;
    const size = encodedByteLength(steps, rowModeInputDtype(schema), raw);
    if (size === null) {
      throw new NoChunkIndexError('row-mode chunk pipeline has a size-changing codec with no chunk index');
    }
    entries.push({ coords, offset, size });
    offset += size;
  }
  return entries;
}

/** Reassemble all variables' values from their chunks, using `getChunkBytes`
 * to resolve each chunk_index entry to bytes (works identically for
 * single-file and per-chunk-file modes — see `ChunkBytesReader`). */
/** Pre-allocate a variable's reconstruction target: Float64Array (zero-filled,
 *  matching bytesToValues' now-uniform numeric shape) for numeric dtypes,
 *  a ''-filled string[] for charN — mirrors the old fill-value convention
 *  ('' for text, 0 for numeric; Float64Array already zero-fills). */
function makeReconstructionTarget(dtype: DtypeKey, totalElements: number): ValueArray {
  if (isCharDtype(dtype)) {
    return new Array(totalElements).fill('');
  }
  return new Float64Array(totalElements);
}

export function reconstructValues(
  ctx: ReassemblyContext,
  getChunkBytes: ChunkBytesReader,
): Map<string, ValueArray> {
  const { schema, shape, chunkShape, interleaving, linearization, fieldPipelines, chunkPipeline, chunkIndex, totalElements, codecInfoPresent, byteOrder } = ctx;
  const result = new Map<string, ValueArray>();

  if (interleaving === 'column') {
    // Column mode: each chunk_index entry belongs to exactly one variable
    // (carries variableName); decode it with that variable's field pipeline
    // and scatter its chunk-local row-major values to global positions.
    for (const varInfo of schema) {
      // Char variables reconstruct into '' (the text analogue of 0) so a
      // missing chunk leaves an empty string, not a bogus numeric zero.
      const values = makeReconstructionTarget(varInfo.dtype, totalElements);
      const steps = fieldPipelines?.[varInfo.name] ?? [];
      const varEntries = (chunkIndex ?? []).filter((e) => e.variableName === varInfo.name);

      for (const entry of varEntries) {
        const chunkBytes = getChunkBytes(entry, varInfo.name);
        if (!chunkBytes) continue;
        if (!codecInfoPresent) {
          const expectedBytes = chunkGeometry(entry.coords, chunkShape, shape).elementCount * getDtype(varInfo.dtype).size;
          checkAssumedIdentitySize(chunkBytes.length, expectedBytes, varInfo.name, entry.coords);
        }
        const decoded = reverseCodecPipeline(chunkBytes, steps, varInfo.dtype, byteOrder);
        const chunkValues = bytesToValues(decoded.bytes, decoded.outputDtype as DtypeKey, byteOrder);
        scatterChunkValues(values, chunkValues, entry.coords, chunkShape, shape, linearization);
      }

      result.set(varInfo.name, values);
    }
  } else {
    // Row mode: each chunk_index entry covers all variables' interleaved
    // bytes for that chunk. Decode, deinterleave locally into per-variable
    // chunk-local arrays, then scatter each into its global position.
    const steps = chunkPipeline ?? [];
    const inputDtype = rowModeInputDtype(schema);
    const bytesPerElement = schema.reduce((sum, v) => sum + getDtype(v.dtype).size, 0);

    for (const varInfo of schema) {
      result.set(varInfo.name, makeReconstructionTarget(varInfo.dtype, totalElements));
    }

    for (const entry of chunkIndex ?? []) {
      const chunkBytes = getChunkBytes(entry);
      if (!chunkBytes) continue;
      if (!codecInfoPresent) {
        const expectedBytes = chunkGeometry(entry.coords, chunkShape, shape).elementCount * bytesPerElement;
        checkAssumedIdentitySize(chunkBytes.length, expectedBytes, undefined, entry.coords);
      }
      const decoded = reverseCodecPipeline(chunkBytes, steps, inputDtype, byteOrder);
      const chunkElementN = chunkGeometry(entry.coords, chunkShape, shape).elementCount;
      const perVarChunkValues = deinterleaveRowChunk(decoded.bytes, schema, chunkElementN, byteOrder);
      for (const varInfo of schema) {
        scatterChunkValues(
          result.get(varInfo.name)!,
          perVarChunkValues.get(varInfo.name)!,
          entry.coords,
          chunkShape,
          shape,
          linearization,
        );
      }
    }
  }

  return result;
}

/** Read plan Task 3 §3: the assume-identity byte-count check. `expectedBytes`
 * is chunk geometry x dtype size — what a size-preserving (or no) codec
 * pipeline would produce. A mismatch means a size-changing codec (rle/lz)
 * really was applied at write time and its metadata omitted; the reader has
 * no way to reverse it without knowing which codec, so this is a genuine
 * failure, not a silent guess. */
export function checkAssumedIdentitySize(
  actualBytes: number,
  expectedBytes: number,
  variableName: string | undefined,
  coords: number[],
): void {
  if (actualBytes === expectedBytes) return;
  const where = variableName ? `variable "${variableName}", ` : '';
  throw new AssumedIdentitySizeMismatchError(
    `${where}chunk [${coords.join(',')}]: expected ${expectedBytes} bytes (chunk shape x dtype size, ` +
    `assuming no codec was applied) but found ${actualBytes} bytes — a size-changing codec was likely ` +
    `applied at write time and its metadata was omitted.`,
  );
}

export function rowModeInputDtype(schema: SchemaEntry[]): DtypeKey {
  const uniqueDtypes = new Set(schema.map((v) => v.dtype));
  return uniqueDtypes.size > 1 ? 'uint8' : schema[0]?.dtype ?? 'uint8';
}

/** Deinterleave one chunk's decoded row-interleaved bytes into per-variable,
 * chunk-local (row-major within the chunk) value arrays. `chunkElementCount`
 * is this chunk's own element count (ragged edge chunks are smaller). */
export function deinterleaveRowChunk(
  bytes: Uint8Array,
  schema: SchemaEntry[],
  chunkElementCount: number,
  byteOrder: 'little' | 'big' = 'little',
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
      const values = bytesToValues(elemBytes, varInfo.dtype, byteOrder);
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
export function reverseTypeAssignmentValues(
  values: ValueArray,
  assignment: TypeAssignment,
  byteOrder: 'little' | 'big',
): ValueArray {
  const bytes = valuesToBytes(values, assignment.storageDtype, byteOrder);
  return reverseTypeAssignment(bytes, assignment, byteOrder);
}
