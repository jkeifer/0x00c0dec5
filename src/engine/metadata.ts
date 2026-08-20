import type { AppState, MetadataIncludeConfig } from '../types/state.ts';
import type { VariableStats } from '../types/pipeline.ts';
import { activeSteps, splitStructuredPrefix } from './codecs.ts';
import { encodeMetadataBinary, decodeMetadataBinary } from './metadataBinary.ts';

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
  schema: 'schema', logical_types: 'schema',
  shape: 'layout', chunk_shape: 'layout',
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
      // Row mode records BOTH halves of what actually ran: each variable's
      // structured prefix (applied per-variable before interleaving) and the
      // shared chunk pipeline. {chunk, fields} keys distinguish this from the
      // column-mode by-name object.
      const fields: Record<string, unknown> = {};
      for (const v of state.variables) {
        fields[v.name] = activeSteps(splitStructuredPrefix(state.fieldPipelines[v.id] ?? []).prefix);
      }
      entries.push({
        key: 'codec_pipelines',
        value: JSON.stringify({ chunk: activeSteps(state.chunkPipeline), fields }),
      });
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

  // type_assignments was deleted with the typeAssignment shrink: it would
  // duplicate schema's per-variable dtype (chunk_grid precedent — every entry
  // must be one the reader actually uses).

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

  // Custom entries: override-wins (spec §2). A custom key matching an existing
  // entry replaces its value in place — users can lie to the reader; the include
  // toggles already let them starve it. Duplicate custom keys: last wins.
  for (const entry of state.metadata.customEntries) {
    if (!entry.key) continue;
    const existing = entries.find((e) => e.key === entry.key);
    if (existing) existing.value = entry.value;
    else entries.push({ key: entry.key, value: entry.value });
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
 * Serialize metadata entries in the TIFF-flavored binary tag format
 * (`src/engine/metadataBinary.ts`): `[u16 count]` then per entry
 * `[u16 tag][u8 type][u32 payloadLen][payload]`. Registered keys encode as
 * their tag with a native, type-specific payload; unregistered keys use tag 0
 * and carry their key string inline. This is a thin delegation — the framing
 * and per-type encoders live in `metadataBinary.ts`.
 */
export function serializeMetadataBinary(entries: MetadataEntry[]): Uint8Array {
  return encodeMetadataBinary(entries);
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

/**
 * Deserialize binary metadata back to `MetadataEntry` strings. Delegates the
 * tag framing + per-type decode to `metadataBinary.ts` and drops the extra
 * `{tag, type, bytesConsumed}` fields the reader/locator use — parseStructure
 * only ever sees `{key, value}`. Strict: a malformed blob throws (surfaced as
 * corrupt-metadata by the locator).
 */
export function deserializeMetadataBinary(bytes: Uint8Array): MetadataEntry[] {
  return decodeMetadataBinary(bytes).entries.map(({ key, value }) => ({ key, value }));
}
