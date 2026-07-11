import { describe, it, expect } from 'vitest';
import { DEFAULT_STATE } from '../../types/state.ts';
import {
  computeValuesStage, computeTypedStage, computeLinearizedStage, computeEncodedStage,
  computeMetadataStage, computeFilesStage, computeReadStage,
} from '../../hooks/usePipeline.ts';
import {
  buildValueBlocksLayout, buildLinearizedLayout, buildEncodedLayout, encodedChunkMeta, traceAt,
  buildMetadataLayout,
} from '../../engine/layout.ts';
import { expectTraceEquivalence } from '../helpers/equivalence.ts';
import type { CodecStep } from '../../types/codecs.ts';
import type { DtypeKey } from '../../types/dtypes.ts';
import type { AppState } from '../../types/state.ts';

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

const ENCODED_CASES: { name: string; interleaving: 'row' | 'column'; fieldSteps?: CodecStep[]; chunkSteps?: CodecStep[]; variables?: typeof DEFAULT_STATE.variables; chunkShape?: number[] }[] = [
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
  {
    name: 'row chunk pipeline rle, single variable', interleaving: 'row',
    chunkSteps: [{ codec: 'rle', params: {} }],
    variables: [DEFAULT_STATE.variables[0]],
    chunkShape: [2, 4],
  },
];

