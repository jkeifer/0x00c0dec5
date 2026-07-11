import { describe, it, expect } from 'vitest';
import { computePipelineStages } from '../../hooks/usePipeline.ts';
import { DEFAULT_STATE } from '../../types/state.ts';
import { STAGE_ORDER } from '../../types/pipeline.ts';
import { flatGroupCount, flatGroupAt, flatGroupIndexOf, type TraceGroup } from '../../components/viewers/viewerUtils.ts';
import { isChunkLevelTrace } from '../../engine/trace.ts';
import { referenceStageTraces } from '../helpers/referenceTraces.ts';
import type { AppState } from '../../types/state.ts';
import type { StageLayout, ValueSources } from '../../engine/layout.ts';
import type { ByteTrace } from '../../types/pipeline.ts';

/**
 * TDD reference fixture (Task 9, perf plan; rewired in Task 10): the
 * pre-Task-9 O(bytes) implementation, kept test-local (no longer exported
 * from viewerUtils.ts — production code reads nothing from materialized
 * traces after Task 10) purely to cross-check flatGroupCount/flatGroupAt's
 * region-arithmetic reimplementation against independently-derived ground
 * truth. Since Task 10 deleted `PipelineStage.traces`, this now takes the
 * stage's bytes plus its reference-tracer traces (referenceTraces.ts)
 * directly, rather than reading `stage.traces`.
 */
function groupBytesByTrace(bytes: Uint8Array, traces: ByteTrace[]): TraceGroup[] {
  const groups: TraceGroup[] = [];
  if (traces.length === 0) return groups;

  let currentId = traces[0].traceId;
  let startOffset = 0;

  for (let i = 1; i <= traces.length; i++) {
    const traceId = i < traces.length ? traces[i].traceId : null;
    if (traceId !== currentId) {
      const trace = traces[startOffset];
      groups.push({
        traceId: trace.traceId,
        variableName: trace.variableName,
        variableColor: trace.variableColor,
        coords: trace.coords,
        displayValue: trace.displayValue,
        dtype: trace.dtype,
        chunkId: trace.chunkId,
        byteOffset: startOffset,
        byteCount: i - startOffset,
        bytes: bytes.slice(startOffset, i),
        isChunkLevel: isChunkLevelTrace(trace.traceId),
      });
      if (i < traces.length) {
        currentId = traceId!;
        startOffset = i;
      }
    }
  }

  return groups;
}

// TDD reference: flatGroupCount/flatGroupAt must reproduce groupBytesByTrace's
// output exactly (order, boundaries, and all TraceGroup fields) for every
// region kind FlatView renders — values (fixed-width and text), a
// value-preserving chunk stage (column and row interleaving), and an
// entropy/chunk-level stage.
function checkMatchesGroupBytesByTrace(bytes: Uint8Array, traces: ByteTrace[], layout: StageLayout, sources: ValueSources) {
  const expected = groupBytesByTrace(bytes, traces);
  expect(flatGroupCount(layout)).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    const actual = flatGroupAt(layout, bytes, sources, i);
    const exp = expected[i];
    expect(actual.traceId, `group ${i} traceId`).toBe(exp.traceId);
    expect(actual.variableName, `group ${i} variableName`).toBe(exp.variableName);
    expect(actual.variableColor, `group ${i} variableColor`).toBe(exp.variableColor);
    expect(actual.coords, `group ${i} coords`).toEqual(exp.coords);
    expect(actual.displayValue, `group ${i} displayValue`).toBe(exp.displayValue);
    expect(actual.dtype, `group ${i} dtype`).toBe(exp.dtype);
    expect(actual.chunkId, `group ${i} chunkId`).toBe(exp.chunkId);
    expect(actual.byteOffset, `group ${i} byteOffset`).toBe(exp.byteOffset);
    expect(actual.byteCount, `group ${i} byteCount`).toBe(exp.byteCount);
    expect(actual.bytes, `group ${i} bytes`).toEqual(exp.bytes);
    expect(actual.isChunkLevel, `group ${i} isChunkLevel`).toBe(exp.isChunkLevel);
  }
}

