import type { AppState } from '../types/state.ts';
import type { EncodedChunk, VirtualFile, ByteTrace, VariableStats } from '../types/pipeline.ts';
import { collectMetadata, serializeMetadata, deserializeMetadata, type ChunkIndexEntry } from './metadata.ts';
import { hexToBytes } from './bytes.ts';

export { hexToBytes };

/**
 * Order chunks according to the specified ordering.
 * Row-major: natural order (as enumerated). Already in row-major from enumerateChunkCoords.
 * Column-major: reverse the coordinate priority.
 * When variableOrder is provided, first group by variable (preserving spatial order within).
 */
export function orderChunks(
  chunks: EncodedChunk[],
  chunkGrid: number[],
  order: 'row-major' | 'column-major',
  variableOrder?: string[],
): EncodedChunk[] {
  let sorted = [...chunks];

  // Apply spatial ordering first
  if (order === 'column-major' && chunkGrid.length > 1) {
    sorted.sort((a, b) => {
      for (let d = chunkGrid.length - 1; d >= 0; d--) {
        if (a.coords[d] !== b.coords[d]) {
          return a.coords[d] - b.coords[d];
        }
      }
      return 0;
    });
  }

  // Then stable-sort by variable order if provided
  if (variableOrder && variableOrder.length > 0) {
    const varIndex = new Map(variableOrder.map((name, i) => [name, i]));
    sorted.sort((a, b) => {
      const aIdx = varIndex.get(a.variableName ?? '') ?? variableOrder.length;
      const bIdx = varIndex.get(b.variableName ?? '') ?? variableOrder.length;
      return aIdx - bIdx;
    });
  }

  return sorted;
}

/**
 * Assemble the final virtual files from encoded chunks.
 * Two-pass approach: first pass measures sizes, second pass serializes with correct offsets.
 */
export function assembleFiles(
  state: AppState,
  encodedChunks: EncodedChunk[],
  chunkGrid: number[],
  variableStats?: Map<string, VariableStats>,
): VirtualFile[] {
  const magic = state.write.magicNumber ? hexToBytes(state.write.magicNumber) : new Uint8Array(0);
  const variableOrder = state.interleaving === 'column'
    ? state.variables.map((v) => v.name)
    : undefined;
  const orderedChunks = orderChunks(encodedChunks, chunkGrid, state.write.chunkOrder, variableOrder);

  if (state.write.partitioning === 'per-chunk') {
    return assemblePerChunkFiles(state, orderedChunks, magic, variableStats);
  }

  return assembleSingleFile(state, orderedChunks, magic, chunkGrid, variableStats);
}

/**
 * Build a file with no metadata at all — only magic + chunk data + magic.
 */
function buildNoMetadataFile(
  magic: Uint8Array,
  orderedChunks: EncodedChunk[],
): VirtualFile[] {
  return buildSingleFile(magic, new Uint8Array(0), orderedChunks, 'none');
}

function assembleSingleFile(
  state: AppState,
  orderedChunks: EncodedChunk[],
  magic: Uint8Array,
  _chunkGrid: number[],
  variableStats?: Map<string, VariableStats>,
): VirtualFile[] {
  // If metadata is not included, produce file with only magic + chunks + magic
  if (state.write.includeMetadata === false) {
    return buildNoMetadataFile(magic, orderedChunks);
  }

  const placement = state.write.metadataPlacement;

  if (placement === 'header') {
    // The header's metadata embeds chunk_index offsets, which are only known
    // once the header's own size is known — a fixed-point problem (metadata
    // size depends on chunk offsets, which depend on metadata size, and each
    // change in offset digit-count can nudge the JSON size again). Iterate to
    // a verified fixed point instead of a fixed number of copy-pasted passes.
    const metaBytes = convergeHeaderMetadata(state, orderedChunks, magic, variableStats);
    return buildSingleFile(magic, metaBytes, orderedChunks, 'header');
  }

  if (placement === 'footer') {
    // Footer metadata doesn't shift chunk offsets (chunks are written right
    // after the start magic regardless of metadata size), so no convergence
    // loop is needed here — offsets are exact on the first pass.
    const chunkOffsets = computeChunkOffsets(orderedChunks, magic.length);
    const meta = collectMetadata(state, orderedChunks, variableStats, chunkOffsets);
    const metaBytes = serializeMetadata(meta, state.metadata.serialization);
    // D1: footerLocator='trailer' appends a 4-byte LE metadata length just
    // before the closing magic — [magic][chunks][metadata][u32 LE len][magic]
    // (Parquet-style: [footer][len]['PAR1']). This lets the reader seek
    // directly to the metadata without scanning, for JSON and binary alike.
    // footerLocator='none' keeps the plain [magic][chunks][metadata][magic]
    // layout and leaves the reader to a best-effort backward scan.
    return buildSingleFile(magic, metaBytes, orderedChunks, 'footer', {
      trailer: state.write.footerLocator === 'trailer',
    });
  }

  // Sidecar: metadata lives in a separate file, so chunk offsets in the data
  // file are exact on the first pass too.
  const chunkOffsets = computeChunkOffsets(orderedChunks, magic.length);
  const meta = collectMetadata(state, orderedChunks, variableStats, chunkOffsets);
  const metaBytes = serializeMetadata(meta, state.metadata.serialization);

  const dataFile = buildSingleFile(magic, new Uint8Array(0), orderedChunks, 'none');
  const sidecarFile: VirtualFile = {
    name: 'metadata',
    bytes: metaBytes,
    traces: makeMetadataTraces(metaBytes.length),
  };

  return [...dataFile, sidecarFile];
}

