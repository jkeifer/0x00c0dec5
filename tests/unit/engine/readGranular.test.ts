/**
 * Read plan Task 3: granular reader semantics.
 *
 * - schema/layout omission are split into their own failure reasons
 *   (`missing-schema` / `missing-layout`), distinct from genuinely corrupt
 *   metadata for keys that ARE present.
 * - codec_pipelines omission is explicit assume-identity: the reader proceeds
 *   as if no codecs were applied, with three distinct outcomes depending on
 *   what was actually applied at write time (nothing / non-size-changing /
 *   size-changing).
 * - descriptive omission never fails anything; the read-schema step's
 *   `found` text says so explicitly (the structural-vs-descriptive lesson).
 *
 * Built on Task 1's `metadata.include` toggles and Task 2's step log, reusing
 * readSteps.test.ts's `stateWith`/`uintVar` fixture style.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from '../../../src/engine/read.ts';
import { computePipelineStages } from '../../../src/hooks/usePipeline.ts';
import { DEFAULT_STATE, type AppState, type Variable } from '../../../src/types/state.ts';
import { hexToBytes } from '../../../src/engine/bytes.ts';

function stateWith(overrides: Partial<AppState>): AppState {
  return { ...DEFAULT_STATE, ...overrides };
}

function uintVar(name: string): Variable {
  return {
    id: name,
    name,
    color: '#98c379',
    logicalType: { type: 'integer', min: 0, max: 100, generation: 'random' },
    typeAssignment: { storageDtype: 'uint16' },
  };
}

type Serialization = 'json' | 'binary';
type Placement = 'header' | 'sidecar';

function placementState(serialization: Serialization, placement: Placement): Partial<AppState> {
  return {
    write: {
      ...DEFAULT_STATE.write,
      includeMetadata: true,
      metadataPlacement: placement,
    },
    metadata: { ...DEFAULT_STATE.metadata, serialization },
  };
}

const PLACEMENTS: [Serialization, Placement][] = [
  ['json', 'header'],
  ['json', 'sidecar'],
  ['binary', 'header'],
  ['binary', 'sidecar'],
];

describe('readFile — missing-schema / missing-layout (read plan Task 3)', () => {
  for (const [serialization, placement] of PLACEMENTS) {
    it(`schema off (${serialization}/${placement}): fails at read-schema with reason missing-schema`, () => {
      const state = stateWith({
        ...placementState(serialization, placement),
        metadata: {
          ...DEFAULT_STATE.metadata,
          serialization,
          include: { ...DEFAULT_STATE.metadata.include, schema: false },
        },
      });
      const { files } = computePipelineStages(state);
      const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('missing-schema');
        const ids = result.steps.map((s) => s.id);
        expect(ids.slice(0, 3)).toEqual(['verify-magic', 'locate-metadata', 'parse-metadata']);
        for (let i = 0; i < 3; i++) {
          expect(result.steps[i].outcome).toBe('ok');
        }
        const schemaStep = result.steps.find((s) => s.id === 'read-schema')!;
        expect(schemaStep.outcome).toBe('failed');
        expect(schemaStep.detail).toBe(result.message);
        expect(result.message.toLowerCase()).toMatch(/variable|type/);
        const layoutIdx = result.steps.findIndex((s) => s.id === 'read-layout');
        for (let i = layoutIdx; i < result.steps.length; i++) {
          expect(result.steps[i].outcome).toBe('skipped');
        }
      }
    });
  }

  it('layout off: fails at read-layout with reason missing-layout, read-schema ok first', () => {
    const state = stateWith({
      write: { ...DEFAULT_STATE.write, includeMetadata: true, metadataPlacement: 'header' },
      metadata: {
        ...DEFAULT_STATE.metadata,
        include: { ...DEFAULT_STATE.metadata.include, layout: false },
      },
    });
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('missing-layout');
      const schemaStep = result.steps.find((s) => s.id === 'read-schema')!;
      expect(schemaStep.outcome).toBe('ok');
      const layoutStep = result.steps.find((s) => s.id === 'read-layout')!;
      expect(layoutStep.outcome).toBe('failed');
      expect(layoutStep.detail).toBe(result.message);
      const locateChunksIdx = result.steps.findIndex((s) => s.id === 'locate-chunks');
      for (let i = locateChunksIdx; i < result.steps.length; i++) {
        expect(result.steps[i].outcome).toBe('skipped');
      }
    }
  });

  it('schema AND layout off: fails at read-schema (first check wins), not read-layout', () => {
    const state = stateWith({
      write: { ...DEFAULT_STATE.write, includeMetadata: true, metadataPlacement: 'header' },
      metadata: {
        ...DEFAULT_STATE.metadata,
        include: { ...DEFAULT_STATE.metadata.include, schema: false, layout: false },
      },
    });
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('missing-schema');
      const schemaStep = result.steps.find((s) => s.id === 'read-schema')!;
      expect(schemaStep.outcome).toBe('failed');
      const layoutStep = result.steps.find((s) => s.id === 'read-layout')!;
      expect(layoutStep.outcome).toBe('skipped');
    }
  });
});

describe('readFile — assume-identity codec semantics (read plan Task 3)', () => {
  for (const [serialization, placement] of PLACEMENTS) {
    it(`codecs off, no codecs actually configured (${serialization}/${placement}): honest success, "no codec info"`, () => {
      const state = stateWith({
        shape: [4, 4],
        chunkShape: [2, 2],
        variables: [uintVar('humidity')],
        fieldPipelines: { humidity: [] },
        ...placementState(serialization, placement),
        metadata: {
          ...DEFAULT_STATE.metadata,
          serialization,
          include: { ...DEFAULT_STATE.metadata.include, codecs: false },
        },
      });
      const { files, logicalValues } = computePipelineStages(state);
      const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });

      expect(result.success).toBe(true);
      if (result.success) {
        const decodeStep = result.steps.find((s) => s.id === 'decode-chunks')!;
        expect(decodeStep.outcome).toBe('ok');
        expect(decodeStep.detail ?? decodeStep.found).toContain('no codec info');
        const actual = result.reconstructedValues.get('humidity')!;
        const expected = logicalValues.get('humidity')!;
        for (let i = 0; i < expected.length; i++) {
          expect(actual[i]).toBe(expected[i]);
        }
      }
    });

    it(`codecs off, non-size-changing codec [delta] actually configured (${serialization}/${placement}): garbled success`, () => {
      const state = stateWith({
        shape: [4, 4],
        chunkShape: [2, 2],
        variables: [uintVar('humidity')],
        fieldPipelines: { humidity: [{ codec: 'delta', params: {} }] },
        ...placementState(serialization, placement),
        metadata: {
          ...DEFAULT_STATE.metadata,
          serialization,
          include: { ...DEFAULT_STATE.metadata.include, codecs: false },
        },
      });
      const { files, logicalValues } = computePipelineStages(state);
      const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });

      expect(result.success).toBe(true);
      if (result.success) {
        const decodeStep = result.steps.find((s) => s.id === 'decode-chunks')!;
        expect(decodeStep.outcome).toBe('ok');
        expect(decodeStep.detail ?? decodeStep.found).toContain('assumed raw bytes');
        const actual = result.reconstructedValues.get('humidity')!;
        const expected = logicalValues.get('humidity')!;
        let differs = false;
        for (let i = 0; i < expected.length; i++) {
          if (actual[i] !== expected[i]) {
            differs = true;
            break;
          }
        }
        expect(differs).toBe(true);
      }
    });
  }

  it('codecs off, size-changing codec [rle] actually configured: decode-error with expected-vs-actual byte counts', () => {
    const state = stateWith({
      shape: [4, 4],
      chunkShape: [2, 2],
      variables: [uintVar('humidity')],
      fieldPipelines: { humidity: [{ codec: 'rle', params: {} }] },
      write: { ...DEFAULT_STATE.write, includeMetadata: true, metadataPlacement: 'header' },
      metadata: {
        ...DEFAULT_STATE.metadata,
        include: { ...DEFAULT_STATE.metadata.include, codecs: false },
      },
    });
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('decode-error');
      const decodeStep = result.steps.find((s) => s.id === 'decode-chunks')!;
      expect(decodeStep.outcome).toBe('failed');
      expect(decodeStep.detail).toBe(result.message);
      // both an "expected" and "actual" byte count are named somewhere in the detail
      expect(decodeStep.detail).toMatch(/expected/i);
      expect(decodeStep.detail).toMatch(/actual/i);
    }
  });
});

describe('readFile — chunkIndex off regression pin (D3, unaffected by Task 3)', () => {
  it('chunkIndex off, entropy codec, single file: unchanged no-chunk-index failure', () => {
    const state = stateWith({
      shape: [4, 4],
      chunkShape: [2, 2],
      variables: [uintVar('humidity')],
      fieldPipelines: { humidity: [{ codec: 'rle', params: {} }] },
      metadata: { ...DEFAULT_STATE.metadata, include: { ...DEFAULT_STATE.metadata.include, chunkIndex: false } },
      write: { ...DEFAULT_STATE.write, includeMetadata: true },
    });
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('no-chunk-index');
      const locateChunksStep = result.steps.find((s) => s.id === 'locate-chunks')!;
      expect(locateChunksStep.outcome).toBe('failed');
    }
  });
});

describe('readFile — descriptive off (read plan Task 3)', () => {
  it('descriptive off: full success, 8x ok, read-schema found notes stats/custom entries absent and not needed', () => {
    const state = stateWith({
      write: { ...DEFAULT_STATE.write, includeMetadata: true, metadataPlacement: 'header' },
      metadata: {
        ...DEFAULT_STATE.metadata,
        include: { ...DEFAULT_STATE.metadata.include, descriptive: false },
      },
    });
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.steps.length).toBe(8);
      for (const step of result.steps) {
        expect(step.outcome).toBe('ok');
      }
      const schemaStep = result.steps.find((s) => s.id === 'read-schema')!;
      expect(schemaStep.found.toLowerCase()).toMatch(/statistic|custom/);
      expect(schemaStep.found.toLowerCase()).toMatch(/not needed|absent/);
    }
  });
});
