import type { AppState } from '../types/state.ts';
import { computeChunkGrid } from './chunk.ts';

export interface MetadataEntry {
  key: string;
  value: string;
}

/**
 * Collect all auto-generated metadata entries from the pipeline state.
 */
export function collectMetadata(
  state: AppState,
  _encodedChunks: { coords: number[]; bytes: Uint8Array }[],
  chunkOffsets?: { coords: number[]; offset: number; size: number }[],
): MetadataEntry[] {
  const entries: MetadataEntry[] = [];

  // Schema
  const schema = state.variables.map((v) => ({
    name: v.name,
    dtype: v.dtype,
  }));
  entries.push({ key: 'schema', value: JSON.stringify(schema) });

  // Shape
  entries.push({ key: 'shape', value: JSON.stringify(state.shape) });

  // Chunk shape
  entries.push({ key: 'chunk_shape', value: JSON.stringify(state.chunkShape) });

  // Chunk grid
  const chunkGrid = computeChunkGrid(state.shape, state.chunkShape);
  entries.push({ key: 'chunk_grid', value: JSON.stringify(chunkGrid) });

  // Chunk index (byte offsets)
  if (chunkOffsets) {
    entries.push({ key: 'chunk_index', value: JSON.stringify(chunkOffsets) });
  }

  // Codec pipelines
  if (state.interleaving === 'column') {
    entries.push({ key: 'codec_pipelines', value: JSON.stringify(state.fieldPipelines) });
  } else {
    entries.push({ key: 'codec_pipelines', value: JSON.stringify(state.chunkPipeline) });
  }

  // Byte order
  entries.push({ key: 'byte_order', value: 'little' });

  // Append custom entries
  for (const entry of state.metadata.customEntries) {
    if (entry.key) {
      entries.push({ key: entry.key, value: entry.value });
    }
  }

  return entries;
}

/** Serialize metadata entries as pretty-printed JSON → UTF-8 bytes. */
export function serializeMetadataJSON(entries: MetadataEntry[]): Uint8Array {
  const obj: Record<string, string> = {};
  for (const e of entries) {
    obj[e.key] = e.value;
  }
  const json = JSON.stringify(obj, null, 2);
  return new TextEncoder().encode(json);
}

/**
 * Serialize metadata entries in a binary length-prefixed format:
 * [4B entry count (uint32 LE)]
 * For each entry:
 *   [4B key length (uint32 LE)][key bytes UTF-8]
 *   [4B value length (uint32 LE)][value bytes UTF-8]
 */
export function serializeMetadataBinary(entries: MetadataEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];

  // Entry count
  const countBuf = new ArrayBuffer(4);
  new DataView(countBuf).setUint32(0, entries.length, true);
  parts.push(new Uint8Array(countBuf));

  for (const entry of entries) {
    const keyBytes = encoder.encode(entry.key);
    const valueBytes = encoder.encode(entry.value);

    // Key length + key
    const keyLenBuf = new ArrayBuffer(4);
    new DataView(keyLenBuf).setUint32(0, keyBytes.length, true);
    parts.push(new Uint8Array(keyLenBuf));
    parts.push(keyBytes);

    // Value length + value
    const valueLenBuf = new ArrayBuffer(4);
    new DataView(valueLenBuf).setUint32(0, valueBytes.length, true);
    parts.push(new Uint8Array(valueLenBuf));
    parts.push(valueBytes);
  }

  const totalLength = parts.reduce((acc, p) => acc + p.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result;
}

/** Serialize metadata using the configured format. */
export function serializeMetadata(
  entries: MetadataEntry[],
  format: 'json' | 'binary',
): Uint8Array {
  if (format === 'binary') {
    return serializeMetadataBinary(entries);
  }
  return serializeMetadataJSON(entries);
}

/** Deserialize binary metadata back to entries (for testing roundtrip). */
export function deserializeMetadataBinary(bytes: Uint8Array): MetadataEntry[] {
  const decoder = new TextDecoder();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let offset = 0;
  const count = view.getUint32(offset, true);
  offset += 4;

  const entries: MetadataEntry[] = [];
  for (let i = 0; i < count; i++) {
    const keyLen = view.getUint32(offset, true);
    offset += 4;
    const key = decoder.decode(bytes.slice(offset, offset + keyLen));
    offset += keyLen;

    const valueLen = view.getUint32(offset, true);
    offset += 4;
    const value = decoder.decode(bytes.slice(offset, offset + valueLen));
    offset += valueLen;

    entries.push({ key, value });
  }

  return entries;
}
