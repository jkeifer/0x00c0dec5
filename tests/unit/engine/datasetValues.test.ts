import { describe, it, expect } from 'vitest';
import {
  computeValuesStage, computePipelineStages, createPipelineComputer,
  type SourceValues,
} from '../../../src/engine/pipelineCompute.ts';
import { generateValues } from '../../../src/engine/generate.ts';
import { DEFAULT_STATE, type AppState, type Variable } from '../../../src/types/state.ts';

// A curated variable: bound by an explicit `source` ref.
const REF = { datasetId: 'etopo-dem' as const, variableName: 'elevation' };
const KEY = `${REF.datasetId}/${REF.variableName}`;
const VAR: Variable = {
  id: 'v1', name: 'elevation', color: '#fff',
  source: REF,
  logicalType: { type: 'integer', min: -10, max: 10, generation: 'smooth' },
  typeAssignment: { storageDtype: 'int16' },
};
// A custom (generated) variable — no source.
const CUSTOM: Variable = {
  id: 'v2', name: 'noise', color: '#0ff',
  logicalType: { type: 'integer', min: 0, max: 5, generation: 'random' },
  typeAssignment: { storageDtype: 'int16' },
};

function sv(entries: Record<string, { values: Float64Array | (string | number)[]; naturalShape: number[] }>): SourceValues {
  return new Map(Object.entries(entries));
}

describe('computeValuesStage with sourceValues', () => {
  it('uses fetched source values (exact-fit) instead of the generator', () => {
    const src = new Float64Array([1, 2, 3, 4]);
    const source = sv({ [KEY]: { values: src, naturalShape: [4] } });
    const res = computeValuesStage([4], [VAR], 'little', source);
    // Copied, not aliased (detached-buffer discipline): equal values, fresh buffer.
    expect(res.variableValues.get('elevation')).not.toBe(src);
    expect(Array.from(res.variableValues.get('elevation') as Float64Array)).toEqual([1, 2, 3, 4]);
    // Stage bytes reflect the injected values, not generated ones.
    const generated = computeValuesStage([4], [{ ...VAR, source: undefined }], 'little');
    expect(res.stage.bytes).not.toEqual(generated.stage.bytes);
  });

  it('mixes: curated var gets its source, custom var gets generated values of the right length', () => {
    const source = sv({ [KEY]: { values: new Float64Array([1, 2, 3, 4]), naturalShape: [4] } });
    const res = computeValuesStage([4], [VAR, CUSTOM], 'little', source);
    expect(Array.from(res.variableValues.get('elevation') as Float64Array)).toEqual([1, 2, 3, 4]);
    const custom = res.variableValues.get('noise')!;
    expect(custom.length).toBe(4);
    expect(custom).toEqual(generateValues(CUSTOM.name, CUSTOM.logicalType, 4, undefined, [4]));
  });

  it('fail-loud: a curated variable with no loaded ref throws, naming the variable and ref', () => {
    expect(() => computeValuesStage([4], [VAR], 'little', sv({})))
      .toThrow(/elevation.*etopo-dem\/elevation.*not loaded/i);
  });

  it('fail-loud: missing sourceValues map entirely throws for a curated var', () => {
    expect(() => computeValuesStage([4], [VAR], 'little', undefined))
      .toThrow(/elevation.*not loaded/i);
  });

  it('integrity check: values length must equal the natural shape product, else throws', () => {
    const source = sv({ [KEY]: { values: new Float64Array([1, 2]), naturalShape: [4] } });
    expect(() => computeValuesStage([4], [VAR], 'little', source))
      .toThrow(/elevation.*expected 4.*got 2/);
  });

  it('tile-wired-in: schema larger than the natural shape repeats source values modulo (fillFromSource)', () => {
    // natural [2,2] source; schema [4,4] → 2×2 tile. value(r,c) = src[r%2][c%2].
    const src = new Float64Array([10, 11, 12, 13]); // [[10,11],[12,13]]
    const source = sv({ [KEY]: { values: src, naturalShape: [2, 2] } });
    const res = computeValuesStage([4, 4], [VAR], 'little', source);
    const out = res.variableValues.get('elevation') as Float64Array;
    expect(out.length).toBe(16);
    const at = (r: number, c: number) => out[r * 4 + c];
    expect(at(0, 0)).toBe(10);          // src[0][0]
    expect(at(0, 2)).toBe(10);          // wraps: col 2%2=0
    expect(at(3, 3)).toBe(13);          // src[1][1]
    expect(at(2, 1)).toBe(11);          // src[0][1]
  });
});

