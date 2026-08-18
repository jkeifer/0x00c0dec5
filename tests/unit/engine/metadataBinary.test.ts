import { describe, it, expect } from 'vitest';
import {
  encodeMetadataBinary,
  decodeMetadataBinary,
  METADATA_TAGS,
  DTYPE_CODE_TABLE,
  TYPE_STRING,
  TYPE_U32_ARRAY,
  TYPE_ENUM,
  TYPE_CHUNK_INDEX,
  TYPE_SCHEMA,
} from '../../../src/engine/metadataBinary.ts';
import type { MetadataEntry } from '../../../src/engine/metadata.ts';
import { DTYPE_REGISTRY } from '../../../src/types/dtypes.ts';

// A hand-built set of entries exercising every native type + custom tag-0 keys,
// with value strings formatted exactly as collectMetadata emits them.
const chunkIndex = [
  { coords: [0, 0], offset: 0, size: 512 },
  { coords: [0, 1], offset: 512, size: 512, variableName: 'temperature' },
];
const schema = [
  { name: 'temperature', dtype: 'int16' },
  { name: 'station', dtype: 'char16' },
];
const fullEntries: MetadataEntry[] = [
  { key: 'schema', value: JSON.stringify(schema) },
  { key: 'shape', value: JSON.stringify([16, 16]) },
  { key: 'chunk_shape', value: JSON.stringify([8, 8]) },
  { key: 'chunk_index', value: JSON.stringify(chunkIndex) },
  { key: 'chunk_order', value: 'row-major' },
  { key: 'partitioning', value: 'per-chunk' },
  { key: 'codec_pipelines', value: JSON.stringify({ temperature: [] }) },
  { key: 'interleaving', value: 'column' },
  { key: 'linearization', value: 'morton' },
  { key: 'type_assignments', value: JSON.stringify({ temperature: { storageDtype: 'int16' } }) },
  { key: 'logical_types', value: JSON.stringify({ temperature: { type: 'integer' } }) },
  { key: 'variable_statistics', value: JSON.stringify({ temperature: { min: 0, max: 9 } }) },
  { key: 'metadata_format', value: 'binary' },
  { key: 'byte_order', value: 'big' },
  { key: 'crs', value: 'EPSG:4326' }, // custom → tag 0
];