describe('encoded-stage layout equivalence', () => {
  for (const c of ENCODED_CASES) {
    it(c.name, () => {
      const state = {
        ...DEFAULT_STATE,
        shape: [4, 8],
        chunkShape: c.chunkShape ?? [2, 4],
        interleaving: c.interleaving,
        variables: c.variables ?? DEFAULT_STATE.variables,
        fieldPipelines: c.fieldSteps
          ? Object.fromEntries((c.variables ?? DEFAULT_STATE.variables).map((v) => [v.id, c.fieldSteps!]))
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

describe('metadata-stage layout equivalence', () => {
  for (const serialization of ['json', 'binary'] as const) {
    it(`serialization=${serialization}`, () => {
      const state = { ...DEFAULT_STATE, metadata: { ...DEFAULT_STATE.metadata, serialization } };
      const values = computeValuesStage(state.shape, state.variables);
      const typed = computeTypedStage(state.shape, state.variables, values.variableValues);
      const linearized = computeLinearizedStage(state.shape, state.chunkShape, state.interleaving, state.variables, typed.typedVariableValues);
      const encoded = computeEncodedStage(linearized.chunks, linearized.linearizedChunks, state.interleaving, state.variables, state.fieldPipelines, state.chunkPipeline);
      const metadata = computeMetadataStage(state, encoded.encodedChunks, typed.variableStats);

      const layout = buildMetadataLayout(metadata.stage.bytes.length);
      const sources = { values: new Map(), format: 'logical' as const };
      expectTraceEquivalence(layout, sources, metadata.stage.traces);
    });
  }
});

// Write matrix: { partitioning: single|per-chunk } x { metadataPlacement:
// header|footer|sidecar } x { includeMetadata: true|false } x
// { includeChunkIndex: true|false } is 24 combinations. Reduced to an 8-combo
// covering subset: every option value appears in >= 2 rows, and the
// entropy + per-value (column interleaving, non-entropy field pipeline on one
// var + entropy on another isn't needed here — the ENCODED_CASES above already
// cover per-value vs chunk-level tracing in isolation) mix below (an entropy
// chunk pipeline row-interleaved alongside the default column setup's
// non-entropy field pipelines) appears under BOTH partitionings (rows 0 and 4).
type WriteCase = {
  name: string;
  partitioning: AppState['write']['partitioning'];
  metadataPlacement: AppState['write']['metadataPlacement'];
  includeMetadata: boolean;
  includeChunkIndex: boolean;
};

const WRITE_CASES: WriteCase[] = [
  { name: 'single/header/meta/idx', partitioning: 'single', metadataPlacement: 'header', includeMetadata: true, includeChunkIndex: true },
  { name: 'single/footer/meta/noidx', partitioning: 'single', metadataPlacement: 'footer', includeMetadata: true, includeChunkIndex: false },
  { name: 'single/sidecar/nometa/idx', partitioning: 'single', metadataPlacement: 'sidecar', includeMetadata: false, includeChunkIndex: true },
  { name: 'single/header/nometa/noidx', partitioning: 'single', metadataPlacement: 'header', includeMetadata: false, includeChunkIndex: false },
  { name: 'per-chunk/footer/meta/idx', partitioning: 'per-chunk', metadataPlacement: 'footer', includeMetadata: true, includeChunkIndex: true },
  { name: 'per-chunk/sidecar/meta/noidx', partitioning: 'per-chunk', metadataPlacement: 'sidecar', includeMetadata: true, includeChunkIndex: false },
  { name: 'per-chunk/header/nometa/idx', partitioning: 'per-chunk', metadataPlacement: 'header', includeMetadata: false, includeChunkIndex: true },
  { name: 'per-chunk/footer/nometa/noidx', partitioning: 'per-chunk', metadataPlacement: 'footer', includeMetadata: false, includeChunkIndex: false },
];

describe('write-stage (VirtualFile.layout) equivalence', () => {
  for (const c of WRITE_CASES) {
    it(c.name, () => {
      // Row interleaving + an entropy chunk pipeline on one run, column
      // interleaving + default (empty) field pipelines on the rest — between
      // the 8 rows this exercises both per-value and chunk-level (entropy)
      // tracing, and both partitionings see an entropy case (rows 0 and 4).
      const useEntropy = c.name === 'single/header/meta/idx' || c.name === 'per-chunk/footer/meta/idx';
      const state: AppState = {
        ...DEFAULT_STATE,
        interleaving: useEntropy ? 'row' : 'column',
        chunkShape: useEntropy ? [16] : DEFAULT_STATE.chunkShape,
        chunkPipeline: useEntropy ? [{ codec: 'rle', params: {} }] : DEFAULT_STATE.chunkPipeline,
        metadata: { ...DEFAULT_STATE.metadata, includeChunkIndex: c.includeChunkIndex },
        write: {
          ...DEFAULT_STATE.write,
          partitioning: c.partitioning,
          metadataPlacement: c.metadataPlacement,
          includeMetadata: c.includeMetadata,
        },
      };
      const values = computeValuesStage(state.shape, state.variables);
      const typed = computeTypedStage(state.shape, state.variables, values.variableValues);
      const linearized = computeLinearizedStage(state.shape, state.chunkShape, state.interleaving, state.variables, typed.typedVariableValues);
      const encoded = computeEncodedStage(linearized.chunks, linearized.linearizedChunks, state.interleaving, state.variables, state.fieldPipelines, state.chunkPipeline);
      const files = computeFilesStage(state, encoded.encodedChunks, typed.variableStats, linearized);

      const sources = { values: typed.typedVariableValues, format: 'typed' as const };
      for (const file of files.files) {
        expectTraceEquivalence(file.layout, sources, file.traces);
      }
    });
  }
});

describe('read-stage layout equivalence', () => {
  it('successful read (includeMetadata, header placement)', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      write: { ...DEFAULT_STATE.write, includeMetadata: true, metadataPlacement: 'header' },
    };
    const values = computeValuesStage(state.shape, state.variables);
    const typed = computeTypedStage(state.shape, state.variables, values.variableValues);
    const linearized = computeLinearizedStage(state.shape, state.chunkShape, state.interleaving, state.variables, typed.typedVariableValues);
    const encoded = computeEncodedStage(linearized.chunks, linearized.linearizedChunks, state.interleaving, state.variables, state.fieldPipelines, state.chunkPipeline);
    const files = computeFilesStage(state, encoded.encodedChunks, typed.variableStats, linearized);
    const read = computeReadStage(files.files, state.shape, state.variables, state.write.magicNumber);

    expect(read.readResult.success).toBe(true);
    const layout = buildValueBlocksLayout(
      state.variables, state.shape, read.logicalValues,
      () => 'float64',
    );
    expectTraceEquivalence(layout, { values: read.logicalValues, format: 'logical' }, read.stage.traces);
  });

  it('failed read produces an empty layout', () => {
    // includeMetadata defaults to false in DEFAULT_STATE.write, so the reader
    // has nothing to reconstruct from -> read fails.
    const state = DEFAULT_STATE;
    const values = computeValuesStage(state.shape, state.variables);
    const typed = computeTypedStage(state.shape, state.variables, values.variableValues);
    const linearized = computeLinearizedStage(state.shape, state.chunkShape, state.interleaving, state.variables, typed.typedVariableValues);
    const encoded = computeEncodedStage(linearized.chunks, linearized.linearizedChunks, state.interleaving, state.variables, state.fieldPipelines, state.chunkPipeline);
    const files = computeFilesStage(state, encoded.encodedChunks, typed.variableStats, linearized);
    const read = computeReadStage(files.files, state.shape, state.variables, state.write.magicNumber);

    expect(read.readResult.success).toBe(false);
    expect(read.stage.traces.length).toBe(0);
    const layout = buildValueBlocksLayout(state.variables, state.shape, new Map(), () => 'float64');
    expect(layout.byteLength).toBe(0);
  });
});
