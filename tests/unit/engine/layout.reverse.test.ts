import { describe, it, expect } from 'vitest';
import { DEFAULT_STATE } from '../../../src/types/state.ts';
import {
  computeValuesStage, computeTypedStage, computeLinearizedStage, computeEncodedStage,
  computeFilesStage,
} from '../../../src/hooks/usePipeline.ts';
import {
  buildLinearizedLayout, buildEncodedLayout, buildValueBlocksLayout, encodedChunkMeta, traceAt,
  byteRangesForTrace, chunkRegionsOf, elementInChunk, chunkIdForElement,
  type StageLayout, type ValueSources, type ChunkTraceMode, type ChunkFieldLayout, type ChunkBlockRegion,
} from '../../../src/engine/layout.ts';
import { buildChunkRegions } from '../../../src/components/viewers/viewerUtils.ts';
import { referenceStageTraces, referenceFileTraces } from '../helpers/referenceTraces.ts';
import type { AppState } from '../../../src/types/state.ts';
import { getDtype } from '../../../src/types/dtypes.ts';
import type { DtypeKey, LogicalValue } from '../../../src/types/dtypes.ts';

// A text variable exercises the variable-stride offsets path (same pattern as
// layout.equivalence.test.ts's TEXT_VAR).
const TEXT_VAR = {
  ...DEFAULT_STATE.variables[0],
  id: 'label', name: 'label', color: '#c678dd',
  logicalType: { type: 'text', min: 0, max: 0, wordSet: 'names', generation: 'random' },
  typeAssignment: { storageDtype: 'char8' },
} as typeof DEFAULT_STATE.variables[0];

const VALUES_CASES = [
  { name: 'default 3-var', state: DEFAULT_STATE },
  { name: 'with text var', state: { ...DEFAULT_STATE, variables: [...DEFAULT_STATE.variables, TEXT_VAR] } },
];

// Reduced matrix per the brief: Task 3's column-multi + row-multi, Task 4's
// rle case, Task 5's single-file write case.
type MatrixCase = {
  name: string;
  interleaving: 'row' | 'column';
  shape: number[];
  chunkShape: number[];
  useEntropy?: boolean;
  order?: 'c' | 'fortran' | 'morton';
};

const MATRIX: MatrixCase[] = [
  { name: 'column multi chunk', interleaving: 'column', shape: [4, 8], chunkShape: [2, 4] },
  { name: 'row multi chunk', interleaving: 'row', shape: [4, 8], chunkShape: [2, 4] },
  { name: 'rle (entropy)', interleaving: 'column', shape: [4, 8], chunkShape: [2, 4], useEntropy: true },
  // cl-6: non-'c' orders through the same trace-inversion + chunkRegions
  // equivalence harness, both interleavings, edge-clipped chunks.
  { name: 'fortran column edge-clipped', interleaving: 'column', shape: [6, 4], chunkShape: [4, 3], order: 'fortran' },
  { name: 'fortran row edge-clipped', interleaving: 'row', shape: [6, 4], chunkShape: [4, 3], order: 'fortran' },
  { name: 'morton column edge-clipped', interleaving: 'column', shape: [6, 4], chunkShape: [4, 3], order: 'morton' },
  { name: 'morton row edge-clipped', interleaving: 'row', shape: [6, 4], chunkShape: [4, 3], order: 'morton' },
];

