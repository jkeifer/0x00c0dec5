import { describe, it, expect } from 'vitest';
import {
  groupBytesByTrace,
  byteToHex,
  formatOffset,
  byteToAscii,
  buildTraceIndex,
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
      makeTrace({ traceId: 'chunk:chunk:0,0', variableName: '', byteCount: 2 }),
      makeTrace({ traceId: 'chunk:chunk:0,0', variableName: '', byteCount: 2 }),
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
