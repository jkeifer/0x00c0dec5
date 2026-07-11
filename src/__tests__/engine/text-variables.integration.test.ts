/**
 * Integration coverage for fixed-width text (charN) variables: full
 * write -> read roundtrips via `computePipelineStages` across interleaving
 * modes, codecs, metadata serializations, and the no-chunk-index path.
 * (Plan step 12 — consolidated into one file rather than spread across
 * pipeline.integration/read/metadata test files; coverage is identical.)
 */
import { describe, it, expect } from 'vitest';
import { computePipelineStages } from '../../hooks/usePipeline.ts';
import { generateValues, WORD_SETS } from '../../engine/generate.ts';
import { deserializeMetadata } from '../../engine/metadata.ts';
import { referenceStageTraces } from '../helpers/referenceTraces.ts';
import { DEFAULT_STATE } from '../../types/state.ts';
import type { AppState, Variable } from '../../types/state.ts';
import type { CodecStep } from '../../types/codecs.ts';
import type { DtypeKey } from '../../types/dtypes.ts';

function textVar(name: string, storageDtype: DtypeKey, overrides: Partial<Variable['logicalType']> = {}): Variable {
  return {
    id: name,
    name,
    color: '#61afef',
    logicalType: { type: 'text', min: 0, max: 0, wordSet: 'cities', generation: 'stepped', ...overrides },
    typeAssignment: { storageDtype },
  };
}

const HUMIDITY: Variable = {
  id: 'humidity', name: 'humidity', color: '#98c379',
  logicalType: { type: 'integer', min: 0, max: 100, generation: 'stepped' },
  typeAssignment: { storageDtype: 'uint16' },
};

function makeState(overrides: Partial<AppState>): AppState {
  return {
    ...structuredClone(DEFAULT_STATE),
    ...overrides,
    metadata: { ...DEFAULT_STATE.metadata, ...(overrides.metadata ?? {}) },
    write: { ...DEFAULT_STATE.write, includeMetadata: true, ...(overrides.write ?? {}) },
  };
}

function expectedWords(v: Variable, count: number): string[] {
  return generateValues(v.name, v.logicalType, count) as string[];
}

