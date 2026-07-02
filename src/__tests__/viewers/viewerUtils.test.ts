import { describe, it, expect } from 'vitest';
import {
  groupBytesByTrace,
  byteToHex,
  formatOffset,
  byteToAscii,
  buildTraceIndex,
  buildTraceIndexWithCounts,
  buildChunkIndex,
  buildChunkIndexWithCounts,
  buildChunkRegions,
  isDiffValue,
  computeDiffSummary,
  computeMaxAbsDiff,
  cellIndexToRowCol,
  scrollOffsetForCell,
} from '../../components/viewers/viewerUtils.ts';
import type { PipelineStage, ByteTrace } from '../../types/pipeline.ts';

function makeTrace(overrides: Partial<ByteTrace> = {}): ByteTrace {
  return {
    traceId: 'temp:0',
    variableName: 'temperature',
    variableColor: '#e06c75',
    coords: [0],
    displayValue: '42.0',
    dtype: 'float32',
    chunkId: 'chunk:0',
    byteInValue: 0,
    byteCount: 4,
    ...overrides,
  };
}

function makeStage(bytes: number[], traces: ByteTrace[]): PipelineStage {
  const b = new Uint8Array(bytes);
  return {
    name: 'Test',
    bytes: b,
    traces,
    chunkRegions: buildChunkRegions(traces),
    stats: { byteCount: b.length, entropy: 0 },
  };
}

describe('byteToHex', () => {
  it('formats single-digit bytes with leading zero', () => {
    expect(byteToHex(0)).toBe('00');
    expect(byteToHex(10)).toBe('0A');
    expect(byteToHex(15)).toBe('0F');
  });

  it('formats two-digit bytes', () => {
    expect(byteToHex(255)).toBe('FF');
    expect(byteToHex(192)).toBe('C0');
    expect(byteToHex(222)).toBe('DE');
  });
});

describe('formatOffset', () => {
  it('uses minimum width of 4', () => {
    expect(formatOffset(0, 100)).toBe('0000');
    expect(formatOffset(16, 100)).toBe('0010');
  });

  it('expands width for large files', () => {
    expect(formatOffset(0, 0x100000)).toBe('000000');
    expect(formatOffset(0x1234, 0x100000)).toBe('001234');
  });
});

describe('byteToAscii', () => {
  it('returns printable characters', () => {
    expect(byteToAscii(0x41)).toBe('A');
    expect(byteToAscii(0x7a)).toBe('z');
    expect(byteToAscii(0x20)).toBe(' ');
    expect(byteToAscii(0x7e)).toBe('~');
  });

  it('returns dot for non-printable', () => {
    expect(byteToAscii(0x00)).toBe('.');
    expect(byteToAscii(0x1f)).toBe('.');
    expect(byteToAscii(0x7f)).toBe('.');
    expect(byteToAscii(0xff)).toBe('.');
  });
});

