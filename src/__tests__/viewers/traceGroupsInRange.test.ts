import { describe, it, expect } from 'vitest';
import { computePipelineStages } from '../../hooks/usePipeline.ts';
import { DEFAULT_STATE } from '../../types/state.ts';
import { STAGE_ORDER } from '../../types/pipeline.ts';
import { groupBytesByTrace, traceGroupsInRange } from '../../components/viewers/viewerUtils.ts';

describe('traceGroupsInRange', () => {
  it('matches groupBytesByTrace sliced to a window, for a DEFAULT_STATE stage', () => {
    const result = computePipelineStages(DEFAULT_STATE);
    const stageIndex = STAGE_ORDER.indexOf('values');
    const stage = result.stages[stageIndex];
    const sources = result.stageSources.get('values')!;

    expect(stage.bytes.length).toBeGreaterThan(16);

    const windowStart = 4;
    const windowEnd = 20;
    const expected = groupBytesByTrace(stage).filter(
      (g) => g.byteOffset < windowEnd && g.byteOffset + g.byteCount > windowStart,
    );
    const actual = traceGroupsInRange(stage.layout, stage.bytes, sources, windowStart, windowEnd);

    // Window-local clipping (documented on traceGroupsInRange): compare
    // everything except byteOffset/byteCount/bytes, which may be clipped to
    // the window when a group straddles a boundary.
    expect(actual.length).toBe(expected.length);
    actual.forEach((group, i) => {
      const exp = expected[i];
      expect(group.traceId).toBe(exp.traceId);
      expect(group.variableName).toBe(exp.variableName);
      expect(group.variableColor).toBe(exp.variableColor);
      expect(group.coords).toEqual(exp.coords);
      expect(group.displayValue).toBe(exp.displayValue);
      expect(group.dtype).toBe(exp.dtype);
      expect(group.chunkId).toBe(exp.chunkId);
      expect(group.isChunkLevel).toBe(exp.isChunkLevel);

      const clippedStart = Math.max(exp.byteOffset, windowStart);
      const clippedEnd = Math.min(exp.byteOffset + exp.byteCount, windowEnd);
      expect(group.byteOffset).toBe(clippedStart);
      expect(group.byteCount).toBe(clippedEnd - clippedStart);
      expect(group.bytes).toEqual(stage.bytes.slice(clippedStart, clippedEnd));
    });
  });

  it('matches groupBytesByTrace sliced to a window, for an entropy-codec (RLE) stage', () => {
    const state = {
      ...DEFAULT_STATE,
      fieldPipelines: {
        ...DEFAULT_STATE.fieldPipelines,
        humidity: [{ codec: 'rle', params: {} }],
      },
    };
    const result = computePipelineStages(state);
    const stageIndex = STAGE_ORDER.indexOf('encoded');
    const stage = result.stages[stageIndex];
    const sources = result.stageSources.get('encoded')!;

    expect(stage.bytes.length).toBeGreaterThan(8);

    // humidity is chunk-level after RLE; column interleaving means its chunk
    // comes after temperature/pressure's chunks, so find its region directly
    // rather than assuming it falls in the first N bytes.
    const humidityRegion = stage.chunkRegions.find((r) => r.label.startsWith('chunk:humidity'));
    expect(humidityRegion).toBeDefined();
    const windowStart = humidityRegion!.startByte;
    const windowEnd = Math.min(windowStart + 12, stage.bytes.length);
    const expected = groupBytesByTrace(stage).filter(
      (g) => g.byteOffset < windowEnd && g.byteOffset + g.byteCount > windowStart,
    );
    const actual = traceGroupsInRange(stage.layout, stage.bytes, sources, windowStart, windowEnd);

    expect(actual.length).toBe(expected.length);
    actual.forEach((group, i) => {
      const exp = expected[i];
      expect(group.traceId).toBe(exp.traceId);
      expect(group.chunkId).toBe(exp.chunkId);
      expect(group.isChunkLevel).toBe(exp.isChunkLevel);

      const clippedStart = Math.max(exp.byteOffset, windowStart);
      const clippedEnd = Math.min(exp.byteOffset + exp.byteCount, windowEnd);
      expect(group.byteOffset).toBe(clippedStart);
      expect(group.byteCount).toBe(clippedEnd - clippedStart);
    });
    // At least one group in this window should be chunk-level (entropy
    // degrades tracing to chunk level per CLAUDE.md pitfall 1).
    expect(actual.some((g) => g.isChunkLevel)).toBe(true);
  });

  it('returns an empty array when the window is empty or out of range', () => {
    const result = computePipelineStages(DEFAULT_STATE);
    const stage = result.stages[STAGE_ORDER.indexOf('values')];
    const sources = result.stageSources.get('values')!;

    expect(traceGroupsInRange(stage.layout, stage.bytes, sources, 5, 5)).toEqual([]);
    expect(traceGroupsInRange(stage.layout, stage.bytes, sources, 10, 5)).toEqual([]);
    expect(
      traceGroupsInRange(stage.layout, stage.bytes, sources, stage.bytes.length + 100, stage.bytes.length + 200),
    ).toEqual([]);
  });
});