describe('text variables — write/read roundtrip', () => {
  it('column interleaving: reconstructs exact trimmed words (no truncation, no codecs)', () => {
    const city = textVar('city', 'char16');
    const state = makeState({
      shape: [16], chunkShape: [8],
      variables: [city, HUMIDITY],
      fieldPipelines: { city: [], humidity: [] },
    });
    const { readResult } = computePipelineStages(state);
    expect(readResult.success).toBe(true);
    if (!readResult.success) return;
    expect(readResult.reconstructedValues.get('city')).toEqual(expectedWords(city, 16));
    expect(readResult.lossyVariables.has('city')).toBe(false);
  });

  it('row interleaving: mixed text + numeric roundtrips (input dtype collapses to uint8)', () => {
    const city = textVar('city', 'char8', { wordSet: 'names' });
    const state = makeState({
      shape: [16], chunkShape: [8],
      interleaving: 'row',
      variables: [city, HUMIDITY],
      fieldPipelines: {},
      // Delta on the shared row pipeline: mixed dtypes force uint8 input
      // (existing rule), so this is byte-wise delta — prove it roundtrips.
      chunkPipeline: [{ codec: 'delta', params: { order: 1 } } as CodecStep],
    });
    const totalElements = 16;
    const { readResult } = computePipelineStages(state);
    expect(readResult.success).toBe(true);
    if (!readResult.success) return;
    const expected = expectedWords(city, totalElements).map((w) => w.slice(0, 8));
    expect(readResult.reconstructedValues.get('city')).toEqual(expected);
    expect(readResult.reconstructedValues.get('humidity')).toEqual(
      generateValues('humidity', HUMIDITY.logicalType, totalElements),
    );
  });

  it('truncation: char4 storage of long words flags the variable lossy and reads back prefixes', () => {
    const city = textVar('city', 'char4');
    const state = makeState({
      shape: [16], chunkShape: [16],
      variables: [city],
      fieldPipelines: { city: [] },
    });
    const words = expectedWords(city, 16);
    expect(words.some((w) => w.length > 4)).toBe(true); // sanity: truncation actually occurs

    const { readResult, variableStats } = computePipelineStages(state);
    expect(variableStats.get('city')!.truncated).toBeGreaterThan(0);
    expect(variableStats.get('city')!.isLossy).toBe(true);
    expect(readResult.success).toBe(true);
    if (!readResult.success) return;
    expect(readResult.lossyVariables.has('city')).toBe(true);
    // Reconstructed values are the width-limited prefixes (trailing spaces
    // trimmed — a word like 'La Paz' truncated to 'La P' keeps its inner space).
    expect(readResult.reconstructedValues.get('city')).toEqual(
      words.map((w) => w.slice(0, 4).replace(/ +$/, '')),
    );
  });

  it('RLE on stepped short-word text shrinks the Encoded stage and still reads back exactly', () => {
    // Padding-dominated case: stepped 'names' (longest 9) in char16 leaves
    // >= 7-byte space runs per value — RLE's actual win on text.
    const city = textVar('city', 'char16', { wordSet: 'names' });
    const state = makeState({
      shape: [64], chunkShape: [64],
      variables: [city],
      fieldPipelines: { city: [{ codec: 'rle', params: {} } as CodecStep] },
    });
    const { stages, readResult } = computePipelineStages(state);
    const linearized = stages.find((s) => s.name === 'Linearized')!;
    const encoded = stages.find((s) => s.name === 'Encoded')!;
    expect(encoded.stats.byteCount).toBeLessThan(linearized.stats.byteCount);
    expect(readResult.success).toBe(true);
    if (!readResult.success) return;
    expect(readResult.reconstructedValues.get('city')).toEqual(expectedWords(city, 64));
  });

  it('LZ on prefix-heavy station IDs shrinks the Encoded stage and reads back exactly', () => {
    const station = textVar('station', 'char16', { wordSet: 'stations', generation: 'random' });
    const state = makeState({
      shape: [64], chunkShape: [64],
      variables: [station],
      fieldPipelines: { station: [{ codec: 'lz', params: { windowSize: 256 } } as CodecStep] },
    });
    const { stages, readResult } = computePipelineStages(state);
    const linearized = stages.find((s) => s.name === 'Linearized')!;
    const encoded = stages.find((s) => s.name === 'Encoded')!;
    expect(encoded.stats.byteCount).toBeLessThan(linearized.stats.byteCount);
    expect(readResult.success).toBe(true);
    if (!readResult.success) return;
    expect(readResult.reconstructedValues.get('station')).toEqual(expectedWords(station, 64));
  });

  it.each(['json', 'binary'] as const)(
    'metadata %s serialization carries charN through schema/type_assignments and parses',
    (serialization) => {
      const city = textVar('city', 'char8', { wordSet: 'countries' });
      const state = makeState({
        shape: [8], chunkShape: [8],
        variables: [city, HUMIDITY],
        fieldPipelines: { city: [], humidity: [] },
        metadata: { customEntries: [], serialization, includeChunkIndex: true },
      });
      const { stages, readResult } = computePipelineStages(state);

      // The Metadata stage's bytes deserialize and carry the char dtype.
      const metaStage = stages.find((s) => s.name === 'Metadata')!;
      const entries = deserializeMetadata(metaStage.bytes);
      const schema = JSON.parse(entries.find((e) => e.key === 'schema')!.value) as { name: string; dtype: string }[];
      expect(schema.find((e) => e.name === 'city')!.dtype).toBe('char8');
      const assignments = JSON.parse(entries.find((e) => e.key === 'type_assignments')!.value);
      expect(assignments.city.storageDtype).toBe('char8');

      // ...and the reader parses that structure into an exact reconstruction.
      expect(readResult.success).toBe(true);
      if (!readResult.success) return;
      expect(readResult.reconstructedValues.get('city')).toEqual(
        expectedWords(city, 8).map((w) => w.slice(0, 8).replace(/ +$/, '')),
      );
    },
  );

  it('no chunk index: offsets computed from chunkShape x char8 size reconstruct exactly', () => {
    const city = textVar('city', 'char8', { wordSet: 'names' });
    const state = makeState({
      shape: [16], chunkShape: [4], // 4 chunks — offsets actually matter
      variables: [city, HUMIDITY],
      fieldPipelines: { city: [], humidity: [] },
      metadata: { customEntries: [], serialization: 'json', includeChunkIndex: false },
    });
    const { readResult } = computePipelineStages(state);
    expect(readResult.success).toBe(true);
    if (!readResult.success) return;
    expect(readResult.reconstructedValues.get('city')).toEqual(expectedWords(city, 16));
    expect(readResult.reconstructedValues.get('humidity')).toEqual(
      generateValues('humidity', HUMIDITY.logicalType, 16),
    );
  });

  it('Values stage traces text values with variable stride (byteCount = word length)', () => {
    const city = textVar('city', 'char8');
    const state = makeState({
      shape: [4], chunkShape: [4],
      variables: [city],
      fieldPipelines: { city: [] },
    });
    const { stages } = computePipelineStages(state);
    const values = stages[0];
    const words = expectedWords(city, 4);
    const totalLen = words.reduce((sum, w) => sum + w.length, 0);
    expect(values.bytes.length).toBe(totalLen);
    const valuesTraces = referenceStageTraces(state).get('values')!;
    expect(valuesTraces.length).toBe(totalLen);
    // Each value's traces span exactly its own length, and the raw bytes are
    // the word's ASCII (the hex ASCII column shows the words natively).
    let offset = 0;
    for (const w of words) {
      expect(valuesTraces[offset].byteCount).toBe(w.length);
      expect(valuesTraces[offset].displayValue).toBe(w);
      const slice = values.bytes.slice(offset, offset + w.length);
      expect(new TextDecoder().decode(slice)).toBe(w);
      offset += w.length;
    }
  });

  it('word membership sanity: generated stepped cities come from the bundled set', () => {
    const words = expectedWords(textVar('city', 'char16'), 32);
    const set = new Set(WORD_SETS.cities);
    for (const w of words) expect(set.has(w)).toBe(true);
  });
});