describe('flatGroupCount / flatGroupAt', () => {
  it('matches groupBytesByTrace for the DEFAULT_STATE values stage', () => {
    const result = computePipelineStages(DEFAULT_STATE);
    const stage = result.stages[STAGE_ORDER.indexOf('values')];
    const sources = result.stageSources.get('values')!;
    const reference = referenceStageTraces(DEFAULT_STATE).get('values')!;
    checkMatchesGroupBytesByTrace(stage.bytes, reference, stage.layout, sources);
  });

  it('matches groupBytesByTrace for the DEFAULT_STATE typed stage', () => {
    const result = computePipelineStages(DEFAULT_STATE);
    const stage = result.stages[STAGE_ORDER.indexOf('typed')];
    const sources = result.stageSources.get('typed')!;
    const reference = referenceStageTraces(DEFAULT_STATE).get('typed')!;
    checkMatchesGroupBytesByTrace(stage.bytes, reference, stage.layout, sources);
  });

  it('matches groupBytesByTrace for a column-interleaved linearized stage', () => {
    const state: AppState = { ...DEFAULT_STATE, interleaving: 'column' };
    const result = computePipelineStages(state);
    const stage = result.stages[STAGE_ORDER.indexOf('linearized')];
    const sources = result.stageSources.get('linearized')!;
    const reference = referenceStageTraces(state).get('linearized')!;
    checkMatchesGroupBytesByTrace(stage.bytes, reference, stage.layout, sources);
  });

  it('matches groupBytesByTrace for a row-interleaved linearized stage', () => {
    const state: AppState = { ...DEFAULT_STATE, interleaving: 'row' };
    const result = computePipelineStages(state);
    const stage = result.stages[STAGE_ORDER.indexOf('linearized')];
    const sources = result.stageSources.get('linearized')!;
    const reference = referenceStageTraces(state).get('linearized')!;
    checkMatchesGroupBytesByTrace(stage.bytes, reference, stage.layout, sources);
  });

  it('matches groupBytesByTrace for an entropy-codec (RLE) encoded stage — chunk-level groups', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      fieldPipelines: {
        ...DEFAULT_STATE.fieldPipelines,
        humidity: [{ codec: 'rle', params: {} }],
      },
    };
    const result = computePipelineStages(state);
    const stage = result.stages[STAGE_ORDER.indexOf('encoded')];
    const sources = result.stageSources.get('encoded')!;
    const reference = referenceStageTraces(state).get('encoded')!;
    checkMatchesGroupBytesByTrace(stage.bytes, reference, stage.layout, sources);
    // Sanity: at least one group is chunk-level (entropy degrades tracing).
    const groups = Array.from({ length: flatGroupCount(stage.layout) }, (_, i) =>
      flatGroupAt(stage.layout, stage.bytes, sources, i));
    expect(groups.some((g) => g.isChunkLevel)).toBe(true);
  });

  it('matches groupBytesByTrace for a text-variable values stage, including the zero-width-string guard', () => {
    const TEXT_VAR = {
      ...DEFAULT_STATE.variables[0],
      id: 'label', name: 'label', color: '#c678dd',
      logicalType: { type: 'text', min: 0, max: 0, wordSet: 'names', generation: 'random' },
      typeAssignment: { storageDtype: 'char8' },
    } as typeof DEFAULT_STATE.variables[0];
    const state: AppState = { ...DEFAULT_STATE, variables: [...DEFAULT_STATE.variables, TEXT_VAR] };
    const result = computePipelineStages(state);
    const stage = result.stages[STAGE_ORDER.indexOf('values')];
    const sources = result.stageSources.get('values')!;
    const reference = referenceStageTraces(state).get('values')!;
    checkMatchesGroupBytesByTrace(stage.bytes, reference, stage.layout, sources);
  });

  it('matches groupBytesByTrace for a text-variable typed stage', () => {
    const TEXT_VAR = {
      ...DEFAULT_STATE.variables[0],
      id: 'label', name: 'label', color: '#c678dd',
      logicalType: { type: 'text', min: 0, max: 0, wordSet: 'names', generation: 'random' },
      typeAssignment: { storageDtype: 'char8' },
    } as typeof DEFAULT_STATE.variables[0];
    const state: AppState = { ...DEFAULT_STATE, variables: [...DEFAULT_STATE.variables, TEXT_VAR] };
    const result = computePipelineStages(state);
    const stage = result.stages[STAGE_ORDER.indexOf('typed')];
    const sources = result.stageSources.get('typed')!;
    const reference = referenceStageTraces(state).get('typed')!;
    checkMatchesGroupBytesByTrace(stage.bytes, reference, stage.layout, sources);
  });

  it('matches groupBytesByTrace for the write stage (structural + chunk regions)', () => {
    const result = computePipelineStages(DEFAULT_STATE);
    const stage = result.stages[STAGE_ORDER.indexOf('write')];
    const sources = result.stageSources.get('write')!;
    const reference = referenceStageTraces(DEFAULT_STATE).get('write')!;
    checkMatchesGroupBytesByTrace(stage.bytes, reference, stage.layout, sources);
  });

  it('throws on an out-of-range index', () => {
    const result = computePipelineStages(DEFAULT_STATE);
    const stage = result.stages[STAGE_ORDER.indexOf('values')];
    const sources = result.stageSources.get('values')!;
    expect(() => flatGroupAt(stage.layout, stage.bytes, sources, flatGroupCount(stage.layout))).toThrow();
  });

  it('returns 0 for an empty layout', () => {
    const emptyLayout: StageLayout = { byteLength: 0, shape: [], regions: [] };
    expect(flatGroupCount(emptyLayout)).toBe(0);
  });
});

