/**
 * Targeted engine gap tests — adversarial metadata and magic-number inputs through
 * the FULL write -> read pipeline (not just the serializer in isolation).
 *
 * Covers remediation-plan.md Phase 1 task 1.2 / §1.7 gaps #5, #6:
 *  - Custom metadata entry with an unbalanced brace in its value (RP-2: the header
 *    JSON locator's brace counter ignores string literals).
 *  - Custom entry key shadowing an auto-generated key like `shape` (DC-5: silent
 *    corruption, last-value-wins on JSON object collapse).
 *  - Unicode keys/values through write -> read.
 *  - Magic numbers with odd length / non-hex / empty content through the pipeline
 *    (Phase 0 made hex parsing tolerant — these should PASS, not throw or fail read).
 */
import { describe, it, expect } from 'vitest';
import { readFile } from '../../../src/engine/read.ts';
import { computePipelineStages } from '../../../src/hooks/usePipeline.ts';
import { DEFAULT_STATE, type AppState } from '../../../src/types/state.ts';
import { generateValues } from '../../../src/engine/generate.ts';
import { hexToBytes } from '../../../src/engine/bytes.ts';

function stateWithCustomEntries(
  customEntries: { key: string; value: string }[],
  overrides: Partial<AppState['write']> = {},
): AppState {
  return {
    ...DEFAULT_STATE,
    metadata: {
      ...DEFAULT_STATE.metadata,
      enabled: true,
      include: { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true, endianness: true },
      customEntries,
    },
    write: {
      ...DEFAULT_STATE.write,
      metadataPlacement: 'header',
      ...overrides,
    },
  };
}

describe('metadata adversarial — brace in custom value (RP-2)', () => {
  // FIXED RP-2 (Phase 2 task 2.4) — `findJsonObjectEnd`/`findJsonObjectStart`
  // in `src/engine/read.ts` now track JSON string-literal/escape state while
  // counting braces, so an unescaped `{` inside a custom metadata string
  // value (e.g. `note = "weird { value"`) no longer perturbs the brace
  // counter. The header and footer scans both use these helpers.
  it('reads successfully when a custom value contains an unbalanced brace', () => {
    const state = stateWithCustomEntries([{ key: 'note', value: 'weird { value' }]);
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });

    expect(result.success).toBe(true);
    if (result.success) {
      const totalElements = state.shape.reduce((a, b) => a * b, 1);
      for (const v of state.variables) {
        const expected = generateValues(v.name, v.logicalType, totalElements) as number[];
        const actual = result.reconstructedValues.get(v.name);
        expect(actual).toBeDefined();
        for (let i = 0; i < expected.length; i++) {
          expect(actual![i]).toBeCloseTo(expected[i], 4);
        }
      }
    }
  });

  // Same fix, footer placement — the backward brace scan (`findJsonObjectStart`)
  // is equally string-literal-aware now.
  it('reads successfully with footer placement when a custom value contains an unbalanced brace', () => {
    const state = stateWithCustomEntries(
      [{ key: 'note', value: 'weird { value' }],
      { metadataPlacement: 'footer' },
    );
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });

    expect(result.success).toBe(true);
  });
});

describe('metadata adversarial — custom key overrides an auto key (spec §2, override-wins)', () => {
  // CHANGED (metadata redesign Task 2) — `collectMetadata` (`src/engine/metadata.ts`)
  // no longer renames a colliding custom key; it replaces the auto entry's
  // value in place instead. Override-wins is deliberate: users can lie to the
  // reader (the include toggles already let them starve it entirely), so a
  // custom entry keyed `shape` with a non-JSON value now genuinely corrupts
  // the shape the reader sees, and the read fails honestly rather than being
  // silently protected by a rename. `MetadataEditor` shows a warning on the
  // affected row ("overrides auto-collected {key}").
  it('overriding shape with a non-JSON value fails the read (no silent protection)', () => {
    const state = stateWithCustomEntries([{ key: 'shape', value: 'not-json-shape' }]);
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });

    expect(result.success).toBe(false);
  });

  // Overriding `schema` the same way corrupts schema parsing too.
  it('overriding the schema key fails the read (no silent protection)', () => {
    const state = stateWithCustomEntries([{ key: 'schema', value: 'not-a-schema' }]);
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });

    expect(result.success).toBe(false);
  });

  // A custom entry whose key does NOT match any auto key is pure addition —
  // no override, no corruption.
  it('a non-colliding custom key reads successfully with correct values', () => {
    const state = stateWithCustomEntries([{ key: 'crs', value: 'EPSG:4326' }]);
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });

    expect(result.success).toBe(true);
    if (result.success) {
      const totalElements = state.shape.reduce((a, b) => a * b, 1);
      for (const v of state.variables) {
        const expected = generateValues(v.name, v.logicalType, totalElements) as number[];
        const actual = result.reconstructedValues.get(v.name);
        expect(actual).toBeDefined();
        for (let i = 0; i < expected.length; i++) {
          expect(actual![i]).toBeCloseTo(expected[i], 4);
        }
      }
    }
  });
});

