import type { AppState } from '../types/state.ts';
import type { EncodedChunk, VirtualFile, ByteTrace, VariableStats } from '../types/pipeline.ts';
import { collectMetadata, serializeMetadata } from './metadata.ts';

/** Parse a hex string (e.g., "00C0DEC5") into bytes. */
export function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.replace(/\s/g, '');
  if (cleaned.length % 2 !== 0) {
    throw new Error('Hex string must have even length');
  }
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < cleaned.length; i += 2) {
    bytes[i / 2] = parseInt(cleaned.substring(i, i + 2), 16);
  }
  return bytes;
}

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

  // Pass 1: compute chunk offsets
  let dataStartOffset = magic.length;
  if (placement === 'header') {
    // We need to estimate metadata size, then add it to get chunk offsets.
    // First, collect metadata without chunk offsets to measure base size.
    const baseMeta = collectMetadata(state, orderedChunks, variableStats);
    const baseMetaBytes = serializeMetadata(baseMeta, state.metadata.serialization);

    // Now compute with chunk offsets (iterate to convergence since
    // chunk index size affects offsets).
    dataStartOffset = magic.length + baseMetaBytes.length;
    const chunkOffsets = computeChunkOffsets(orderedChunks, dataStartOffset);

    // Re-serialize with the correct chunk offsets
    const metaWithIndex = collectMetadata(state, orderedChunks, variableStats, chunkOffsets);
    const metaBytes = serializeMetadata(metaWithIndex, state.metadata.serialization);

    // If the size changed, recompute offsets
    if (metaBytes.length !== baseMetaBytes.length) {
      const adjustedStart = magic.length + metaBytes.length;
      const adjustedOffsets = computeChunkOffsets(orderedChunks, adjustedStart);
      const finalMeta = collectMetadata(state, orderedChunks, variableStats, adjustedOffsets);
      const finalMetaBytes = serializeMetadata(finalMeta, state.metadata.serialization);

      // Third pass if still not converged (rare)
      if (finalMetaBytes.length !== metaBytes.length) {
        const thirdStart = magic.length + finalMetaBytes.length;
        const thirdOffsets = computeChunkOffsets(orderedChunks, thirdStart);
        const thirdMeta = collectMetadata(state, orderedChunks, variableStats, thirdOffsets);
        const thirdMetaBytes = serializeMetadata(thirdMeta, state.metadata.serialization);
        return buildSingleFile(magic, thirdMetaBytes, orderedChunks, 'header');
      }

      return buildSingleFile(magic, finalMetaBytes, orderedChunks, 'header');
    }

    return buildSingleFile(magic, metaBytes, orderedChunks, 'header');
  }

  if (placement === 'footer') {
    dataStartOffset = magic.length;
    const chunkOffsets = computeChunkOffsets(orderedChunks, dataStartOffset);
    const meta = collectMetadata(state, orderedChunks, variableStats, chunkOffsets);
    const metaBytes = serializeMetadata(meta, state.metadata.serialization);
    return buildSingleFile(magic, metaBytes, orderedChunks, 'footer');
  }

  // Sidecar
  dataStartOffset = magic.length;
  const chunkOffsets = computeChunkOffsets(orderedChunks, dataStartOffset);
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
): VirtualFile[] {
  const parts: Uint8Array[] = [];
  const traceParts: ByteTrace[][] = [];

  // Start magic
  parts.push(magic);
  traceParts.push(makeMagicTraces(magic.length, true));

  // Header metadata
  if (placement === 'header' && metaBytes.length > 0) {
    parts.push(metaBytes);
    traceParts.push(makeMetadataTraces(metaBytes.length));
  }

  // Chunk data
  for (const chunk of orderedChunks) {
    parts.push(chunk.bytes);
    traceParts.push(chunk.traces);
  }

  // Footer metadata
  if (placement === 'footer' && metaBytes.length > 0) {
    parts.push(metaBytes);
    traceParts.push(makeMetadataTraces(metaBytes.length));
  }

  // End magic
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
    const chunkOffsets = orderedChunks.map((c) => ({
      coords: c.coords,
      offset: magic.length,
      size: c.bytes.length,
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
): { coords: number[]; offset: number; size: number }[] {
  let offset = startOffset;
  return chunks.map((c) => {
    const entry = { coords: c.coords, offset, size: c.bytes.length };
    offset += c.bytes.length;
    return entry;
  });
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
