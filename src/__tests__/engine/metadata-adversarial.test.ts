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
import { readFile } from '../../engine/read.ts';
import { computePipelineStages } from '../../hooks/usePipeline.ts';
import { DEFAULT_STATE, type AppState } from '../../types/state.ts';
import { generateValues } from '../../engine/generate.ts';

function stateWithCustomEntries(
  customEntries: { key: string; value: string }[],
  overrides: Partial<AppState['write']> = {},
): AppState {
  return {
    ...DEFAULT_STATE,
    metadata: {
      ...DEFAULT_STATE.metadata,
      customEntries,
    },
    write: {
      ...DEFAULT_STATE.write,
      includeMetadata: true,
      metadataPlacement: 'header',
      ...overrides,
    },
  };
}

describe('metadata adversarial — brace in custom value (RP-2)', () => {
  // KNOWN BUG RP-2 — `tryParseEmbeddedMetadata`'s header JSON locator
  // (`src/engine/read.ts`) counts `{`/`}` characters without tracking whether it is
  // inside a JSON string literal. A custom entry like `note = "weird { value"` embeds
  // a literal, unescaped `{` inside a JSON string value (JSON.stringify does not
  // escape `{`), which throws the brace counter off and the locator either slices at
  // the wrong offset or never finds a balanced end, causing JSON.parse to fail and
  // the whole read to report the generic "no metadata" failure — even though valid
  // metadata IS present in the file. Verified live. flip to it() when Phase 2 lands
  // (task 2.4: string-literal-aware brace scanning).
  it.fails('reads successfully when a custom value contains an unbalanced brace', () => {
    const state = stateWithCustomEntries([{ key: 'note', value: 'weird { value' }]);
    const { files } = computePipelineStages(state);
    const result = readFile(files, state.write.magicNumber);

    expect(result.success).toBe(true);
    if (result.success) {
      const totalElements = state.shape.reduce((a, b) => a * b, 1);
      for (const v of state.variables) {
        const expected = generateValues(v.name, v.logicalType, totalElements);
        const actual = result.reconstructedValues.get(v.name);
        expect(actual).toBeDefined();
        for (let i = 0; i < expected.length; i++) {
          expect(actual![i]).toBeCloseTo(expected[i], 4);
        }
      }
    }
  });

  // Same root cause, footer placement — the backward brace scan is equally
  // string-literal-blind.
  it.fails('reads successfully with footer placement when a custom value contains an unbalanced brace', () => {
    const state = stateWithCustomEntries(
      [{ key: 'note', value: 'weird { value' }],
      { metadataPlacement: 'footer' },
    );
    const { files } = computePipelineStages(state);
    const result = readFile(files, state.write.magicNumber);

    expect(result.success).toBe(true);
  });
});

describe('metadata adversarial — custom key shadows an auto key (DC-5)', () => {
  // KNOWN BUG DC-5 — `collectMetadata` appends custom entries after the
  // auto-generated ones, and `serializeMetadataJSON` collapses entries into a plain
  // object keyed by `entry.key` with last-write-wins. A custom entry keyed `shape`
  // overwrites the real shape JSON with the user's arbitrary string, so
  // `JSON.parse(shapeStr)` throws in `readFile` and the read fails outright (with no
  // warning distinguishing this from "no metadata at all" — see RP-3). The plan's
  // contract (task 1.2) asks for EITHER a successful read with correct values OR an
  // explicit warning; today there is neither. Verified live: read fails with the
  // generic "no metadata" message despite metadata being present and mostly intact.
  // flip to it() when Phase 2 lands (task 2.11: warn/rename/reject on key collision).
  it.fails('either reads successfully with correct values or surfaces an explicit shadow warning', () => {
    const state = stateWithCustomEntries([{ key: 'shape', value: 'not-json-shape' }]);
    const { files } = computePipelineStages(state);
    const result = readFile(files, state.write.magicNumber);

    // Per the task's contract: assert read succeeds with correct values (the
    // stronger, desired outcome) rather than accepting silent corruption.
    expect(result.success).toBe(true);
    if (result.success) {
      const totalElements = state.shape.reduce((a, b) => a * b, 1);
      for (const v of state.variables) {
        const expected = generateValues(v.name, v.logicalType, totalElements);
        const actual = result.reconstructedValues.get(v.name);
        expect(actual).toBeDefined();
        for (let i = 0; i < expected.length; i++) {
          expect(actual![i]).toBeCloseTo(expected[i], 4);
        }
      }
    }
  });

  // Shadowing `schema` corrupts dtype/variable-name info in the same way.
  it.fails('shadowing the schema key does not silently corrupt the read', () => {
    const state = stateWithCustomEntries([{ key: 'schema', value: 'not-a-schema' }]);
    const { files } = computePipelineStages(state);
    const result = readFile(files, state.write.magicNumber);

    expect(result.success).toBe(true);
  });
});