function buildStages(c: MatrixCase) {
  const state: AppState = {
    ...DEFAULT_STATE,
    dataModel: 'array',
    shape: c.shape,
    chunkShape: c.chunkShape,
    interleaving: c.interleaving,
    linearization: c.order ?? 'c',
    fieldPipelines: c.useEntropy
      ? Object.fromEntries(DEFAULT_STATE.variables.map((v) => [v.id, [{ codec: 'rle' as const, params: {} }]]))
      : DEFAULT_STATE.fieldPipelines,
  };
  const values = computeValuesStage(state.shape, state.variables);
  const typed = computeTypedStage(state.shape, state.variables, values.variableValues);
  const lin = computeLinearizedStage(state.shape, state.chunkShape, state.interleaving, state.variables, typed.typedVariableValues, state.linearization);
  const linLayout = buildLinearizedLayout(lin.chunks, lin.linearizedChunks, state.interleaving, state.shape, state.chunkShape, state.linearization);

  const enc = computeEncodedStage(lin.chunks, lin.linearizedChunks, state.interleaving, state.variables, state.fieldPipelines, state.chunkPipeline, linLayout);

  const nameToId = new Map(state.variables.map((v) => [v.name, v.id]));
  const slotFields: ChunkFieldLayout[][] = [];
  const traceModes: ChunkTraceMode[] = [];
  lin.chunks.forEach((chunk, idx) => {
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
    traceModes.push(meta.traceMode);
    const region = linLayout.regions[idx] as ChunkBlockRegion;
    const slotSize = getDtype(meta.slotDtype as DtypeKey).size;
    slotFields.push(region.fields.length === 1
      ? [{ ...region.fields[0], dtype: meta.slotDtype, size: slotSize }]
      : region.fields.map((f) => ({ ...f, dtype: meta.slotDtype })));
  });
  const encLayout = buildEncodedLayout(linLayout, enc.encodedChunks, slotFields, traceModes);

  const files = computeFilesStage(state, enc.encodedChunks, typed.variableStats, encLayout);

  return {
    state,
    typedSources: { values: typed.typedVariableValues, format: 'typed' as const } satisfies ValueSources,
    linLayout,
    encLayout,
    files: files.files,
  };
}

function checkInversion(layout: StageLayout, sources: ValueSources) {
  for (let i = 0; i < layout.byteLength; i++) {
    const trace = traceAt(layout, i, sources);
    expect(trace, `traceAt at byte ${i}`).not.toBeNull();
    const ranges = byteRangesForTrace(layout, trace!.traceId);
    const inRange = ranges.some((r) => i >= r.start && i < r.end);
    expect(inRange, `byte ${i} (traceId ${trace!.traceId}) not covered by its own ranges: ${JSON.stringify(ranges)}`).toBe(true);
    for (const r of ranges) {
      for (let b = r.start; b < r.end; b++) {
        const bTrace = traceAt(layout, b, sources);
        expect(bTrace?.traceId, `byte ${b} in range for traceId ${trace!.traceId}`).toBe(trace!.traceId);
      }
    }
  }
}

describe('byteRangesForTrace inverts traceAt', () => {
  for (const c of MATRIX) {
    it(`${c.name}: linearized stage`, () => {
      const { linLayout, typedSources } = buildStages(c);
      checkInversion(linLayout, typedSources);
    });

    it(`${c.name}: encoded stage`, () => {
      const { encLayout, typedSources } = buildStages(c);
      checkInversion(encLayout, typedSources);
    });
  }

  it('write stage (single-file layout)', () => {
    const { files, typedSources } = buildStages(MATRIX[0]);
    for (const file of files) {
      checkInversion(file.layout, typedSources);
    }
  });
});