function buildSingleFile(
  magic: Uint8Array,
  metaBytes: Uint8Array,
  orderedChunks: EncodedChunk[],
  placement: 'header' | 'footer' | 'none',
  options?: { trailer?: boolean },
): VirtualFile[] {
  // Layout: [magic][header metadata?][chunks][footer metadata? [+ trailer len]?][magic]
  const parts: Uint8Array[] = [];
  const traceParts: ByteTrace[][] = [];

  parts.push(magic);
  traceParts.push(makeMagicTraces(magic.length, true));

  if (placement === 'header' && metaBytes.length > 0) {
    parts.push(metaBytes);
    traceParts.push(makeMetadataTraces(metaBytes.length));
  }

  for (const chunk of orderedChunks) {
    parts.push(chunk.bytes);
    traceParts.push(chunk.traces);
  }

  if (placement === 'footer' && metaBytes.length > 0) {
    parts.push(metaBytes);
    traceParts.push(makeMetadataTraces(metaBytes.length));

    // D1 trailer: [u32 LE metadata-length] right before the closing magic —
    // Parquet-style. Lets the reader seek to `end - magicLen - 4`, read the
    // length, and slice the metadata exactly, for JSON and binary alike.
    if (options?.trailer) {
      const lenBuf = new ArrayBuffer(4);
      new DataView(lenBuf).setUint32(0, metaBytes.length, true);
      const lenBytes = new Uint8Array(lenBuf);
      parts.push(lenBytes);
      traceParts.push(makeMetadataTraces(lenBytes.length));
    }
  }

  parts.push(magic);
  traceParts.push(makeMagicTraces(magic.length, false));

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

function assemblePerChunkFiles(
  state: AppState,
  orderedChunks: EncodedChunk[],
  magic: Uint8Array,
  variableStats?: Map<string, VariableStats>,
): VirtualFile[] {
  const files: VirtualFile[] = [];

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

  // Only include metadata sidecar when includeMetadata is true
  if (state.write.includeMetadata !== false) {
    // Per-chunk mode: each chunk is its own file, so "offset" is always the
    // position right after that file's own leading magic (not a position
    // within a combined stream). The reader matches these entries to files
    // by coords (and variableName in column mode), never by byte offset
    // across files.
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

function computeChunkOffsets(
  chunks: EncodedChunk[],
  startOffset: number,
): ChunkIndexEntry[] {
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

/**
 * Converge the header-placement metadata to a stable serialized length.
 *
 * The header embeds a `chunk_index` whose byte offsets depend on the
 * header's own size (offsets start right after the header), while the
 * header's size depends on the chunk index (larger/smaller offset numbers
 * change the JSON's digit count). This is a small fixed-point problem:
 * re-serialize using the previous pass's length as the next pass's assumed
 * header size, until the length stops changing or a bound on iterations is
 * hit. If it genuinely won't settle (e.g. an adversarial serialization that
 * oscillates between lengths forever), pad the JSON metadata with trailing
 * whitespace to the largest length seen so the embedded offsets are still
 * exactly correct for the metadata actually written — correctness of the
 * final offsets is asserted before returning.
 */
const MAX_CONVERGENCE_ITERATIONS = 6;

function serializeWithOffsetsFor(
  state: AppState,
  orderedChunks: EncodedChunk[],
  magic: Uint8Array,
  variableStats: Map<string, VariableStats> | undefined,
  assumedMetaLength: number,
): Uint8Array {
  const chunkOffsets = computeChunkOffsets(orderedChunks, magic.length + assumedMetaLength);
  const meta = collectMetadata(state, orderedChunks, variableStats, chunkOffsets);
  return serializeMetadata(meta, state.metadata.serialization);
}

function convergeHeaderMetadata(
  state: AppState,
  orderedChunks: EncodedChunk[],
  magic: Uint8Array,
  variableStats?: Map<string, VariableStats>,
): Uint8Array {
  // Initial guess: metadata size before any chunk index is embedded.
  const baseMeta = collectMetadata(state, orderedChunks, variableStats);
  let metaBytes = serializeMetadata(baseMeta, state.metadata.serialization);

  let maxLengthSeen = metaBytes.length;
  let converged = false;

  for (let i = 0; i < MAX_CONVERGENCE_ITERATIONS; i++) {
    const next = serializeWithOffsetsFor(state, orderedChunks, magic, variableStats, metaBytes.length);
    maxLengthSeen = Math.max(maxLengthSeen, next.length);
    if (next.length === metaBytes.length) {
      metaBytes = next;
      converged = true;
      break;
    }
    metaBytes = next;
  }

  if (!converged) {
    // Didn't settle within the iteration budget — offset digit-counts are
    // oscillating between a small set of lengths. Serialize once more
    // assuming the largest length seen (offsets can only get larger or stay
    // the same as assumed header length grows, so this is a safe upper
    // bound), then pad (JSON only) up to exactly that length. Padding never
    // changes an already-embedded offset, so this length is stable by
    // construction: offsets were computed for maxLengthSeen, and the bytes
    // are padded to be exactly maxLengthSeen long.
    const atMaxLength = serializeWithOffsetsFor(state, orderedChunks, magic, variableStats, maxLengthSeen);
    metaBytes = padMetadataToLength(state, atMaxLength, maxLengthSeen);
  }

  assertChunkOffsetsMatch(metaBytes, magic.length + metaBytes.length, orderedChunks);

  return metaBytes;
}

/**
 * Verify that the chunk_index embedded in `metaBytes` actually starts its
 * first entry at `expectedDataStart` — i.e. that the offsets were computed
 * for a header of exactly this length, not a stale earlier guess. Throws
 * rather than silently shipping a file whose reader would mis-slice chunks.
 */
function assertChunkOffsetsMatch(
  metaBytes: Uint8Array,
  expectedDataStart: number,
  orderedChunks: EncodedChunk[],
): void {
  if (orderedChunks.length === 0) return;
  const entries = parseChunkIndexForVerification(metaBytes);
  if (!entries || entries.length === 0) return;
  const first = entries[0];
  if (first.offset !== expectedDataStart) {
    throw new Error(
      `write: metadata offset convergence failed — chunk_index[0].offset ` +
      `(${first.offset}) does not match the actual data start (${expectedDataStart})`,
    );
  }
}

function parseChunkIndexForVerification(metaBytes: Uint8Array): ChunkIndexEntry[] | null {
  try {
    const entries = deserializeMetadata(metaBytes);
    const chunkIndexEntry = entries.find((e) => e.key === 'chunk_index');
    if (!chunkIndexEntry) return null;
    return JSON.parse(chunkIndexEntry.value) as ChunkIndexEntry[];
  } catch {
    return null;
  }
}

/**
 * Pad serialized metadata to an exact target length. Only meaningful for
 * JSON (trailing whitespace outside the top-level object is inert); binary
 * metadata has no whitespace convention, so padding is a no-op for it (the
 * bounded loop above converges for binary well before this is reached,
 * since offsets there are fixed-width 4-byte integers that don't change the
 * frame size the way JSON decimal digit counts do).
 */
function padMetadataToLength(state: AppState, bytes: Uint8Array, targetLength: number): Uint8Array {
  if (state.metadata.serialization !== 'json' || bytes.length >= targetLength) {
    return bytes;
  }
  const result = new Uint8Array(targetLength);
  result.set(bytes, 0);
  result.fill(0x20, bytes.length); // ASCII space
  return result;
}

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
