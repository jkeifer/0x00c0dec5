import { describe, it, expect } from 'vitest';
import {
  byteToHex,
  formatOffset,
  byteToAscii,
  buildChunkRegions,
  isDiffValue,
  computeDiffSummary,
  computeMaxAbsDiff,
  cellIndexToRowCol,
  scrollOffsetForCell,
} from '../../../src/components/viewers/viewerUtils.ts';
import type { ByteTrace } from '../../../src/types/pipeline.ts';

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

  it('centers the cell when it is below/right of the viewport', () => {
    // cols=10, cellSize=20 -> row = floor(idx/10). idx=59 -> row=5,col=9
    // cellTop = 100, out of view -> centered: 100 - (100-20)/2 = 60
    const result = scrollOffsetForCell(59, 10, 20, viewport);
    expect(result.scrollTop).toBe(60);
    // cellLeft = 9*20 = 180, out of view -> centered: 180 - 40 = 140
    expect(result.scrollLeft).toBe(140);
  });

  it('centers (clamped to 0) when the cell is above/left of the current scroll position', () => {
    const scrolledViewport = { scrollTop: 500, scrollLeft: 500, clientWidth: 100, clientHeight: 100 };
    // cell 0 at (0,0), cellSize 20 -> centered would be 0 - 40 = -40, clamped to 0
    const result = scrollOffsetForCell(0, 10, 20, scrolledViewport);
    expect(result.scrollTop).toBe(0);
    expect(result.scrollLeft).toBe(0);
  });

  it('leaves scroll position unchanged on the axis the cell is already visible on', () => {
    const scrolledViewport = { scrollTop: 50, scrollLeft: 30, clientWidth: 100, clientHeight: 100 };
    // idx=0 -> row 0, col 0; cellTop=0 < scrollTop=50 -> centers vertically
    // (clamped to 0); horizontally the cell [0,20) is NOT visible either
    // (scrollLeft 30) -> also centered/clamped to 0.
    const result = scrollOffsetForCell(0, 10, 20, scrolledViewport);
    expect(result.scrollTop).toBe(0);
    expect(result.scrollLeft).toBe(0);
  });

  it('changes only the out-of-view axis, keeping the visible axis put', () => {
    // idx=51 -> row 5, col 1; cellTop=100..120 out of view vertically
    // (visible [0,100)) -> centered: 100 - 40 = 60. cellLeft=20..40 fully
    // visible -> scrollLeft unchanged.
    const result = scrollOffsetForCell(51, 10, 20, viewport);
    expect(result.scrollTop).toBe(60);
    expect(result.scrollLeft).toBe(0);
  });
});
