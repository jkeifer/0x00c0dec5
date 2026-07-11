import { describe, it, expect } from 'vitest';
import { DEFAULT_STATE } from '../../types/state.ts';
import { computeValuesStage, computeTypedStage, computeLinearizedStage, computeEncodedStage } from '../../hooks/usePipeline.ts';
import { buildValueBlocksLayout, buildLinearizedLayout, buildEncodedLayout, encodedChunkMeta, traceAt } from '../../engine/layout.ts';
import { expectTraceEquivalence } from '../helpers/equivalence.ts';
import type { CodecStep } from '../../types/codecs.ts';
import type { DtypeKey } from '../../types/dtypes.ts';

// A text variable exercises the variable-stride offsets path.
const TEXT_VAR = {
  ...DEFAULT_STATE.variables[0],
  id: 'label', name: 'label', color: '#c678dd',
  logicalType: { type: 'text', min: 0, max: 0, wordSet: 'names', generation: 'random' },
  typeAssignment: { storageDtype: 'char8' },
} as typeof DEFAULT_STATE.variables[0];

const CASES = [
  { name: 'default 3-var', state: DEFAULT_STATE },
  { name: 'with text var', state: { ...DEFAULT_STATE, variables: [...DEFAULT_STATE.variables, TEXT_VAR] } },
  { name: 'zero variables', state: { ...DEFAULT_STATE, variables: [] } },
];

describe('values-stage layout equivalence', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const values = computeValuesStage(c.state.shape, c.state.variables);
      const layout = buildValueBlocksLayout(
        c.state.variables, c.state.shape, values.variableValues,
        (name) => (values.variableValues.get(name) ?? []).some((v) => typeof v === 'string') ? 'text' : 'float64',
      );
      expectTraceEquivalence(layout, { values: values.variableValues, format: 'logical' }, values.stage.traces);
    });
  }
});

describe('typed-stage layout equivalence', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const values = computeValuesStage(c.state.shape, c.state.variables);
      const typed = computeTypedStage(c.state.shape, c.state.variables, values.variableValues);
      const layout = buildValueBlocksLayout(
        c.state.variables, c.state.shape, typed.typedVariableValues,
        (name) => c.state.variables.find((v) => v.name === name)!.typeAssignment.storageDtype,
      );
      expectTraceEquivalence(layout, { values: typed.typedVariableValues, format: 'typed' }, typed.stage.traces);
    });
  }
});

const LINEARIZED_CASES = [
  { name: 'column single chunk', interleaving: 'column' as const, shape: [4, 8], chunkShape: [4, 8] },
  { name: 'column multi chunk', interleaving: 'column' as const, shape: [4, 8], chunkShape: [2, 4] },
  { name: 'column clipped edge chunks', interleaving: 'column' as const, shape: [5, 7], chunkShape: [2, 4] },
  { name: 'row multi chunk', interleaving: 'row' as const, shape: [4, 8], chunkShape: [2, 4] },
  { name: 'row clipped', interleaving: 'row' as const, shape: [5, 7], chunkShape: [2, 4] },
  { name: 'tabular 1d', interleaving: 'row' as const, shape: [13], chunkShape: [4] },
];

describe('linearized-stage layout equivalence', () => {
  for (const c of LINEARIZED_CASES) {
    it(c.name, () => {
      const state = { ...DEFAULT_STATE, shape: c.shape, chunkShape: c.chunkShape, interleaving: c.interleaving };
      const values = computeValuesStage(state.shape, state.variables);
      const typed = computeTypedStage(state.shape, state.variables, values.variableValues);
      const lin = computeLinearizedStage(state.shape, state.chunkShape, state.interleaving, state.variables, typed.typedVariableValues);
      const layout = buildLinearizedLayout(lin.chunks, lin.linearizedChunks, state.interleaving, state.shape, state.chunkShape);
      expectTraceEquivalence(layout, { values: typed.typedVariableValues, format: 'typed' }, lin.stage.traces);
    });
  }

  it('with text var', () => {
    const state = {
      ...DEFAULT_STATE,
      shape: [4, 8],
      chunkShape: [2, 4],
      interleaving: 'row' as const,
      variables: [...DEFAULT_STATE.variables, TEXT_VAR],
    };
    const values = computeValuesStage(state.shape, state.variables);
    const typed = computeTypedStage(state.shape, state.variables, values.variableValues);
    const lin = computeLinearizedStage(state.shape, state.chunkShape, state.interleaving, state.variables, typed.typedVariableValues);
    const layout = buildLinearizedLayout(lin.chunks, lin.linearizedChunks, state.interleaving, state.shape, state.chunkShape);
    expectTraceEquivalence(layout, { values: typed.typedVariableValues, format: 'typed' }, lin.stage.traces);
  });
});

