// PERF-1: PipelineStage no longer carries materialized chunkRegions (one
// span + traceId string per ELEMENT — the bulk of the oversized worker
// result at 8M+ values). useHexData's computeRegions now derives its two
// per-byte structures straight from the stage layout. This test pins it
// against the old chunkRegionsOf-based reference implementation: identical
// alternating-tint parity and identical boundary set, for every stage of a
// numeric state and a text-variable state (zero-width empty strings
// included), plus per-file write layouts.
import { describe, it, expect } from 'vitest';
import { computeRegions } from '../../../src/components/viewers/useHexData.ts';
import { chunkRegionsOf, type StageLayout } from '../../../src/engine/layout.ts';
import { computePipelineStages } from '../../../src/engine/pipelineCompute.ts';
import { DEFAULT_STATE } from '../../../src/types/state.ts';
import type { AppState } from '../../../src/types/state.ts';

/** The pre-PERF-1 computeRegions, verbatim: fill parity/boundaries from the
 * materialized chunkRegionsOf spans. */
function referenceRegions(bytes: Uint8Array, layout: StageLayout) {
  const regions = chunkRegionsOf(layout);
  const regionByByte = new Uint8Array(bytes.length);
  for (let r = 0; r < regions.length; r++) {
    for (let i = regions[r].startByte; i < regions[r].endByte; i++) {
      regionByByte[i] = r % 2;
    }
  }
  const boundaryByByte = new Uint8Array(bytes.length);
  for (const region of regions) {
    if (region.startByte > 0) boundaryByByte[region.startByte] = 1;
  }
  return { regionByByte, boundaryByByte };
}

function expectEquivalent(bytes: Uint8Array, layout: StageLayout, label: string) {
  const actual = computeRegions(bytes, layout);
  const reference = referenceRegions(bytes, layout);
  expect(actual.regionByByte, `${label}: regionByByte`).toEqual(reference.regionByByte);
  expect(actual.boundaryByByte, `${label}: boundaryByByte`).toEqual(reference.boundaryByByte);
}

function checkAllStages(state: AppState) {
  const result = computePipelineStages(state);
  for (const stage of result.stages) {
    expectEquivalent(stage.bytes, stage.layout, stage.name);
  }
  for (const file of result.files) {
    expectEquivalent(file.bytes, file.layout, `file ${file.name}`);
  }
}

describe('computeRegions layout-direct derivation (PERF-1)', () => {
  it('matches the chunkRegionsOf-based reference for every DEFAULT_STATE stage and file', () => {
    checkAllStages(DEFAULT_STATE);
  });

  it('matches for a text variable including zero-width (empty-string) elements', () => {
    // 'names' word set never yields empty strings from generation, so build a
    // layout with explicit empty strings via a text variable and small shape;
    // zero-width handling is exercised through the Values-stage layout's
    // offsets (buildValueBlocksLayout skips nothing, chunkRegionsOf skips
    // zero-width spans — the derivation must agree).
    const textState: AppState = {
      ...DEFAULT_STATE,
      shape: [12],
      chunkShape: [4],
      variables: [
        DEFAULT_STATE.variables[0],
        {
          ...DEFAULT_STATE.variables[0],
          id: 'label', name: 'label',
          logicalType: { type: 'text', wordSet: 'names' },
          typeAssignment: { storageDtype: 'char8' },
        },
      ],
    } as AppState;
    checkAllStages(textState);
  });

  it('handles an explicit zero-width text element', () => {
    // Direct layout fixture: 3 text elements, middle one empty.
    const offsets = new Uint32Array([0, 3, 3, 7]);
    const layout: StageLayout = {
      byteLength: 7,
      shape: [3],
      regions: [{
        kind: 'values', start: 0, byteLength: 7,
        variableName: 'v', variableColor: '#fff',
        dtype: 'text', offsets, elementCount: 3,
      }],
    };
    expectEquivalent(new Uint8Array(7), layout, 'zero-width text');
  });

  it('handles the empty layout', () => {
    expectEquivalent(new Uint8Array(0), { byteLength: 0, shape: [0], regions: [] }, 'empty');
  });
});