describe('groupBytesByTrace', () => {
  it('groups consecutive bytes with same traceId', () => {
    const traces = [
      makeTrace({ traceId: 'temp:0', byteInValue: 0 }),
      makeTrace({ traceId: 'temp:0', byteInValue: 1 }),
      makeTrace({ traceId: 'temp:0', byteInValue: 2 }),
      makeTrace({ traceId: 'temp:0', byteInValue: 3 }),
      makeTrace({ traceId: 'temp:1', byteInValue: 0 }),
      makeTrace({ traceId: 'temp:1', byteInValue: 1 }),
      makeTrace({ traceId: 'temp:1', byteInValue: 2 }),
      makeTrace({ traceId: 'temp:1', byteInValue: 3 }),
    ];
    const stage = makeStage([0, 1, 2, 3, 4, 5, 6, 7], traces);
    const groups = groupBytesByTrace(stage);

    expect(groups).toHaveLength(2);
    expect(groups[0].traceId).toBe('temp:0');
    expect(groups[0].byteOffset).toBe(0);
    expect(groups[0].byteCount).toBe(4);
    expect(groups[0].bytes).toEqual(new Uint8Array([0, 1, 2, 3]));
    expect(groups[1].traceId).toBe('temp:1');
    expect(groups[1].byteOffset).toBe(4);
    expect(groups[1].byteCount).toBe(4);
  });

  it('returns empty array for empty stage', () => {
    const stage = makeStage([], []);
    expect(groupBytesByTrace(stage)).toEqual([]);
  });

  it('handles single-byte groups', () => {
    const traces = [
      makeTrace({ traceId: 'a:0', byteCount: 1 }),
      makeTrace({ traceId: 'b:0', byteCount: 1 }),
      makeTrace({ traceId: 'c:0', byteCount: 1 }),
    ];
    const stage = makeStage([10, 20, 30], traces);
    const groups = groupBytesByTrace(stage);

    expect(groups).toHaveLength(3);
    expect(groups[0].traceId).toBe('a:0');
    expect(groups[1].traceId).toBe('b:0');
    expect(groups[2].traceId).toBe('c:0');
  });

  it('detects chunk-level traces', () => {
    const traces = [
      makeTrace({ traceId: 'chunk:0', variableName: '', byteCount: 2 }),
      makeTrace({ traceId: 'chunk:0', variableName: '', byteCount: 2 }),
    ];
    const stage = makeStage([10, 20], traces);
    const groups = groupBytesByTrace(stage);

    expect(groups).toHaveLength(1);
    expect(groups[0].isChunkLevel).toBe(true);
  });

  it('marks non-chunk traces as not chunk-level', () => {
    const traces = [
      makeTrace({ traceId: 'temp:0' }),
    ];
    const stage = makeStage([10], traces);
    const groups = groupBytesByTrace(stage);

    expect(groups[0].isChunkLevel).toBe(false);
  });

  it('preserves variable metadata', () => {
    const traces = [
      makeTrace({
        traceId: 'pressure:5',
        variableName: 'pressure',
        variableColor: '#61afef',
        coords: [5],
        displayValue: '101.3',
        dtype: 'float32',
        chunkId: 'chunk:0',
      }),
    ];
    const stage = makeStage([0xab], traces);
    const groups = groupBytesByTrace(stage);

    expect(groups[0].variableName).toBe('pressure');
    expect(groups[0].variableColor).toBe('#61afef');
    expect(groups[0].coords).toEqual([5]);
    expect(groups[0].displayValue).toBe('101.3');
    expect(groups[0].dtype).toBe('float32');
    expect(groups[0].chunkId).toBe('chunk:0');
  });
});

describe('buildTraceIndex', () => {
  it('maps traceId to first byte index', () => {
    const traces = [
      makeTrace({ traceId: 'temp:0', byteInValue: 0 }),
      makeTrace({ traceId: 'temp:0', byteInValue: 1 }),
      makeTrace({ traceId: 'temp:0', byteInValue: 2 }),
      makeTrace({ traceId: 'temp:0', byteInValue: 3 }),
      makeTrace({ traceId: 'temp:1', byteInValue: 0 }),
      makeTrace({ traceId: 'temp:1', byteInValue: 1 }),
      makeTrace({ traceId: 'temp:1', byteInValue: 2 }),
      makeTrace({ traceId: 'temp:1', byteInValue: 3 }),
    ];
    const index = buildTraceIndex(traces);

    expect(index.size).toBe(2);
    expect(index.get('temp:0')).toBe(0);
    expect(index.get('temp:1')).toBe(4);
  });

  it('returns empty map for empty traces', () => {
    const index = buildTraceIndex([]);
    expect(index.size).toBe(0);
  });

  it('handles many unique traceIds', () => {
    const traces = Array.from({ length: 10 }, (_, i) =>
      makeTrace({ traceId: `v:${i}`, byteCount: 1 }),
    );
    const index = buildTraceIndex(traces);

    expect(index.size).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(index.get(`v:${i}`)).toBe(i);
    }
  });
});

