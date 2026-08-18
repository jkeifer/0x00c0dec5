import { describe, it, expect } from 'vitest';
import {
  collectMetadata,
  serializeMetadataJSON,
  serializeMetadataBinary,
  serializeMetadata,
  deserializeMetadataBinary,
  deserializeMetadataJSON,
  deserializeMetadata,
} from '../../../src/engine/metadata.ts';
import type { MetadataEntry } from '../../../src/engine/metadata.ts';
import { DEFAULT_STATE } from '../../../src/types/state.ts';

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

  it('starts with entry count as uint16 LE (TIFF-flavored tag framing)', () => {
    const entries: MetadataEntry[] = [
      { key: 'a', value: 'b' },
      { key: 'c', value: 'd' },
    ];
    const bytes = serializeMetadataBinary(entries);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint16(0, true)).toBe(2);
  });
});

// Task 6 carry-forward: the deferred equivalence pin. Drive GENUINE
// collectMetadata output — a fully-loaded state (every include group on, array
// model so `linearization` emits, column interleaving, custom entries, a real
// chunk index and real per-variable stats) — through
// encode/decodeMetadataBinary and assert exact {key,value} equality. This is
// the round-trip the hand-built metadataBinary.test.ts fixtures approximate;
// here every entry string is exactly what the production serializer emits.
describe('collectMetadata → binary encode/decode equivalence (Task 6 pin)', () => {
  it('round-trips a fully-loaded state to identical {key,value} entries', () => {
    const base = {
      ...DEFAULT_STATE,
      dataModel: 'array' as const,
      shape: [4, 4],
      chunkShape: [2, 2],
      linearization: 'morton' as const,
      byteOrder: 'big' as const,
      interleaving: 'column' as const,
      metadata: {
        ...DEFAULT_STATE.metadata,
        enabled: true,
        serialization: 'binary' as const,
        include: { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true, endianness: true },
        customEntries: [
          { key: 'crs', value: 'EPSG:4326' },
          { key: 'shape', value: '[999,999]' }, // override-wins over the auto shape entry
        ],
      },
    };
    // Real chunk index (one entry per 2×2 chunk of a 4×4 array).
    const chunkOffsets = [
      { coords: [0, 0], offset: 4, size: 64, variableName: base.variables[0].name },
      { coords: [0, 1], offset: 68, size: 64 },
      { coords: [1, 0], offset: 132, size: 64 },
      { coords: [1, 1], offset: 196, size: 64 },
    ];
    // Real per-variable stats keyed by Variable.id (as the pipeline emits them).
    const stats = new Map(
      base.variables.map((v, i) => [
        v.id,
        { min: i, max: i + 9, mean: i + 4.5, count: 16, clipped: 0, rounded: 2, isLossy: true, nanCount: 0 },
      ]),
    );

    const entries = collectMetadata(base, [], stats, chunkOffsets);
    // Sanity: the genuine collector really did emit the exotic keys.
    const keys = entries.map((e) => e.key);
    for (const k of ['schema', 'linearization', 'chunk_index', 'variable_statistics', 'byte_order', 'metadata_format', 'crs']) {
      expect(keys).toContain(k);
    }
    // Override-wins: exactly one `shape`, and it's the custom value.
    expect(entries.filter((e) => e.key === 'shape')).toEqual([{ key: 'shape', value: '[999,999]' }]);

    const decoded = deserializeMetadataBinary(serializeMetadataBinary(entries));
    expect(decoded).toEqual(entries);
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

describe('deserializeMetadataJSON', () => {
  it('roundtrips JSON entries', () => {
    const entries: MetadataEntry[] = [
      { key: 'shape', value: '[32]' },
      { key: 'order', value: 'little' },
    ];
    const bytes = serializeMetadataJSON(entries);
    const result = deserializeMetadataJSON(bytes);
    expect(result).toEqual(entries);
  });

  it('handles empty entries', () => {
    const bytes = serializeMetadataJSON([]);
    const result = deserializeMetadataJSON(bytes);
    expect(result).toEqual([]);
  });
});

describe('deserializeMetadata (auto-detect)', () => {
  it('detects JSON format (starts with {)', () => {
    const entries: MetadataEntry[] = [{ key: 'x', value: 'y' }];
    const bytes = serializeMetadataJSON(entries);
    const result = deserializeMetadata(bytes);
    expect(result).toEqual(entries);
  });

  it('detects binary format (not a leading `{`)', () => {
    const entries: MetadataEntry[] = [{ key: 'x', value: 'y' }];
    const bytes = serializeMetadataBinary(entries);
    const result = deserializeMetadata(bytes);
    expect(result).toEqual(entries);
  });

  it('handles empty bytes', () => {
    const result = deserializeMetadata(new Uint8Array(0));
    expect(result).toEqual([]);
  });
});

// Metadata redesign Task 1: DEFAULT_STATE.metadata.include now defaults every
// group off (collectMetadata itself has no `enabled` concept — it purely
// reads `state.metadata.include` per key — so tests exercising which keys
// get collected need a fixture with every group explicitly on).
const FULL_STATE = {
  ...DEFAULT_STATE,
  metadata: {
    ...DEFAULT_STATE.metadata,
    include: { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true, endianness: true },
  },
};

describe('collectMetadata', () => {
  it('includes all auto-collected keys', () => {
    const entries = collectMetadata(FULL_STATE, [], undefined);
    const keys = entries.map((e) => e.key);
    expect(keys).toContain('schema');
    expect(keys).toContain('shape');
    expect(keys).toContain('chunk_shape');
    expect(keys).toContain('codec_pipelines');
    expect(keys).toContain('byte_order');
    expect(keys).toContain('interleaving');
    expect(keys).toContain('metadata_format');
    expect(keys).toContain('chunk_order');
    expect(keys).toContain('partitioning');
  });

  it('no chunk_grid entry is ever written', () => {
    expect(collectMetadata(FULL_STATE, [], undefined).some((e) => e.key === 'chunk_grid')).toBe(false);
  });

  it('chunk_order reflects state.write.chunkOrder (task 2.2)', () => {
    const state = {
      ...FULL_STATE,
      write: { ...DEFAULT_STATE.write, chunkOrder: 'column-major' as const },
    };
    const entries = collectMetadata(state, [], undefined);
    const entry = entries.find((e) => e.key === 'chunk_order');
    expect(entry?.value).toBe('column-major');
  });

  it('partitioning reflects state.write.partitioning (task 2.2)', () => {
    const state = {
      ...FULL_STATE,
      write: { ...DEFAULT_STATE.write, partitioning: 'per-chunk' as const },
    };
    const entries = collectMetadata(state, [], undefined);
    const entry = entries.find((e) => e.key === 'partitioning');
    expect(entry?.value).toBe('per-chunk');
  });

  it('chunk_index entries carry variableName when the chunk has one (task 2.1/2.2 schema)', () => {
    const offsets = [{ coords: [0], offset: 4, size: 128, variableName: 'temperature' }];
    const entries = collectMetadata(FULL_STATE, [], undefined, offsets);
    const entry = entries.find((e) => e.key === 'chunk_index');
    const parsed = JSON.parse(entry!.value);
    expect(parsed[0].variableName).toBe('temperature');
  });

  it('includes custom entries', () => {
    const state = {
      ...FULL_STATE,
      metadata: {
        ...FULL_STATE.metadata,
        customEntries: [
          { key: 'crs', value: 'EPSG:4326' },
          { key: 'transform', value: '[1,0,0,0,-1,90]' },
        ],
      },
    };
    const entries = collectMetadata(state, [], undefined);
    const keys = entries.map((e) => e.key);
    expect(keys).toContain('crs');
    expect(keys).toContain('transform');
  });

  it('includes chunk index when provided', () => {
    const offsets = [{ coords: [0], offset: 4, size: 128 }];
    const entries = collectMetadata(FULL_STATE, [], undefined, offsets);
    const keys = entries.map((e) => e.key);
    expect(keys).toContain('chunk_index');
  });

  it('sets byte_order from state.byteOrder (default little)', () => {
    const entries = collectMetadata(FULL_STATE, [], undefined);
    expect(entries.find((e) => e.key === 'byte_order')?.value).toBe('little');
  });

  it('records byte_order: big when state.byteOrder is big (cl-8)', () => {
    const state = { ...FULL_STATE, byteOrder: 'big' as const };
    const entries = collectMetadata(state, [], undefined);
    expect(entries.find((e) => e.key === 'byte_order')?.value).toBe('big');
  });

  it('skips custom entries with empty keys', () => {
    const state = {
      ...FULL_STATE,
      metadata: {
        ...FULL_STATE.metadata,
        customEntries: [
          { key: '', value: 'should be skipped' },
          { key: 'valid', value: 'included' },
        ],
      },
    };
    const entries = collectMetadata(state, [], undefined);
    const keys = entries.map((e) => e.key);
    expect(keys).not.toContain('');
    expect(keys).toContain('valid');
  });

  it('custom entry overrides auto entry in place', () => {
    const state = {
      ...FULL_STATE,
      metadata: {
        ...FULL_STATE.metadata,
        customEntries: [{ key: 'shape', value: '[999]' }],
      },
    };
    const entries = collectMetadata(state, [], undefined, undefined);
    const shapeEntries = entries.filter((e) => e.key === 'shape');
    expect(shapeEntries).toHaveLength(1);
    expect(shapeEntries[0].value).toBe('[999]');
    // position preserved: 'shape' still appears before 'chunk_shape'
    expect(entries.findIndex((e) => e.key === 'shape')).toBeLessThan(
      entries.findIndex((e) => e.key === 'chunk_shape'),
    );
  });

  it('custom entries are written even with descriptive off; stats are not', () => {
    const state = {
      ...FULL_STATE,
      metadata: {
        ...FULL_STATE.metadata,
        include: { ...FULL_STATE.metadata.include, descriptive: false },
        customEntries: [{ key: 'crs', value: 'EPSG:4326' }],
      },
    };
    const someStatsMap = new Map([
      [state.variables[0].id, { min: 0, max: 1, mean: 0.5, count: 10, clipped: 0, rounded: 0, isLossy: false, nanCount: 0 }],
    ]);
    const entries = collectMetadata(state, [], someStatsMap, undefined);
    expect(entries.some((e) => e.key === 'crs')).toBe(true);
    expect(entries.some((e) => e.key === 'variable_statistics')).toBe(false);
  });

  it('duplicate custom keys: last wins', () => {
    const state = {
      ...FULL_STATE,
      metadata: {
        ...FULL_STATE.metadata,
        customEntries: [
          { key: 'a', value: 'first' },
          { key: 'a', value: 'second' },
        ],
      },
    };
    const entries = collectMetadata(state, [], undefined, undefined);
    const aEntries = entries.filter((e) => e.key === 'a');
    expect(aEntries).toHaveLength(1);
    expect(aEntries[0].value).toBe('second');
  });
});