describe('metadata adversarial — unicode keys and values', () => {
  it('reads successfully with unicode custom metadata (header placement)', () => {
    const state = stateWithCustomEntries([
      { key: 'ünïcödé_key_日本語', value: 'válüé emoji 🎉 日本語テキスト' },
    ]);
    const { files } = computePipelineStages(state);
    const result = readFile(files, state.write.magicNumber);

    expect(result.success).toBe(true);
    if (result.success) {
      const totalElements = state.shape.reduce((a, b) => a * b, 1);
      for (const v of state.variables) {
        const expected = generateValues(v.name, v.logicalType, totalElements);
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
    const result = readFile(files, state.write.magicNumber);

    expect(result.success).toBe(true);
  });

  it('reads successfully with unicode custom metadata (binary serialization)', () => {
    const state: AppState = {
      ...stateWithCustomEntries([{ key: 'キー', value: 'значение' }]),
      metadata: {
        customEntries: [{ key: 'キー', value: 'значение' }],
        serialization: 'binary',
      },
    };
    const { files } = computePipelineStages(state);
    const result = readFile(files, state.write.magicNumber);

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
      write: { ...DEFAULT_STATE.write, includeMetadata: true, metadataPlacement: 'header', magicNumber: '0' },
    };
    expect(() => {
      const { files } = computePipelineStages(state);
      readFile(files, state.write.magicNumber);
    }).not.toThrow();
  });

  it('handles a non-hex magic number ("GG") without throwing', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      write: { ...DEFAULT_STATE.write, includeMetadata: true, metadataPlacement: 'header', magicNumber: 'GG' },
    };
    expect(() => {
      const { files } = computePipelineStages(state);
      readFile(files, state.write.magicNumber);
    }).not.toThrow();
  });

  it('handles an empty magic number ("") without throwing', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      write: { ...DEFAULT_STATE.write, includeMetadata: true, metadataPlacement: 'header', magicNumber: '' },
    };
    expect(() => {
      const { files } = computePipelineStages(state);
      readFile(files, state.write.magicNumber);
    }).not.toThrow();
  });

  it('assembles and reads successfully end-to-end with odd-length magic', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      write: { ...DEFAULT_STATE.write, includeMetadata: true, metadataPlacement: 'header', magicNumber: '0' },
    };
    const { files } = computePipelineStages(state);
    const result = readFile(files, state.write.magicNumber);
    expect(result.success).toBe(true);
  });

  it('assembles and reads successfully end-to-end with non-hex magic', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      write: { ...DEFAULT_STATE.write, includeMetadata: true, metadataPlacement: 'header', magicNumber: 'GG' },
    };
    const { files } = computePipelineStages(state);
    const result = readFile(files, state.write.magicNumber);
    expect(result.success).toBe(true);
  });

  it('assembles and reads successfully end-to-end with empty magic', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      write: { ...DEFAULT_STATE.write, includeMetadata: true, metadataPlacement: 'header', magicNumber: '' },
    };
    const { files } = computePipelineStages(state);
    const result = readFile(files, state.write.magicNumber);
    expect(result.success).toBe(true);
  });

  it('handles mixed-case non-hex magic with footer placement without throwing', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      write: { ...DEFAULT_STATE.write, includeMetadata: true, metadataPlacement: 'footer', magicNumber: 'zZ0c0deC5' },
    };
    expect(() => {
      const { files } = computePipelineStages(state);
      readFile(files, state.write.magicNumber);
    }).not.toThrow();
  });
});