describe('buildChunkIndex', () => {
  it('maps chunkId to first byte index', () => {
    const traces = [
      makeTrace({ traceId: 'temp:0', chunkId: 'chunk:0', byteInValue: 0 }),
      makeTrace({ traceId: 'temp:0', chunkId: 'chunk:0', byteInValue: 1 }),
      makeTrace({ traceId: 'temp:1', chunkId: 'chunk:0', byteInValue: 0 }),
      makeTrace({ traceId: 'temp:1', chunkId: 'chunk:0', byteInValue: 1 }),
      makeTrace({ traceId: 'temp:2', chunkId: 'chunk:1', byteInValue: 0 }),
      makeTrace({ traceId: 'temp:2', chunkId: 'chunk:1', byteInValue: 1 }),
    ];
    const index = buildChunkIndex(traces);

    expect(index.size).toBe(2);
    expect(index.get('chunk:0')).toBe(0);
    expect(index.get('chunk:1')).toBe(4);
  });

  it('returns empty map for empty traces', () => {
    const index = buildChunkIndex([]);
    expect(index.size).toBe(0);
  });

  it('uses first occurrence of each chunkId', () => {
    const traces = [
      makeTrace({ traceId: 'a:0', chunkId: 'chunk:0' }),
      makeTrace({ traceId: 'b:0', chunkId: 'chunk:1' }),
      makeTrace({ traceId: 'c:0', chunkId: 'chunk:0' }),
    ];
    const index = buildChunkIndex(traces);

    expect(index.size).toBe(2);
    expect(index.get('chunk:0')).toBe(0);
    expect(index.get('chunk:1')).toBe(1);
  });
});

describe('buildChunkRegions', () => {
  it('returns empty array for empty traces', () => {
    expect(buildChunkRegions([])).toEqual([]);
  });

  it('returns single region for contiguous same-chunkId bytes', () => {
    const traces = [
      makeTrace({ traceId: 'temp:0', chunkId: 'chunk:0' }),
      makeTrace({ traceId: 'temp:0', chunkId: 'chunk:0' }),
      makeTrace({ traceId: 'temp:1', chunkId: 'chunk:0' }),
      makeTrace({ traceId: 'temp:1', chunkId: 'chunk:0' }),
    ];
    const regions = buildChunkRegions(traces);

    expect(regions).toHaveLength(1);
    expect(regions[0]).toEqual({
      label: 'chunk:0',
      startByte: 0,
      endByte: 4,
      byteCount: 4,
    });
  });

  it('returns multiple regions for different chunks', () => {
    const traces = [
      makeTrace({ traceId: 'temp:0', chunkId: 'chunk:0' }),
      makeTrace({ traceId: 'temp:0', chunkId: 'chunk:0' }),
      makeTrace({ traceId: 'temp:1', chunkId: 'chunk:1' }),
      makeTrace({ traceId: 'temp:1', chunkId: 'chunk:1' }),
      makeTrace({ traceId: 'temp:2', chunkId: 'chunk:1' }),
    ];
    const regions = buildChunkRegions(traces);

    expect(regions).toHaveLength(2);
    expect(regions[0]).toEqual({
      label: 'chunk:0',
      startByte: 0,
      endByte: 2,
      byteCount: 2,
    });
    expect(regions[1]).toEqual({
      label: 'chunk:1',
      startByte: 2,
      endByte: 5,
      byteCount: 3,
    });
  });

  it('handles mixed structural regions', () => {
    const traces = [
      makeTrace({ traceId: 'magic:start', chunkId: '', variableName: '' }),
      makeTrace({ traceId: 'magic:start', chunkId: '', variableName: '' }),
      makeTrace({ traceId: 'metadata', chunkId: '', variableName: '' }),
      makeTrace({ traceId: 'metadata', chunkId: '', variableName: '' }),
      makeTrace({ traceId: 'metadata', chunkId: '', variableName: '' }),
      makeTrace({ traceId: 'chunk:0', chunkId: 'chunk:0', variableName: '' }),
      makeTrace({ traceId: 'chunk:0', chunkId: 'chunk:0', variableName: '' }),
      makeTrace({ traceId: 'chunk:1', chunkId: 'chunk:1', variableName: '' }),
      makeTrace({ traceId: 'chunk:1', chunkId: 'chunk:1', variableName: '' }),
      makeTrace({ traceId: 'magic:end', chunkId: '', variableName: '' }),
    ];
    const regions = buildChunkRegions(traces);

    expect(regions).toHaveLength(5);
    expect(regions[0].label).toBe('magic:start');
    expect(regions[0].startByte).toBe(0);
    expect(regions[0].endByte).toBe(2);
    expect(regions[1].label).toBe('metadata');
    expect(regions[1].startByte).toBe(2);
    expect(regions[1].endByte).toBe(5);
    expect(regions[2].label).toBe('chunk:0');
    expect(regions[2].startByte).toBe(5);
    expect(regions[2].endByte).toBe(7);
    expect(regions[3].label).toBe('chunk:1');
    expect(regions[3].startByte).toBe(7);
    expect(regions[3].endByte).toBe(9);
    expect(regions[4].label).toBe('magic:end');
    expect(regions[4].startByte).toBe(9);
    expect(regions[4].endByte).toBe(10);
  });

  it('uses traceId as fallback when chunkId is empty', () => {
    const traces = [
      makeTrace({ traceId: 'temp:0', chunkId: '' }),
      makeTrace({ traceId: 'temp:0', chunkId: '' }),
      makeTrace({ traceId: 'temp:1', chunkId: '' }),
    ];
    const regions = buildChunkRegions(traces);

    expect(regions).toHaveLength(2);
    expect(regions[0].label).toBe('temp:0');
    expect(regions[1].label).toBe('temp:1');
  });
});