describe('metadata adversarial — unicode keys and values', () => {
  it('reads successfully with unicode custom metadata (header placement)', () => {
    const state = stateWithCustomEntries([
      { key: 'ünïcödé_key_日本語', value: 'válüé emoji 🎉 日本語テキスト' },
    ]);
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });

    expect(result.success).toBe(true);
    if (result.success) {
      const totalElements = state.shape.reduce((a, b) => a * b, 1);
      for (const v of state.variables) {
        const expected = generateValues(v.name, v.logicalType, totalElements) as number[];
        const actual = result.reconstructedValues.get(v.name);
        expect(actual).toBeDefined();
        for (let i = 0; i < expected.length; i++) {
          expect(actual![i]).toBeCloseTo(expected[i], 4);
        }
      }
    }
  });

  it('reads successfully with unicode custom metadata (sidecar placement)', () => {
    const state = stateWithCustomEntries(
      [{ key: '温度単位', value: '°C — degrees Celsius, naïve façade ünïcödé' }],
      { metadataPlacement: 'sidecar' },
    );
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });

    expect(result.success).toBe(true);
  });

  it('reads successfully with unicode custom metadata (binary serialization)', () => {
    const state: AppState = {
      ...stateWithCustomEntries([{ key: 'キー', value: 'значение' }]),
      metadata: {
        enabled: true,
        customEntries: [{ key: 'キー', value: 'значение' }],
        serialization: 'binary',
        include: { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true, endianness: true },
      },
    };
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });

    expect(result.success).toBe(true);
  });
});

describe('magic numbers through the pipeline — tolerant parsing (Phase 0)', () => {
  // Phase 0 (task 0.2) unified hexToBytes into a tolerant implementation
  // (src/engine/bytes.ts) that strips non-hex characters and drops a trailing odd
  // nibble instead of throwing. These should PASS now: assemble + read without
  // throwing, for a variety of malformed magic-number strings.
  it('handles an odd-length magic number ("0") without throwing', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      metadata: {
        ...DEFAULT_STATE.metadata,
        enabled: true,
        include: { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true, endianness: true },
      },
      write: { ...DEFAULT_STATE.write, metadataPlacement: 'header', magicNumber: '0' },
    };
    expect(() => {
      const { files } = computePipelineStages(state);
      readFile(files, { magic: hexToBytes(state.write.magicNumber) });
    }).not.toThrow();
  });

  it('handles a non-hex magic number ("GG") without throwing', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      metadata: {
        ...DEFAULT_STATE.metadata,
        enabled: true,
        include: { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true, endianness: true },
      },
      write: { ...DEFAULT_STATE.write, metadataPlacement: 'header', magicNumber: 'GG' },
    };
    expect(() => {
      const { files } = computePipelineStages(state);
      readFile(files, { magic: hexToBytes(state.write.magicNumber) });
    }).not.toThrow();
  });

  it('handles an empty magic number ("") without throwing', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      metadata: {
        ...DEFAULT_STATE.metadata,
        enabled: true,
        include: { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true, endianness: true },
      },
      write: { ...DEFAULT_STATE.write, metadataPlacement: 'header', magicNumber: '' },
    };
    expect(() => {
      const { files } = computePipelineStages(state);
      readFile(files, { magic: hexToBytes(state.write.magicNumber) });
    }).not.toThrow();
  });

  it('assembles and reads successfully end-to-end with odd-length magic', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      metadata: {
        ...DEFAULT_STATE.metadata,
        enabled: true,
        include: { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true, endianness: true },
      },
      write: { ...DEFAULT_STATE.write, metadataPlacement: 'header', magicNumber: '0' },
    };
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });
    expect(result.success).toBe(true);
  });

  it('assembles and reads successfully end-to-end with non-hex magic', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      metadata: {
        ...DEFAULT_STATE.metadata,
        enabled: true,
        include: { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true, endianness: true },
      },
      write: { ...DEFAULT_STATE.write, metadataPlacement: 'header', magicNumber: 'GG' },
    };
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });
    expect(result.success).toBe(true);
  });

  it('assembles and reads successfully end-to-end with empty magic', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      metadata: {
        ...DEFAULT_STATE.metadata,
        enabled: true,
        include: { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true, endianness: true },
      },
      write: { ...DEFAULT_STATE.write, metadataPlacement: 'header', magicNumber: '' },
    };
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });
    expect(result.success).toBe(true);
  });

  it('handles mixed-case non-hex magic with footer placement without throwing', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      metadata: {
        ...DEFAULT_STATE.metadata,
        enabled: true,
        include: { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true, endianness: true },
      },
      write: { ...DEFAULT_STATE.write, metadataPlacement: 'footer', magicNumber: 'zZ0c0deC5' },
    };
    expect(() => {
      const { files } = computePipelineStages(state);
      readFile(files, { magic: hexToBytes(state.write.magicNumber) });
    }).not.toThrow();
  });
});
