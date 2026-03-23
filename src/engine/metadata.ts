import type { AppState } from '../types/state.ts';
import type { VariableStats } from '../types/pipeline.ts';
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
  variableStats?: Map<string, VariableStats>,
  chunkOffsets?: { coords: number[]; offset: number; size: number }[],
): MetadataEntry[] {
  const entries: MetadataEntry[] = [];

  // Schema — uses storageDtype for binary compatibility
  const schema = state.variables.map((v) => ({
    name: v.name,
    dtype: v.typeAssignment.storageDtype,
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

  // Interleaving
  entries.push({ key: 'interleaving', value: state.interleaving });

  // Type assignments (per-variable)
  const typeAssignments: Record<string, { storageDtype: string; scale?: number; offset?: number; keepBits?: number }> = {};
  for (const v of state.variables) {
    typeAssignments[v.name] = {
      storageDtype: v.typeAssignment.storageDtype,
      ...(v.typeAssignment.scale !== undefined && v.typeAssignment.scale !== 1 ? { scale: v.typeAssignment.scale } : {}),
      ...(v.typeAssignment.offset !== undefined && v.typeAssignment.offset !== 0 ? { offset: v.typeAssignment.offset } : {}),
      ...(v.typeAssignment.keepBits !== undefined ? { keepBits: v.typeAssignment.keepBits } : {}),
    };
  }
  entries.push({ key: 'type_assignments', value: JSON.stringify(typeAssignments) });

  // Logical types (per-variable)
  const logicalTypes: Record<string, unknown> = {};
  for (const v of state.variables) {
    logicalTypes[v.name] = v.logicalType;
  }
  entries.push({ key: 'logical_types', value: JSON.stringify(logicalTypes) });

  // Variable statistics
  if (variableStats && variableStats.size > 0) {
    const statsObj: Record<string, VariableStats> = {};
    for (const [name, stats] of variableStats) {
      statsObj[name] = stats;
    }
    entries.push({ key: 'variable_statistics', value: JSON.stringify(statsObj) });
  }

  // Metadata format
  entries.push({ key: 'metadata_format', value: state.metadata.serialization });

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

/** Deserialize JSON metadata back to entries. */
export function deserializeMetadataJSON(bytes: Uint8Array): MetadataEntry[] {
  const text = new TextDecoder().decode(bytes);
  const obj = JSON.parse(text) as Record<string, string>;
  return Object.entries(obj).map(([key, value]) => ({ key, value }));
}

/**
 * Auto-detect format and deserialize metadata.
 * If bytes start with 0x7B (`{`), treat as JSON; otherwise binary.
 */
export function deserializeMetadata(bytes: Uint8Array): MetadataEntry[] {
  if (bytes.length === 0) return [];
  if (bytes[0] === 0x7b) {
    return deserializeMetadataJSON(bytes);
  }
  return deserializeMetadataBinary(bytes);
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