describe('buildTraceIndexWithCounts', () => {
  it('returns empty map for empty traces', () => {
    const index = buildTraceIndexWithCounts([]);
    expect(index.size).toBe(0);
  });

  it('maps traceId to firstByte, lastByte, and count', () => {
    const traces = [
      makeTrace({ traceId: 'temp:0', byteInValue: 0 }),
      makeTrace({ traceId: 'temp:0', byteInValue: 1 }),
      makeTrace({ traceId: 'temp:0', byteInValue: 2 }),
      makeTrace({ traceId: 'temp:0', byteInValue: 3 }),
      makeTrace({ traceId: 'temp:1', byteInValue: 0 }),
      makeTrace({ traceId: 'temp:1', byteInValue: 1 }),
    ];
    const index = buildTraceIndexWithCounts(traces);

    expect(index.size).toBe(2);
    expect(index.get('temp:0')).toEqual({ firstByte: 0, lastByte: 3, count: 4 });
    expect(index.get('temp:1')).toEqual({ firstByte: 4, lastByte: 5, count: 2 });
  });

  it('handles non-contiguous traces with same traceId', () => {
    const traces = [
      makeTrace({ traceId: 'a:0' }),
      makeTrace({ traceId: 'b:0' }),
      makeTrace({ traceId: 'a:0' }),
    ];
    const index = buildTraceIndexWithCounts(traces);

    expect(index.get('a:0')).toEqual({ firstByte: 0, lastByte: 2, count: 2 });
    expect(index.get('b:0')).toEqual({ firstByte: 1, lastByte: 1, count: 1 });
  });

  it('handles single-byte entries', () => {
    const traces = [
      makeTrace({ traceId: 'x:0', byteCount: 1 }),
    ];
    const index = buildTraceIndexWithCounts(traces);

    expect(index.get('x:0')).toEqual({ firstByte: 0, lastByte: 0, count: 1 });
  });
});

