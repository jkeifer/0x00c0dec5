import type { AppState, MetadataIncludeConfig } from '../types/state.ts';
import type { VariableStats } from '../types/pipeline.ts';
import { computeChunkGrid } from './chunk.ts';
import { activeSteps } from './codecs.ts';

export interface MetadataEntry {
  key: string;
  value: string;
}

/**
 * Read plan Task 1: maps each auto-generated metadata key `collectMetadata`
 * can emit to the `MetadataIncludeConfig` group that gates it. `custom`
 * entries and `variable_statistics` gate on `descriptive` inline at their
 * push sites rather than through this map (they aren't fixed single keys).
 * `metadata_format` is an envelope key: always written, never gated (it
 * describes the metadata blob itself; parse-metadata needs it regardless of
 * which groups are on). `byte_order` is NOT an envelope key — it's gated by
 * its own `endianness` group (cl-8), whose absence is the silent-corruption
 * lesson (the reader assumes host order rather than failing).
 */
export const METADATA_KEY_GROUPS: Record<string, keyof MetadataIncludeConfig> = {
  schema: 'schema', type_assignments: 'schema', logical_types: 'schema',
  shape: 'layout', chunk_shape: 'layout', chunk_grid: 'layout',
  chunk_order: 'layout', partitioning: 'layout', interleaving: 'layout',
  linearization: 'layout',
  codec_pipelines: 'codecs',
  chunk_index: 'chunkIndex',
  variable_statistics: 'descriptive',
  byte_order: 'endianness',
};

/**
 * Collect all auto-generated metadata entries from the pipeline state.
 */
export interface ChunkIndexEntry {
  coords: number[];
  offset: number;
  size: number;
  variableName?: string;
}

