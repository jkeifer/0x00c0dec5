import { describe, it, expect } from 'vitest';
import {
  collectMetadata,
  serializeMetadataJSON,
  serializeMetadataBinary,
  serializeMetadata,
  deserializeMetadataBinary,
} from '../../engine/metadata.ts';
import type { MetadataEntry } from '../../engine/metadata.ts';
import { DEFAULT_STATE } from '../../types/state.ts';

describe('serializeMetadataJSON', () => {
  it('produces valid JSON bytes', () => {
    const entries: MetadataEntry[] = [
      { key: 'shape', value: '[32]' },
      { key: 'order', value: 'little' },
    ];
    const bytes = serializeMetadataJSON(entries);
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text);
    expect(parsed.shape).toBe('[32]');
    expect(parsed.order).toBe('little');
  });

  it('roundtrips through JSON parse', () => {
    const entries: MetadataEntry[] = [
      { key: 'a', value: 'hello' },
      { key: 'b', value: '42' },
    ];
    const bytes = serializeMetadataJSON(entries);
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text);
    expect(parsed.a).toBe('hello');
    expect(parsed.b).toBe('42');
  });

  it('handles empty entries', () => {
    const bytes = serializeMetadataJSON([]);
    const text = new TextDecoder().decode(bytes);
    expect(JSON.parse(text)).toEqual({});
  });

  it('handles unicode', () => {
    const entries: MetadataEntry[] = [
      { key: 'crs', value: 'WGS 84 — EPSG:4326' },
    ];
    const bytes = serializeMetadataJSON(entries);
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text);
    expect(parsed.crs).toBe('WGS 84 — EPSG:4326');
  });
});

describe('serializeMetadataBinary / deserializeMetadataBinary roundtrip', () => {
  it('roundtrips basic entries', () => {
    const entries: MetadataEntry[] = [
      { key: 'shape', value: '[32]' },
      { key: 'dtype', value: 'float32' },
    ];
    const bytes = serializeMetadataBinary(entries);
    const result = deserializeMetadataBinary(bytes);
    expect(result).toEqual(entries);
  });

  it('roundtrips empty entries', () => {
    const entries: MetadataEntry[] = [];
    const bytes = serializeMetadataBinary(entries);
    const result = deserializeMetadataBinary(bytes);
    expect(result).toEqual([]);
  });

  it('roundtrips unicode values', () => {
    const entries: MetadataEntry[] = [
      { key: 'name', value: '日本語テスト' },
      { key: 'emoji', value: '🌍📊' },
    ];
    const bytes = serializeMetadataBinary(entries);
    const result = deserializeMetadataBinary(bytes);
    expect(result).toEqual(entries);
  });

  it('starts with entry count as uint32 LE', () => {
    const entries: MetadataEntry[] = [
      { key: 'a', value: 'b' },
      { key: 'c', value: 'd' },
    ];
    const bytes = serializeMetadataBinary(entries);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(0, true)).toBe(2);
  });
});

describe('serializeMetadata', () => {
  it('dispatches to JSON format', () => {
    const entries: MetadataEntry[] = [{ key: 'x', value: 'y' }];
    const bytes = serializeMetadata(entries, 'json');
    const text = new TextDecoder().decode(bytes);
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it('dispatches to binary format', () => {
    const entries: MetadataEntry[] = [{ key: 'x', value: 'y' }];
    const bytes = serializeMetadata(entries, 'binary');
    const result = deserializeMetadataBinary(bytes);
    expect(result).toEqual(entries);
  });
});

describe('collectMetadata', () => {
  it('includes all auto-collected keys', () => {
    const entries = collectMetadata(DEFAULT_STATE, []);
    const keys = entries.map((e) => e.key);
    expect(keys).toContain('schema');
    expect(keys).toContain('shape');
    expect(keys).toContain('chunk_shape');
    expect(keys).toContain('chunk_grid');
    expect(keys).toContain('codec_pipelines');
    expect(keys).toContain('byte_order');
  });

  it('includes custom entries', () => {
    const state = {
      ...DEFAULT_STATE,
      metadata: {
        ...DEFAULT_STATE.metadata,
        customEntries: [
          { key: 'crs', value: 'EPSG:4326' },
          { key: 'transform', value: '[1,0,0,0,-1,90]' },
        ],
      },
    };
    const entries = collectMetadata(state, []);
    const keys = entries.map((e) => e.key);
    expect(keys).toContain('crs');
    expect(keys).toContain('transform');
  });

  it('includes chunk index when provided', () => {
    const offsets = [{ coords: [0], offset: 4, size: 128 }];
    const entries = collectMetadata(DEFAULT_STATE, [], offsets);
    const keys = entries.map((e) => e.key);
    expect(keys).toContain('chunk_index');
  });

  it('sets byte_order to little', () => {
    const entries = collectMetadata(DEFAULT_STATE, []);
    const byteOrder = entries.find((e) => e.key === 'byte_order');
    expect(byteOrder?.value).toBe('little');
  });

  it('skips custom entries with empty keys', () => {
    const state = {
      ...DEFAULT_STATE,
      metadata: {
        ...DEFAULT_STATE.metadata,
        customEntries: [
          { key: '', value: 'should be skipped' },
          { key: 'valid', value: 'included' },
        ],
      },
    };
    const entries = collectMetadata(state, []);
    const keys = entries.map((e) => e.key);
    expect(keys).not.toContain('');
    expect(keys).toContain('valid');
  });
});
