import { describe, it, expect } from 'vitest';
import { DEFAULT_STATE } from '../../types/state.ts';
import {
  computeValuesStage, computeTypedStage, computeLinearizedStage, computeEncodedStage,
  computeFilesStage,
} from '../../hooks/usePipeline.ts';
import {
  buildLinearizedLayout, buildEncodedLayout, encodedChunkMeta, traceAt,
  byteRangesForTrace, chunkRegionsOf, elementInChunk, chunkIdForElement,
  type StageLayout, type ValueSources,
} from '../../engine/layout.ts';
import { buildChunkRegions } from '../../components/viewers/viewerUtils.ts';
import type { PipelineStage } from '../../types/pipeline.ts';
import type { AppState } from '../../types/state.ts';
import type { DtypeKey } from '../../types/dtypes.ts';

// Reduced matrix per the brief: Task 3's column-multi + row-multi, Task 4's
// rle case, Task 5's single-file write case.
type MatrixCase = {
  name: string;
  interleaving: 'row' | 'column';
  shape: number[];
  chunkShape: number[];
  useEntropy?: boolean;
};

const MATRIX: MatrixCase[] = [
  { name: 'column multi chunk', interleaving: 'column', shape: [4, 8], chunkShape: [2, 4] },
  { name: 'row multi chunk', interleaving: 'row', shape: [4, 8], chunkShape: [2, 4] },
  { name: 'rle (entropy)', interleaving: 'column', shape: [4, 8], chunkShape: [2, 4], useEntropy: true },
];

function buildStages(c: MatrixCase) {
  const state: AppState = {
    ...DEFAULT_STATE,
    shape: c.shape,
    chunkShape: c.chunkShape,
    interleaving: c.interleaving,
    fieldPipelines: c.useEntropy
      ? Object.fromEntries(DEFAULT_STATE.variables.map((v) => [v.id, [{ codec: 'rle' as const, params: {} }]]))
      : DEFAULT_STATE.fieldPipelines,
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

  const files = computeFilesStage(state, enc.encodedChunks, typed.variableStats, lin);

  return {
    state,
    typedSources: { values: typed.typedVariableValues, format: 'typed' as const } satisfies ValueSources,
    linLayout, linStage: lin.stage,
    encLayout, encStage: enc.stage,
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
      const { linLayout, linStage } = buildStages(c);
      expect(chunkRegionsOf(linLayout)).toEqual(buildChunkRegions(linStage.traces));
    });

    it(`${c.name}: encoded stage`, () => {
      const { encLayout, encStage } = buildStages(c);
      expect(chunkRegionsOf(encLayout)).toEqual(buildChunkRegions(encStage.traces));
    });
  }

  it('write stage (per file)', () => {
    const { files } = buildStages(MATRIX[0]);
    for (const file of files) {
      expect(chunkRegionsOf(file.layout)).toEqual(buildChunkRegions(file.traces as PipelineStage['traces']));
    }
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