describe('buildChunkIndexWithCounts', () => {
  it('returns empty map for empty traces', () => {
    const index = buildChunkIndexWithCounts([]);
    expect(index.size).toBe(0);
  });

  it('maps chunkId to firstByte, lastByte, and count', () => {
    const traces = [
      makeTrace({ traceId: 'temp:0', chunkId: 'chunk:0' }),
      makeTrace({ traceId: 'temp:0', chunkId: 'chunk:0' }),
      makeTrace({ traceId: 'temp:1', chunkId: 'chunk:0' }),
      makeTrace({ traceId: 'temp:2', chunkId: 'chunk:1' }),
      makeTrace({ traceId: 'temp:2', chunkId: 'chunk:1' }),
    ];
    const index = buildChunkIndexWithCounts(traces);

    expect(index.size).toBe(2);
    expect(index.get('chunk:0')).toEqual({ firstByte: 0, lastByte: 2, count: 3 });
    expect(index.get('chunk:1')).toEqual({ firstByte: 3, lastByte: 4, count: 2 });
  });

  it('skips traces with empty chunkId', () => {
    const traces = [
      makeTrace({ traceId: 'magic:start', chunkId: '' }),
      makeTrace({ traceId: 'temp:0', chunkId: 'chunk:0' }),
    ];
    const index = buildChunkIndexWithCounts(traces);

    expect(index.size).toBe(1);
    expect(index.has('')).toBe(false);
    expect(index.get('chunk:0')).toEqual({ firstByte: 1, lastByte: 1, count: 1 });
  });
});

// Task 4.5 (remediation-plan.md, fixes UI-14/UI-5): NaN-aware diff equality
// and the diff summary stats extracted as pure functions so they're testable
// without rendering TableView/GridView.
describe('isDiffValue', () => {
  it('treats equal numbers as not a diff', () => {
    expect(isDiffValue(1, 1)).toBe(false);
    expect(isDiffValue(0, 0)).toBe(false);
    expect(isDiffValue(-3.5, -3.5)).toBe(false);
  });

  it('treats different numbers as a diff', () => {
    expect(isDiffValue(1, 2)).toBe(true);
    expect(isDiffValue(42.7134, 42.7)).toBe(true);
  });

  it('treats NaN vs NaN as NOT a diff (fixes UI-14)', () => {
    expect(isDiffValue(NaN, NaN)).toBe(false);
  });

  it('treats NaN vs a real number as a diff', () => {
    expect(isDiffValue(NaN, 5)).toBe(true);
    expect(isDiffValue(5, NaN)).toBe(true);
  });

  it('treats -0 vs 0 as not a diff', () => {
    expect(isDiffValue(-0, 0)).toBe(false);
    expect(isDiffValue(0, -0)).toBe(false);
  });
});

describe('computeDiffSummary', () => {
  it('returns zeroed summary when there are no differences', () => {
    const summary = computeDiffSummary([1, 2, 3], [1, 2, 3]);
    expect(summary).toEqual({ count: 0, maxAbsError: 0, meanAbsError: 0 });
  });

  it('counts differing values and computes max/mean abs error', () => {
    // diffs: |1-1|=0 (no diff), |5-2|=3, |10-3|=7
    const summary = computeDiffSummary([1, 5, 10], [1, 2, 3]);
    expect(summary.count).toBe(2);
    expect(summary.maxAbsError).toBe(7);
    expect(summary.meanAbsError).toBeCloseTo(5, 10);
  });

  it('excludes NaN-vs-NaN pairs from the diff count (fixes UI-14)', () => {
    const summary = computeDiffSummary([1, NaN, 3], [1, NaN, 5]);
    expect(summary.count).toBe(1);
    expect(summary.maxAbsError).toBe(2);
  });

  it('guards length mismatches by only comparing overlapping indices (fixes UI-5)', () => {
    // origValues is shorter — index 2 has no original to compare against.
    const summary = computeDiffSummary([1, 2, 100], [1, 2]);
    expect(summary.count).toBe(0);
    expect(Number.isNaN(summary.maxAbsError)).toBe(false);
    expect(Number.isNaN(summary.meanAbsError)).toBe(false);
  });

  it('returns empty summary for empty arrays', () => {
    expect(computeDiffSummary([], [])).toEqual({ count: 0, maxAbsError: 0, meanAbsError: 0 });
  });
});

