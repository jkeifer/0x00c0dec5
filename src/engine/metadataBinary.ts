import type { MetadataEntry } from './metadata.ts';
import type { DtypeKey } from '../types/dtypes.ts';

/**
 * TIFF-flavored binary tag serialization for metadata entries.
 *
 * Wire format (all integers little-endian, fixed width):
 *   [u16 count]
 *   per entry: [u16 tag][u8 type][u32 payloadLen][payload]
 *
 * A registered key encodes as its tag with the value in a native, type-specific
 * payload; the key string never appears in the bytes. An unregistered ("custom")
 * key uses tag 0, whose payload is [u16 keyLen][key utf8][value bytes] so the
 * key travels with it. The type byte is authoritative on decode: whenever a
 * value doesn't parse/fit its key's native type at encode time we fall back to
 * TYPE_STRING (users can lie to the reader — the lie must still serialize).
 *
 * This is a self-contained module: a later task wires it into metadata.ts /
 * readLocate.ts. Do not import it there yet.
 */

// --- Tags (Task 7 consumes these exact numbers) -----------------------------

export const METADATA_TAGS: Record<string, number> = {
  schema: 1,
  shape: 2,
  chunk_shape: 3,
  chunk_order: 4,
  partitioning: 5,
  interleaving: 6,
  linearization: 7,
  codec_pipelines: 8,
  chunk_index: 9,
  type_assignments: 10,
  logical_types: 11,
  variable_statistics: 12,
  metadata_format: 13,
  byte_order: 14,
};

const TAG_TO_KEY: Record<number, string> = Object.fromEntries(
  Object.entries(METADATA_TAGS).map(([k, t]) => [t, k]),
);

// --- Type codes -------------------------------------------------------------

export const TYPE_STRING = 0;
export const TYPE_U32_ARRAY = 1;
export const TYPE_ENUM = 2;
export const TYPE_CHUNK_INDEX = 3;
export const TYPE_SCHEMA = 4;

// --- Enum tables (order IS the spec — never reorder) ------------------------

const ENUM_TABLES: Record<string, string[]> = {
  chunk_order: ['row-major', 'column-major'],
  partitioning: ['single', 'per-chunk'],
  interleaving: ['column', 'row'],
  linearization: ['c', 'fortran', 'morton'],
  byte_order: ['little', 'big'],
  metadata_format: ['json', 'binary'],
};

// --- Dtype code table -------------------------------------------------------
// Hardcoded literal (index = code). Stability is the point: do not derive from
// Object.keys at runtime. A test pins this against the real DtypeKey set.
export const DTYPE_CODE_TABLE: DtypeKey[] = [
  'int8',
  'uint8',
  'int16',
  'uint16',
  'int32',
  'uint32',
  'float32',
  'float64',
  'char4',
  'char8',
  'char16',
];

export interface BinaryDecodedEntry {
  key: string;
  value: string;
  tag: number;
  type: number;
}

const U32_MAX = 0xffffffff;

function isU32(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= U32_MAX;
}

// --- Native payload encoders. Each returns bytes, or null to fall back. -----

function encodeU32Array(value: string): Uint8Array | null {
  let arr: unknown;
  try {
    arr = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(arr) || !arr.every(isU32)) return null;
  const buf = new ArrayBuffer(arr.length * 4);
  const view = new DataView(buf);
  arr.forEach((n, i) => view.setUint32(i * 4, n as number, true));
  return new Uint8Array(buf);
}

