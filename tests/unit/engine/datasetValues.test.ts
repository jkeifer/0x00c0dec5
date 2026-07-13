import { describe, it, expect } from 'vitest';
import {
  computeValuesStage, computePipelineStages, createPipelineComputer,
} from '../../../src/engine/pipelineCompute.ts';
import { generateValues } from '../../../src/engine/generate.ts';
import { DEFAULT_STATE, type AppState, type Variable } from '../../../src/types/state.ts';

const VAR: Variable = {
  id: 'v1', name: 'elevation', color: '#fff',
  logicalType: { type: 'integer', min: -10, max: 10, generation: 'smooth' },
  typeAssignment: { storageDtype: 'int16' },
};

describe('computeValuesStage with presetValues', () => {
  it('uses injected values instead of the generator', () => {
    const preset = new Map([['elevation', new Float64Array([1, 2, 3, 4])]]);
    const withPreset = computeValuesStage([4], [VAR], 'little', preset);
    expect(withPreset.variableValues.get('elevation')).toBe(preset.get('elevation'));
    // and the stage bytes reflect the injected values, not generated ones
    const generated = computeValuesStage([4], [VAR], 'little');
    expect(withPreset.stage.bytes).not.toEqual(generated.stage.bytes);
  });

  it('equals the generated pipeline when injected values equal generated values', () => {
    const gen = generateValues(VAR.name, VAR.logicalType, 4);
    const preset = new Map([['elevation', gen]]);
    const a = computeValuesStage([4], [VAR], 'little');
    const b = computeValuesStage([4], [VAR], 'little', preset);
    expect(b.stage.bytes).toEqual(a.stage.bytes);
  });

  it('throws on missing variable name', () => {
    const preset = new Map([['wrong-name', new Float64Array([1, 2, 3, 4])]]);
    expect(() => computeValuesStage([4], [VAR], 'little', preset))
      .toThrow(/elevation.*not present/i);
  });

  it('throws on length mismatch, naming variable and counts', () => {
    const preset = new Map([['elevation', new Float64Array([1, 2])]]);
    expect(() => computeValuesStage([4], [VAR], 'little', preset))
      .toThrow(/elevation.*4.*got 2/);
  });
});

describe('full pipeline with presetValues', () => {
  it('round-trips: readResult.success true, reconstructed values match injected', () => {
    const n = 1024;
    const vals = new Float64Array(n);
    for (let i = 0; i < n; i++) vals[i] = 100 + Math.round(10 * Math.sin(i / 20)); // smooth terrain-ish
    const state: AppState = {
      ...structuredClone(DEFAULT_STATE),
      dataModel: 'array',
      dataset: { id: 'etopo-dem', attribution: 'test' },
      shape: [32, 32], chunkShape: [16, 16],
      variables: [VAR],
      fieldPipelines: { v1: [{ codec: 'delta', params: {} }, { codec: 'zigzag', params: {} }] },
      chunkPipeline: [],
      // Embed metadata so the reader can locate it (DEFAULT_STATE ships
      // includeMetadata:false, which round-trips to metadata-not-found — the
      // read failure is a write-config property, unrelated to preset injection).
      write: { ...DEFAULT_STATE.write, includeMetadata: true },
    };
    const result = computePipelineStages(state, undefined, new Map([['elevation', vals]]));
    expect(result.readResult.success).toBe(true);
    if (!result.readResult.success) return; // narrow for TS
    // reconstructed values match the injected ones exactly (int16 storage, lossless codecs)
    const rec = result.readResult.reconstructedValues.get('elevation');
    expect(rec).toBeDefined();
    expect(Array.from(rec!)).toEqual(Array.from(vals));
    const typedBytes = result.stages[1].stats.byteCount;
    expect(typedBytes).toBe(n * 2); // int16
  });
});

describe('createPipelineComputer dataset keying', () => {
  it('invalidates the values stage when dataset id changes, hits when unchanged', () => {
    const compute = createPipelineComputer();
    const preset = new Map([['elevation', new Float64Array(16).fill(5)]]);
    const base: AppState = {
      ...structuredClone(DEFAULT_STATE),
      dataModel: 'array', shape: [4, 4], chunkShape: [4, 4],
      variables: [VAR], fieldPipelines: { v1: [] },
      dataset: { id: 'etopo-dem', attribution: 'a' },
    };
    const d1 = compute(base, {}, undefined, preset);
    // same state, client now knows the keys → values omitted from delta
    const known = Object.fromEntries(Object.entries(d1).map(([s, e]) => [s, e.key]));
    const d2 = compute(base, known, undefined, preset);
    expect(d2.values.payload).toBeUndefined();
    // dataset switched → values key changes → payload present
    const other = { ...base, dataset: { id: 'sst-field', attribution: 'a' } };
    const preset2 = new Map([['elevation', new Float64Array(16).fill(7)]]);
    const d3 = compute(other, known, undefined, preset2);
    expect(d3.values.key).not.toBe(d1.values.key);
    expect(d3.values.payload).toBeDefined();
  });

  it('throws if state names a dataset but no values were provided', () => {
    const compute = createPipelineComputer();
    const base: AppState = {
      ...structuredClone(DEFAULT_STATE), dataModel: 'array',
      shape: [4, 4], chunkShape: [4, 4], variables: [VAR], fieldPipelines: { v1: [] },
      dataset: { id: 'etopo-dem', attribution: 'a' },
    };
    expect(() => compute(base, {})).toThrow(/dataset.*not loaded/i);
  });
});