describe('computeMaxAbsDiff', () => {
  it('returns 0 when values are identical', () => {
    expect(computeMaxAbsDiff([1, 2, 3], [1, 2, 3])).toBe(0);
  });

  it('returns the largest absolute difference', () => {
    expect(computeMaxAbsDiff([1, 5, 10], [1, 2, 3])).toBe(7);
    expect(computeMaxAbsDiff([-10, 0], [0, 0])).toBe(10);
  });

  it('never produces NaN on length mismatch (fixes UI-5)', () => {
    const result = computeMaxAbsDiff([1, 2, 100, 200], [1, 2]);
    expect(Number.isNaN(result)).toBe(false);
    expect(result).toBe(0);
  });

  it('excludes NaN-vs-NaN pairs', () => {
    expect(computeMaxAbsDiff([NaN, 5], [NaN, 2])).toBe(3);
  });

  it('does not let a NaN pair poison the running max (no NaN propagation)', () => {
    // If NaN leaked into the running max via Math.max, every subsequent
    // comparison would also become NaN.
    const result = computeMaxAbsDiff([NaN, 5, 10], [NaN, 2, 3]);
    expect(Number.isNaN(result)).toBe(false);
    expect(result).toBe(7);
  });
});

describe('cellIndexToRowCol', () => {
  it('computes row/col for a grid with given column count', () => {
    expect(cellIndexToRowCol(0, 4)).toEqual({ row: 0, col: 0 });
    expect(cellIndexToRowCol(3, 4)).toEqual({ row: 0, col: 3 });
    expect(cellIndexToRowCol(4, 4)).toEqual({ row: 1, col: 0 });
    expect(cellIndexToRowCol(9, 4)).toEqual({ row: 2, col: 1 });
  });

  it('handles cols <= 0 without dividing by zero', () => {
    expect(cellIndexToRowCol(5, 0)).toEqual({ row: 0, col: 0 });
  });
});

describe('scrollOffsetForCell', () => {
  const viewport = { scrollTop: 0, scrollLeft: 0, clientWidth: 100, clientHeight: 100 };

  it('does not scroll when the cell is already fully visible', () => {
    // cols=10, cellSize=10 -> cell 0 occupies [0,10)x[0,10), well within view
    const result = scrollOffsetForCell(0, 10, 10, viewport);
    expect(result).toEqual({ scrollTop: 0, scrollLeft: 0 });
  });

  it('scrolls down/right (nearest) when the cell is below/right of the viewport', () => {
    // cols=10, cellSize=20 -> row = floor(idx/10). idx=59 -> row=5,col=9
    // cellTop = 100, cellBottom = 120; clientHeight=100 -> scrollTop should
    // become cellBottom - clientHeight = 20
    const result = scrollOffsetForCell(59, 10, 20, viewport);
    expect(result.scrollTop).toBe(20);
    // cellLeft = 9*20 = 180, cellRight = 200; clientWidth=100 -> scrollLeft = 100
    expect(result.scrollLeft).toBe(100);
  });

  it('scrolls up/left (nearest) when the cell is above/left of the current scroll position', () => {
    const scrolledViewport = { scrollTop: 500, scrollLeft: 500, clientWidth: 100, clientHeight: 100 };
    // cell 0 at (0,0), cellSize 20 -> well above/left of scroll position 500
    const result = scrollOffsetForCell(0, 10, 20, scrolledViewport);
    expect(result.scrollTop).toBe(0);
    expect(result.scrollLeft).toBe(0);
  });

  it('leaves scroll position unchanged on the axis the cell is already visible on', () => {
    const scrolledViewport = { scrollTop: 50, scrollLeft: 0, clientWidth: 100, clientHeight: 100 };
    // idx=0 -> row 0, col 0; cellTop=0 < scrollTop=50 -> scrolls up to 0
    const result = scrollOffsetForCell(0, 10, 20, scrolledViewport);
    expect(result.scrollTop).toBe(0);
    expect(result.scrollLeft).toBe(0);
  });
});