function encodeChunkIndex(value: string): Uint8Array | null {
  let arr: unknown;
  try {
    arr = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const encoder = new TextEncoder();
  const ndim = Array.isArray((arr[0] as { coords?: unknown })?.coords)
    ? (arr[0] as { coords: unknown[] }).coords.length
    : -1;
  if (ndim < 0) return null;

  const nameBytes: Uint8Array[] = [];
  for (const raw of arr) {
    const e = raw as { coords?: unknown; offset?: unknown; size?: unknown; variableName?: unknown };
    if (!Array.isArray(e.coords) || e.coords.length !== ndim) return null;
    if (!e.coords.every(isU32) || !isU32(e.offset) || !isU32(e.size)) return null;
    const name = e.variableName === undefined ? '' : e.variableName;
    if (typeof name !== 'string') return null;
    const nb = encoder.encode(name);
    if (nb.length > 255) return null;
    nameBytes.push(nb);
  }

  // [u8 ndim][u32 entryCount] then per entry [u32×ndim coords][u32 offset][u32 size][u8 nameLen][name]
  let total = 1 + 4;
  for (const nb of nameBytes) total += ndim * 4 + 4 + 4 + 1 + nb.length;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const out = new Uint8Array(buf);
  let o = 0;
  view.setUint8(o, ndim); o += 1;
  view.setUint32(o, arr.length, true); o += 4;
  arr.forEach((raw, i) => {
    const e = raw as { coords: number[]; offset: number; size: number };
    for (const c of e.coords) { view.setUint32(o, c, true); o += 4; }
    view.setUint32(o, e.offset, true); o += 4;
    view.setUint32(o, e.size, true); o += 4;
    const nb = nameBytes[i];
    view.setUint8(o, nb.length); o += 1;
    out.set(nb, o); o += nb.length;
  });
  return out;
}

function encodeSchema(value: string): Uint8Array | null {
  let arr: unknown;
  try {
    arr = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  const encoder = new TextEncoder();
  const rows: { nameBytes: Uint8Array; code: number }[] = [];
  for (const raw of arr) {
    const v = raw as { name?: unknown; dtype?: unknown };
    if (typeof v.name !== 'string' || typeof v.dtype !== 'string') return null;
    const code = DTYPE_CODE_TABLE.indexOf(v.dtype as DtypeKey);
    if (code < 0) return null;
    const nameBytes = encoder.encode(v.name);
    if (nameBytes.length > 255) return null;
    rows.push({ nameBytes, code });
  }
  // [u16 varCount] per var [u8 nameLen][name][u8 dtypeCode]
  let total = 2;
  for (const r of rows) total += 1 + r.nameBytes.length + 1;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const out = new Uint8Array(buf);
  let o = 0;
  view.setUint16(o, rows.length, true); o += 2;
  for (const r of rows) {
    view.setUint8(o, r.nameBytes.length); o += 1;
    out.set(r.nameBytes, o); o += r.nameBytes.length;
    view.setUint8(o, r.code); o += 1;
  }
  return out;
}

/** Pick the native (type, payload) for a registered key; null → use string. */
function encodeNativePayload(key: string, value: string): { type: number; payload: Uint8Array } | null {
  const enumTable = ENUM_TABLES[key];
  if (enumTable) {
    const code = enumTable.indexOf(value);
    if (code < 0) return null;
    return { type: TYPE_ENUM, payload: new Uint8Array([code]) };
  }
  if (key === 'shape' || key === 'chunk_shape') {
    const payload = encodeU32Array(value);
    return payload ? { type: TYPE_U32_ARRAY, payload } : null;
  }
  if (key === 'chunk_index') {
    const payload = encodeChunkIndex(value);
    return payload ? { type: TYPE_CHUNK_INDEX, payload } : null;
  }
  if (key === 'schema') {
    const payload = encodeSchema(value);
    return payload ? { type: TYPE_SCHEMA, payload } : null;
  }
  return null;
}

// --- Encode -----------------------------------------------------------------

export function encodeMetadataBinary(entries: MetadataEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];

  const countBuf = new ArrayBuffer(2);
  new DataView(countBuf).setUint16(0, entries.length, true);
  parts.push(new Uint8Array(countBuf));

  for (const entry of entries) {
    const tag = METADATA_TAGS[entry.key] ?? 0;

    let type = TYPE_STRING;
    let payload: Uint8Array;

    if (tag === 0) {
      // Custom key: [u16 keyLen][key utf8][value bytes]
      const keyBytes = encoder.encode(entry.key);
      const valueBytes = encoder.encode(entry.value);
      const buf = new Uint8Array(2 + keyBytes.length + valueBytes.length);
      new DataView(buf.buffer).setUint16(0, keyBytes.length, true);
      buf.set(keyBytes, 2);
      buf.set(valueBytes, 2 + keyBytes.length);
      payload = buf;
    } else {
      const native = encodeNativePayload(entry.key, entry.value);
      if (native) {
        type = native.type;
        payload = native.payload;
      } else {
        payload = encoder.encode(entry.value);
      }
    }

    const header = new ArrayBuffer(2 + 1 + 4);
    const hv = new DataView(header);
    hv.setUint16(0, tag, true);
    hv.setUint8(2, type);
    hv.setUint32(3, payload.length, true);
    parts.push(new Uint8Array(header));
    parts.push(payload);
  }

  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result;
}

// --- Native payload decoders (re-stringify exactly as collectMetadata) ------

function decodeU32Array(view: DataView, start: number, len: number): string {
  if (len % 4 !== 0) throw new Error('metadataBinary: u32 array payload not a multiple of 4');
  const arr: number[] = [];
  for (let o = 0; o < len; o += 4) arr.push(view.getUint32(start + o, true));
  return JSON.stringify(arr);
}

function decodeChunkIndex(view: DataView, start: number, len: number): string {
  const end = start + len;
  let o = start;
  if (o + 5 > end) throw new Error('metadataBinary: truncated chunk_index header');
  const ndim = view.getUint8(o); o += 1;
  const count = view.getUint32(o, true); o += 4;
  const decoder = new TextDecoder();
  const entries: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) {
    if (o + ndim * 4 + 8 + 1 > end) throw new Error('metadataBinary: truncated chunk_index entry');
    const coords: number[] = [];
    for (let d = 0; d < ndim; d++) { coords.push(view.getUint32(o, true)); o += 4; }
    const offset = view.getUint32(o, true); o += 4;
    const size = view.getUint32(o, true); o += 4;
    const nameLen = view.getUint8(o); o += 1;
    if (o + nameLen > end) throw new Error('metadataBinary: truncated chunk_index name');
    const variableName = decoder.decode(new Uint8Array(view.buffer, view.byteOffset + o, nameLen));
    o += nameLen;
    // Build in key order coords, offset, size, then variableName only when set.
    const e: Record<string, unknown> = { coords, offset, size };
    if (nameLen > 0) e.variableName = variableName;
    entries.push(e);
  }
  return JSON.stringify(entries);
}