describe('full pipeline with sourceValues', () => {
  it('round-trips: readResult.success true, reconstructed values match injected (exact-fit)', () => {
    const n = 1024;
    const vals = new Float64Array(n);
    for (let i = 0; i < n; i++) vals[i] = 100 + Math.round(10 * Math.sin(i / 20));
    const state: AppState = {
      ...structuredClone(DEFAULT_STATE),
      dataModel: 'array',
      shape: [32, 32], chunkShape: [16, 16],
      variables: [VAR],
      fieldPipelines: { v1: [{ codec: 'delta', params: {} }, { codec: 'zigzag', params: {} }] },
      chunkPipeline: [],
      metadata: {
        ...structuredClone(DEFAULT_STATE).metadata,
        enabled: true,
        include: { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true, endianness: true },
      },
    };
    const result = computePipelineStages(state, undefined, sv({ [KEY]: { values: vals, naturalShape: [32, 32] } }));
    expect(result.readResult.success).toBe(true);
    if (!result.readResult.success) return;
    const rec = result.readResult.reconstructedValues.get('elevation');
    expect(rec).toBeDefined();
    expect(Array.from(rec!)).toEqual(Array.from(vals));
    expect(result.stages[1].stats.byteCount).toBe(n * 2); // int16
  });
});

describe('createPipelineComputer source keying', () => {
  const base: AppState = {
    ...structuredClone(DEFAULT_STATE),
    dataModel: 'array', shape: [4, 4], chunkShape: [4, 4],
    variables: [VAR], fieldPipelines: { v1: [] },
  };
  const source = () => sv({ [KEY]: { values: new Float64Array(16).fill(5), naturalShape: [4, 4] } });

  it('invalidates the values stage when the source ref changes, hits when unchanged', () => {
    const compute = createPipelineComputer();
    const d1 = compute(base, {}, undefined, source());
    const known = Object.fromEntries(Object.entries(d1).map(([s, e]) => [s, e.key]));
    const d2 = compute(base, known, undefined, source());
    expect(d2.values.payload).toBeUndefined();
    // Switch the source ref → values key changes → payload present.
    const other: AppState = {
      ...base,
      variables: [{ ...VAR, source: { datasetId: 'sst-field', variableName: 'sst' } }],
    };
    const otherSource = sv({ 'sst-field/sst': { values: new Float64Array(16).fill(7), naturalShape: [4, 4] } });
    const d3 = compute(other, known, undefined, otherSource);
    expect(d3.values.key).not.toBe(d1.values.key);
    expect(d3.values.payload).toBeDefined();
  });

  it('throws if a variable names a source but no values were provided', () => {
    const compute = createPipelineComputer();
    expect(() => compute(base, {})).toThrow(/elevation.*not loaded/i);
  });

  // Detached-buffer regression: the worker's sourceValuesCache holds a
  // long-lived entry and passes it into every compute. If computeValuesStage
  // aliased that array into the values payload, the worker's real postMessage
  // transfer would detach the SAME array the cache still holds.
  it('survives a real postMessage transfer without corrupting the held source map', () => {
    const compute = createPipelineComputer();
    const held = sv({ [KEY]: { values: new Float64Array(16).fill(5), naturalShape: [4, 4] } });

    const d1 = compute(base, {}, undefined, held);
    expect(d1.values.payload).toBeDefined();

    // Simulate postMessage transfer: detach the payload's buffers in place.
    for (const arr of d1.values.payload!.logicalValues.values()) {
      if (arr instanceof Float64Array) structuredClone(arr.buffer, { transfer: [arr.buffer] });
    }

    // The held source map must be intact — its buffer was NOT the detached one.
    const heldVals = held.get(KEY)!.values as Float64Array;
    expect(heldVals.length).toBe(16);
    expect(Array.from(heldVals)).toEqual(new Array(16).fill(5));

    // Recompute (values evicted on send) against the same held map — no throw.
    const known = Object.fromEntries(Object.entries(d1).map(([s, e]) => [s, e.key]));
    const changed: AppState = { ...base, write: { ...base.write, magicNumber: '0xCAFEBABE' } };
    expect(() => compute(changed, known, undefined, held)).not.toThrow();
  });
});