describe('metadataBinary', () => {
  it('round-trips every native type to identical value strings', () => {
    const decoded = decodeMetadataBinary(encodeMetadataBinary(fullEntries));
    expect(decoded.entries.map(({ key, value }) => ({ key, value }))).toEqual(fullEntries);
  });

  it('assigns each key its native type on encode', () => {
    const decoded = decodeMetadataBinary(encodeMetadataBinary(fullEntries));
    const byKey = Object.fromEntries(decoded.entries.map((e) => [e.key, e]));
    expect(byKey.schema.type).toBe(TYPE_SCHEMA);
    expect(byKey.shape.type).toBe(TYPE_U32_ARRAY);
    expect(byKey.chunk_shape.type).toBe(TYPE_U32_ARRAY);
    expect(byKey.chunk_index.type).toBe(TYPE_CHUNK_INDEX);
    expect(byKey.chunk_order.type).toBe(TYPE_ENUM);
    expect(byKey.partitioning.type).toBe(TYPE_ENUM);
    expect(byKey.interleaving.type).toBe(TYPE_ENUM);
    expect(byKey.linearization.type).toBe(TYPE_ENUM);
    expect(byKey.metadata_format.type).toBe(TYPE_ENUM);
    expect(byKey.byte_order.type).toBe(TYPE_ENUM);
    expect(byKey.codec_pipelines.type).toBe(TYPE_STRING);
    expect(byKey.crs.type).toBe(TYPE_STRING);
    expect(byKey.crs.tag).toBe(0);
  });

  it('reports bytesConsumed even with trailing garbage', () => {
    const buf = encodeMetadataBinary(fullEntries);
    const padded = new Uint8Array([...buf, 1, 2, 3]);
    expect(decodeMetadataBinary(padded).bytesConsumed).toBe(buf.length);
  });

  it('lie fallback: enum key with non-enum value encodes as string and round-trips', () => {
    const decoded = decodeMetadataBinary(
      encodeMetadataBinary([{ key: 'interleaving', value: 'banana' }]),
    );
    expect(decoded.entries[0]).toMatchObject({
      key: 'interleaving',
      value: 'banana',
      type: TYPE_STRING,
    });
  });

  it('lie fallback: shape with non-array / out-of-range values falls back to string', () => {
    for (const value of ['not json', '[1,-2]', '[1.5]', '[4294967296]', '{}']) {
      const decoded = decodeMetadataBinary(encodeMetadataBinary([{ key: 'shape', value }]));
      expect(decoded.entries[0]).toMatchObject({ key: 'shape', value, type: TYPE_STRING });
    }
  });

  it('lie fallback: malformed chunk_index and schema fall back to string', () => {
    const badChunkIndex = JSON.stringify([
      { coords: [0], offset: 0, size: 1 },
      { coords: [0, 0], offset: 1, size: 1 }, // non-uniform ndim
    ]);
    const badSchema = JSON.stringify([{ name: 'x', dtype: 'not-a-dtype' }]);
    const dCi = decodeMetadataBinary(encodeMetadataBinary([{ key: 'chunk_index', value: badChunkIndex }]));
    const dSc = decodeMetadataBinary(encodeMetadataBinary([{ key: 'schema', value: badSchema }]));
    expect(dCi.entries[0]).toMatchObject({ value: badChunkIndex, type: TYPE_STRING });
    expect(dSc.entries[0]).toMatchObject({ value: badSchema, type: TYPE_STRING });
  });

  it('custom keys use tag 0 and round-trip', () => {
    const decoded = decodeMetadataBinary(
      encodeMetadataBinary([{ key: 'crs', value: 'EPSG:4326' }]),
    );
    expect(decoded.entries[0]).toMatchObject({
      key: 'crs',
      value: 'EPSG:4326',
      tag: 0,
      type: TYPE_STRING,
    });
  });

  it('key names are absent from the bytes for registered tags', () => {
    const buf = encodeMetadataBinary([{ key: 'shape', value: '[16,16]' }]);
    expect(new TextDecoder().decode(buf).includes('shape')).toBe(false);
  });

  it('throws on unknown tag', () => {
    const buf = encodeMetadataBinary([{ key: 'shape', value: '[1,2]' }]);
    const view = new DataView(buf.buffer);
    view.setUint16(2, 9999, true); // clobber tag
    expect(() => decodeMetadataBinary(buf)).toThrow();
  });

  it('throws on unknown type code', () => {
    const buf = encodeMetadataBinary([{ key: 'shape', value: '[1,2]' }]);
    buf[4] = 250; // type byte at [u16 count][u16 tag] = offset 4
    expect(() => decodeMetadataBinary(buf)).toThrow();
  });

  it('throws on out-of-range enum code', () => {
    const buf = encodeMetadataBinary([{ key: 'interleaving', value: 'row' }]);
    // count(2) tag(2) type(1) payloadLen(4) payload(1) => enum code at offset 9
    buf[buf.length - 1] = 200;
    expect(() => decodeMetadataBinary(buf)).toThrow();
  });

  it('throws on enum type for a tag-0 / unknown-table key', () => {
    // custom key 'crs' encoded normally as tag 0/string, then poke type to enum
    const buf = encodeMetadataBinary([{ key: 'crs', value: 'x' }]);
    buf[4] = TYPE_ENUM;
    expect(() => decodeMetadataBinary(buf)).toThrow();
  });

  it('throws on truncation', () => {
    const buf = encodeMetadataBinary(fullEntries);
    expect(() => decodeMetadataBinary(buf.slice(0, buf.length - 5))).toThrow();
  });

  it('every DtypeKey has a dtype code', () => {
    const keys = Object.keys(DTYPE_REGISTRY);
    expect(DTYPE_CODE_TABLE.length).toBe(keys.length);
    expect([...DTYPE_CODE_TABLE].sort()).toEqual([...keys].sort());
    // round-trip a schema referencing every dtype
    const everySchema = keys.map((k, i) => ({ name: `v${i}`, dtype: k }));
    const value = JSON.stringify(everySchema);
    const decoded = decodeMetadataBinary(encodeMetadataBinary([{ key: 'schema', value }]));
    expect(decoded.entries[0]).toMatchObject({ value, type: TYPE_SCHEMA });
  });

  it('METADATA_TAGS matches the spec tag numbers', () => {
    expect(METADATA_TAGS).toMatchObject({
      schema: 1, shape: 2, chunk_shape: 3, chunk_order: 4, partitioning: 5,
      interleaving: 6, linearization: 7, codec_pipelines: 8, chunk_index: 9,
      type_assignments: 10, logical_types: 11, variable_statistics: 12,
      metadata_format: 13, byte_order: 14,
    });
  });

  it('empty entry list round-trips', () => {
    const decoded = decodeMetadataBinary(encodeMetadataBinary([]));
    expect(decoded.entries).toEqual([]);
    expect(decoded.bytesConsumed).toBe(2);
  });

  it('variableName present only when non-empty in chunk_index re-stringify', () => {
    const value = JSON.stringify([
      { coords: [0], offset: 0, size: 4, variableName: 'a' },
      { coords: [1], offset: 4, size: 4 },
    ]);
    const decoded = decodeMetadataBinary(encodeMetadataBinary([{ key: 'chunk_index', value }]));
    expect(decoded.entries[0]).toMatchObject({ value, type: TYPE_CHUNK_INDEX });
  });
});