function decodeSchema(view: DataView, start: number, len: number): string {
  const end = start + len;
  let o = start;
  if (o + 2 > end) throw new Error('metadataBinary: truncated schema header');
  const count = view.getUint16(o, true); o += 2;
  const decoder = new TextDecoder();
  const rows: { name: string; dtype: string }[] = [];
  for (let i = 0; i < count; i++) {
    if (o + 1 > end) throw new Error('metadataBinary: truncated schema name length');
    const nameLen = view.getUint8(o); o += 1;
    if (o + nameLen + 1 > end) throw new Error('metadataBinary: truncated schema row');
    const name = decoder.decode(new Uint8Array(view.buffer, view.byteOffset + o, nameLen));
    o += nameLen;
    const code = view.getUint8(o); o += 1;
    const dtype = DTYPE_CODE_TABLE[code];
    if (dtype === undefined) throw new Error(`metadataBinary: unknown dtype code ${code}`);
    rows.push({ name, dtype });
  }
  return JSON.stringify(rows);
}

// --- Decode -----------------------------------------------------------------

export function decodeMetadataBinary(bytes: Uint8Array): {
  entries: BinaryDecodedEntry[];
  bytesConsumed: number;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();

  const need = (n: number, o: number) => {
    if (o + n > bytes.length) throw new Error('metadataBinary: truncated input');
  };

  let o = 0;
  need(2, o);
  const count = view.getUint16(o, true); o += 2;

  const entries: BinaryDecodedEntry[] = [];
  for (let i = 0; i < count; i++) {
    need(2 + 1 + 4, o);
    const tag = view.getUint16(o, true); o += 2;
    const type = view.getUint8(o); o += 1;
    const payloadLen = view.getUint32(o, true); o += 4;
    need(payloadLen, o);
    const payloadStart = o;
    o += payloadLen;

    if (tag !== 0 && TAG_TO_KEY[tag] === undefined) {
      throw new Error(`metadataBinary: unknown tag ${tag}`);
    }

    let key: string;
    let value: string;

    if (tag === 0) {
      // [u16 keyLen][key utf8][value bytes]
      if (payloadLen < 2) throw new Error('metadataBinary: truncated custom key');
      const keyLen = view.getUint16(payloadStart, true);
      if (2 + keyLen > payloadLen) throw new Error('metadataBinary: truncated custom key');
      key = decoder.decode(new Uint8Array(bytes.buffer, bytes.byteOffset + payloadStart + 2, keyLen));
      const valStart = payloadStart + 2 + keyLen;
      value = decoder.decode(
        new Uint8Array(bytes.buffer, bytes.byteOffset + valStart, payloadLen - 2 - keyLen),
      );
      // A tag-0 key has no enum table; an enum type on it is corrupt.
      if (type === TYPE_ENUM) throw new Error('metadataBinary: enum type on unregistered key');
    } else {
      key = TAG_TO_KEY[tag];
      switch (type) {
        case TYPE_STRING:
          value = decoder.decode(
            new Uint8Array(bytes.buffer, bytes.byteOffset + payloadStart, payloadLen),
          );
          break;
        case TYPE_U32_ARRAY:
          value = decodeU32Array(view, payloadStart, payloadLen);
          break;
        case TYPE_ENUM: {
          const table = ENUM_TABLES[key];
          if (!table) throw new Error(`metadataBinary: enum type on non-enum key ${key}`);
          if (payloadLen < 1) throw new Error('metadataBinary: truncated enum');
          const code = view.getUint8(payloadStart);
          if (code >= table.length) throw new Error(`metadataBinary: enum code ${code} out of range for ${key}`);
          value = table[code];
          break;
        }
        case TYPE_CHUNK_INDEX:
          value = decodeChunkIndex(view, payloadStart, payloadLen);
          break;
        case TYPE_SCHEMA:
          value = decodeSchema(view, payloadStart, payloadLen);
          break;
        default:
          throw new Error(`metadataBinary: unknown type code ${type}`);
      }
    }

    entries.push({ key, value, tag, type });
  }

  // Tolerate trailing garbage: bytesConsumed is the end of the last record.
  return { entries, bytesConsumed: o };
}