describe('chunkRegionsOf equivalence', () => {
  for (const c of MATRIX) {
    it(`${c.name}: linearized stage`, () => {
      const { state, linLayout } = buildStages(c);
      const reference = referenceStageTraces(state).get('linearized')!;
      expect(chunkRegionsOf(linLayout)).toEqual(buildChunkRegions(reference));
    });

    it(`${c.name}: encoded stage`, () => {
      const { state, encLayout } = buildStages(c);
      const reference = referenceStageTraces(state).get('encoded')!;
      expect(chunkRegionsOf(encLayout)).toEqual(buildChunkRegions(reference));
    });
  }

  it('write stage (per file)', () => {
    const { state, files } = buildStages(MATRIX[0]);
    const referenceFiles = referenceFileTraces(state);
    files.forEach((file, i) => {
      expect(chunkRegionsOf(file.layout)).toEqual(buildChunkRegions(referenceFiles[i].traces));
    });
  });

  for (const c of VALUES_CASES) {
    it(`${c.name}: values stage`, () => {
      const values = computeValuesStage(c.state.shape, c.state.variables);
      const layout = buildValueBlocksLayout(
        c.state.variables, c.state.shape, values.variableValues,
        (name) => (values.variableValues.get(name) ?? []).some((v) => typeof v === 'string') ? 'text' : 'float64',
      );
      const reference = referenceStageTraces(c.state).get('values')!;
      expect(chunkRegionsOf(layout)).toEqual(buildChunkRegions(reference));
    });

    it(`${c.name}: typed stage`, () => {
      const values = computeValuesStage(c.state.shape, c.state.variables);
      const typed = computeTypedStage(c.state.shape, c.state.variables, values.variableValues);
      const layout = buildValueBlocksLayout(
        c.state.variables, c.state.shape, typed.typedVariableValues,
        (name) => c.state.variables.find((v) => v.name === name)!.typeAssignment.storageDtype,
      );
      const reference = referenceStageTraces(c.state).get('typed')!;
      expect(chunkRegionsOf(layout)).toEqual(buildChunkRegions(reference));
    });
  }

  it('values stage: zero-width text element emits no region (matches buildLogicalValuesStage emitting zero traces)', () => {
    // Hand-built values map with an empty string at index 1 — no need to
    // route through generateValues; buildValueBlocksLayout only needs the
    // values map and a dtype-lookup callback.
    const variables = [{ name: 'label', color: '#c678dd' }];
    const values = new Map<string, LogicalValue[]>([['label', ['abc', '', 'de']]]);
    const layout = buildValueBlocksLayout(variables, [3], values, () => 'text');

    const regions = chunkRegionsOf(layout);
    // Exactly two regions: 'abc' (3 bytes) and 'de' (2 bytes) — the empty
    // string at index 1 contributes no region at all.
    expect(regions).toHaveLength(2);
    expect(regions[0].byteCount).toBe(3);
    expect(regions[1].byteCount).toBe(2);
    expect(regions[0].endByte).toBe(regions[1].startByte); // contiguous, no gap byte for the empty element

    // Neighbors stay consistent: traceAt/byteRangesForTrace for 'abc' (index
    // 0) and 'de' (index 2) are unaffected by the skipped zero-width element.
    const sources: ValueSources = { values, format: 'logical' };
    const abcTrace = traceAt(layout, 0, sources);
    expect(abcTrace?.coords).toEqual([0]);
    const abcRanges = byteRangesForTrace(layout, abcTrace!.traceId);
    expect(abcRanges).toEqual([{ start: 0, end: 3 }]);

    const deTrace = traceAt(layout, 3, sources);
    expect(deTrace?.coords).toEqual([2]);
    const deRanges = byteRangesForTrace(layout, deTrace!.traceId);
    expect(deRanges).toEqual([{ start: 3, end: 5 }]);
  });

  it('values stage (structural-only sanity: metadata layout)', () => {
    // Zero-region / empty layout edge case.
    const empty: StageLayout = { byteLength: 0, shape: [], regions: [] };
    expect(chunkRegionsOf(empty)).toEqual([]);
  });
});

describe('chunk membership (elementInChunk / chunkIdForElement)', () => {
  for (const c of MATRIX.filter((m) => !m.useEntropy)) {
    it(c.name, () => {
      const { linLayout } = buildStages(c);
      for (const region of linLayout.regions) {
        if (region.kind !== 'chunk') continue;
        const elementCount = region.elementDims.reduce((a, b) => a * b, 1);
        for (let flat = 0; flat < elementCount; flat++) {
          // local coords within this chunk, mapped to global coords
          const local: number[] = [];
          let rem = flat;
          for (let d = region.elementDims.length - 1; d >= 0; d--) {
            local[d] = rem % region.elementDims[d];
            rem = Math.floor(rem / region.elementDims[d]);
          }
          const coords = local.map((l, d) => region.origin[d] + l);
          for (const field of region.fields) {
            const id = chunkIdForElement(field.variableName, coords, c.chunkShape, c.interleaving);
            expect(elementInChunk(id, field.variableName, coords, c.chunkShape)).toBe(true);

            // A neighboring chunk (shift the first dim's coordinate by one
            // full chunkShape, staying in-bounds) must NOT match.
            if (c.shape[0] > c.chunkShape[0]) {
              const neighborCoords = [...coords];
              const shifted = coords[0] + c.chunkShape[0];
              if (shifted < c.shape[0]) {
                neighborCoords[0] = shifted;
                const neighborId = chunkIdForElement(field.variableName, neighborCoords, c.chunkShape, c.interleaving);
                expect(elementInChunk(neighborId, field.variableName, coords, c.chunkShape)).toBe(false);
              }
            }
          }
        }
      }
    });
  }
});