describe('flatGroupIndexOf', () => {
  it('round-trips with flatGroupAt for every group in a column-interleaved linearized stage', () => {
    const state: AppState = { ...DEFAULT_STATE, interleaving: 'column' };
    const result = computePipelineStages(state);
    const stage = result.stages[STAGE_ORDER.indexOf('linearized')];
    const sources = result.stageSources.get('linearized')!;
    const count = flatGroupCount(stage.layout);
    for (let i = 0; i < count; i++) {
      const group = flatGroupAt(stage.layout, stage.bytes, sources, i);
      expect(flatGroupIndexOf(stage.layout, group.traceId)).toBe(i);
    }
  });

  it('round-trips with flatGroupAt for every group in a row-interleaved linearized stage', () => {
    const state: AppState = { ...DEFAULT_STATE, interleaving: 'row' };
    const result = computePipelineStages(state);
    const stage = result.stages[STAGE_ORDER.indexOf('linearized')];
    const sources = result.stageSources.get('linearized')!;
    const count = flatGroupCount(stage.layout);
    for (let i = 0; i < count; i++) {
      const group = flatGroupAt(stage.layout, stage.bytes, sources, i);
      expect(flatGroupIndexOf(stage.layout, group.traceId)).toBe(i);
    }
  });

  it('round-trips with flatGroupAt for a text-variable values stage (zero-width skip)', () => {
    const TEXT_VAR = {
      ...DEFAULT_STATE.variables[0],
      id: 'label', name: 'label', color: '#c678dd',
      logicalType: { type: 'text', min: 0, max: 0, wordSet: 'names', generation: 'random' },
      typeAssignment: { storageDtype: 'char8' },
    } as typeof DEFAULT_STATE.variables[0];
    const state: AppState = { ...DEFAULT_STATE, variables: [...DEFAULT_STATE.variables, TEXT_VAR] };
    const result = computePipelineStages(state);
    const stage = result.stages[STAGE_ORDER.indexOf('values')];
    const sources = result.stageSources.get('values')!;
    const count = flatGroupCount(stage.layout);
    for (let i = 0; i < count; i++) {
      const group = flatGroupAt(stage.layout, stage.bytes, sources, i);
      expect(flatGroupIndexOf(stage.layout, group.traceId)).toBe(i);
    }
  });

  it('round-trips with flatGroupAt using chunkId for an entropy (chunk-level) stage', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      fieldPipelines: {
        ...DEFAULT_STATE.fieldPipelines,
        humidity: [{ codec: 'rle', params: {} }],
      },
    };
    const result = computePipelineStages(state);
    const stage = result.stages[STAGE_ORDER.indexOf('encoded')];
    const sources = result.stageSources.get('encoded')!;
    const count = flatGroupCount(stage.layout);
    for (let i = 0; i < count; i++) {
      const group = flatGroupAt(stage.layout, stage.bytes, sources, i);
      const id = group.isChunkLevel ? group.chunkId : group.traceId;
      expect(flatGroupIndexOf(stage.layout, id)).toBe(i);
    }
  });

  it('returns undefined for an unknown traceId', () => {
    const result = computePipelineStages(DEFAULT_STATE);
    const stage = result.stages[STAGE_ORDER.indexOf('values')];
    expect(flatGroupIndexOf(stage.layout, 'nonexistent:0')).toBeUndefined();
  });
});