export function collectMetadata(
  state: AppState,
  _encodedChunks: { coords: number[]; bytes: Uint8Array }[],
  variableStats?: Map<string, VariableStats>,
  chunkOffsets?: ChunkIndexEntry[],
): MetadataEntry[] {
  const entries: MetadataEntry[] = [];

  const include = state.metadata.include;

  // Schema — uses storageDtype for binary compatibility
  if (include.schema) {
    const schema = state.variables.map((v) => ({
      name: v.name,
      dtype: v.typeAssignment.storageDtype,
    }));
    entries.push({ key: 'schema', value: JSON.stringify(schema) });
  }

  // Shape
  if (include.layout) {
    entries.push({ key: 'shape', value: JSON.stringify(state.shape) });
  }

  // Chunk shape
  if (include.layout) {
    entries.push({ key: 'chunk_shape', value: JSON.stringify(state.chunkShape) });
  }

  // Chunk grid
  if (include.layout) {
    const chunkGrid = computeChunkGrid(state.shape, state.chunkShape);
    entries.push({ key: 'chunk_grid', value: JSON.stringify(chunkGrid) });
  }

  // Chunk index (byte offsets) — D3: user-facing toggle. When off, the reader
  // must compute offsets itself (possible only for size-preserving codec
  // pipelines); see 'no-chunk-index' in ReadFailureReason.
  if (chunkOffsets && include.chunkIndex) {
    entries.push({ key: 'chunk_index', value: JSON.stringify(chunkOffsets) });
  }

  // Chunk order (spatial ordering of chunks within the file/index)
  if (include.layout) {
    entries.push({ key: 'chunk_order', value: state.write.chunkOrder });
  }

  // Partitioning (single file vs one file per chunk)
  if (include.layout) {
    entries.push({ key: 'partitioning', value: state.write.partitioning });
  }

  // Codec pipelines. fieldPipelines is keyed by Variable.id (D5 — Phase 3.1),
  // but the file format keys codec_pipelines by variable NAME (the format
  // doesn't change); translate id -> name here, at the serialization boundary.
  if (include.codecs) {
    if (state.interleaving === 'column') {
      const byName: Record<string, unknown> = {};
      for (const v of state.variables) {
        // F31: only ACTIVE steps are written, so the read round-trip stays
        // honest — a step toggled off doesn't appear in the file, matching the
        // bytes the encoder actually produced.
        byName[v.name] = activeSteps(state.fieldPipelines[v.id] ?? []);
      }
      entries.push({ key: 'codec_pipelines', value: JSON.stringify(byName) });
    } else {
      entries.push({ key: 'codec_pipelines', value: JSON.stringify(activeSteps(state.chunkPipeline)) });
    }
  }

  // Interleaving
  if (include.layout) {
    entries.push({ key: 'interleaving', value: state.interleaving });
  }

  // Linearization order (cl-6). Only meaningful for the array model with
  // ndim>1 — the 1-D / tabular case is the identity for all three orders, so
  // emitting it would be noise (and old 1-D files never carried it). The
  // reader defaults to 'c' when the key is absent, so omitting it here for the
  // identity cases is byte-identical to the pre-cl-6 file.
  if (include.layout && state.dataModel === 'array' && state.shape.length > 1) {
    entries.push({ key: 'linearization', value: state.linearization });
  }

  // Type assignments (per-variable)
  if (include.schema) {
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
  }

  // Logical types (per-variable)
  if (include.schema) {
    const logicalTypes: Record<string, unknown> = {};
    for (const v of state.variables) {
      logicalTypes[v.name] = v.logicalType;
    }
    entries.push({ key: 'logical_types', value: JSON.stringify(logicalTypes) });
  }

  // Variable statistics. The stats map is keyed by Variable.id (S2 — stable
  // across renames), but the FILE format is name-oriented like every other
  // per-variable metadata entry, so resolve ids back to names here at the
  // serialization boundary.
  if (include.descriptive && variableStats && variableStats.size > 0) {
    const statsObj: Record<string, VariableStats> = {};
    for (const v of state.variables) {
      const stats = variableStats.get(v.id);
      if (stats) statsObj[v.name] = stats;
    }
    entries.push({ key: 'variable_statistics', value: JSON.stringify(statsObj) });
  }

  // Metadata format — envelope key: always written (describes the metadata
  // blob itself; parse-metadata needs it regardless of which groups are on).
  entries.push({ key: 'metadata_format', value: state.metadata.serialization });

  // Byte order — gated by its own `endianness` group (cl-8). When off, the
  // entry is omitted and the reader silently assumes host order (the
  // silent-corruption lesson) rather than failing a read step.
  if (include.endianness) {
    entries.push({ key: 'byte_order', value: state.byteOrder });
  }

  // Append custom entries, gated on `descriptive` (same group as
  // variable_statistics — both are "descriptive" content layered on top of
  // the structural self-description). DC-5: a custom entry whose key
  // collides with one of the auto-generated keys above would otherwise
  // silently shadow it once entries collapse into a key->value object at
  // serialization (last write wins), corrupting the file's self-description
  // (e.g. a custom `shape` key overwriting the real dataset shape).
  // Deterministically rename any colliding custom key to `user_<key>`
  // (re-prefixing again if the user's own key is literally already
  // `user_<autoKey>`, so the rename itself can never introduce a new
  // collision) — auto keys always win their name, and no information is
  // lost. MetadataEditor surfaces a warning on these rows.
  if (include.descriptive) {
    const autoKeys = new Set(entries.map((e) => e.key));
    for (const entry of state.metadata.customEntries) {
      if (entry.key) {
        entries.push({ key: dedupeCustomKey(entry.key, autoKeys), value: entry.value });
      }
    }
  }

  return entries;
}

/**
 * DC-5: rename `key` to avoid colliding with an auto-generated metadata key,
 * by prefixing `user_` repeatedly until it no longer collides with anything
 * already claimed (auto keys, or an earlier custom entry that already claimed
 * the prefixed name). Exported so `MetadataEditor` can show the same
 * resulting key in its collision warning.
 */
export function dedupeCustomKey(key: string, claimedKeys: Set<string>): string {
  let candidate = key;
  while (claimedKeys.has(candidate)) {
    candidate = `user_${candidate}`;
  }
  claimedKeys.add(candidate);
  return candidate;
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