describe('traceAt bounds', () => {
  it('returns null out of range', () => {
    const values = computeValuesStage(DEFAULT_STATE.shape, DEFAULT_STATE.variables);
    const layout = buildValueBlocksLayout(DEFAULT_STATE.variables, DEFAULT_STATE.shape, values.variableValues, () => 'float64');
    const sources = { values: values.variableValues, format: 'logical' as const };
    expect(traceAt(layout, -1, sources)).toBeNull();
    expect(traceAt(layout, layout.byteLength, sources)).toBeNull();
  });
});

const ENCODED_CASES: { name: string; interleaving: 'row' | 'column'; fieldSteps?: CodecStep[]; chunkSteps?: CodecStep[] }[] = [
  { name: 'no codecs', interleaving: 'column', fieldSteps: [] },
  { name: 'delta', interleaving: 'column', fieldSteps: [{ codec: 'delta', params: { order: 1 } }] },
  { name: 'byte-shuffle', interleaving: 'column', fieldSteps: [{ codec: 'byte-shuffle', params: { elementSize: 4 } }] },
  {
    name: 'delta+byte-shuffle', interleaving: 'column',
    fieldSteps: [{ codec: 'delta', params: { order: 1 } }, { codec: 'byte-shuffle', params: { elementSize: 4 } }],
  },
  { name: 'rle (entropy)', interleaving: 'column', fieldSteps: [{ codec: 'rle', params: {} }] },
  {
    name: 'byte-shuffle+lz', interleaving: 'column',
    fieldSteps: [{ codec: 'byte-shuffle', params: { elementSize: 4 } }, { codec: 'lz', params: {} }],
  },
  { name: 'row chunk pipeline rle', interleaving: 'row', chunkSteps: [{ codec: 'rle', params: {} }] },
];

describe('encoded-stage layout equivalence', () => {
  for (const c of ENCODED_CASES) {
    it(c.name, () => {
      const state = {
        ...DEFAULT_STATE,
        shape: [4, 8],
        chunkShape: [2, 4],
        interleaving: c.interleaving,
        fieldPipelines: c.fieldSteps
          ? Object.fromEntries(DEFAULT_STATE.variables.map((v) => [v.id, c.fieldSteps!]))
          : DEFAULT_STATE.fieldPipelines,
        chunkPipeline: c.chunkSteps ?? DEFAULT_STATE.chunkPipeline,
      };
      const values = computeValuesStage(state.shape, state.variables);
      const typed = computeTypedStage(state.shape, state.variables, values.variableValues);
      const lin = computeLinearizedStage(state.shape, state.chunkShape, state.interleaving, state.variables, typed.typedVariableValues);
      const enc = computeEncodedStage(lin.chunks, lin.linearizedChunks, state.interleaving, state.variables, state.fieldPipelines, state.chunkPipeline);
      const linLayout = buildLinearizedLayout(lin.chunks, lin.linearizedChunks, state.interleaving, state.shape, state.chunkShape);

      const nameToId = new Map(state.variables.map((v) => [v.name, v.id]));
      const outputDtypes: string[] = [];
      const hasEntropy: boolean[] = [];
      lin.chunks.forEach((chunk) => {
        const steps = state.interleaving === 'column'
          ? (state.fieldPipelines[nameToId.get(chunk.variables[0].variableName)!] ?? [])
          : state.chunkPipeline;
        const uniqueDtypes = new Set(chunk.variables.map((cv) => cv.dtype));
        const inputDtype = (chunk.variables.length === 0
          ? 'uint8'
          : uniqueDtypes.size > 1
            ? 'uint8'
            : chunk.variables[0].dtype) as DtypeKey;
        const meta = encodedChunkMeta(steps, inputDtype);
        outputDtypes.push(meta.outputDtype);
        hasEntropy.push(meta.hasEntropy);
      });

      const encLayout = buildEncodedLayout(linLayout, enc.encodedChunks, outputDtypes, hasEntropy);
      expectTraceEquivalence(encLayout, { values: typed.typedVariableValues, format: 'typed' }, enc.stage.traces);
    });
  }
});
