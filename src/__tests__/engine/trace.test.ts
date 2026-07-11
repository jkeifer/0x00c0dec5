import { describe, it, expect } from 'vitest';
import {
  isChunkLevelTrace,
  makeTraceId,
  makeChunkTraceId,
  parseTraceId,
} from '../../engine/trace.ts';
import {
  propagateTracesValuePreserving,
  degradeTracesToChunkLevel,
} from '../helpers/referenceTraces.ts';
import type { ByteTrace } from '../../types/pipeline.ts';

function makeTrace(overrides?: Partial<ByteTrace>): ByteTrace {
  return {
    traceId: 'var:0',
    variableName: 'var',
    variableColor: '#f00',
    coords: [0],
    displayValue: '1.0',
    dtype: 'float32',
    chunkId: 'chunk:0',
    byteInValue: 0,
    byteCount: 4,
    ...overrides,
  };
}

function makeFloat32Traces(count: number): ByteTrace[] {
  const traces: ByteTrace[] = [];
  for (let v = 0; v < count; v++) {
    for (let b = 0; b < 4; b++) {
      traces.push(makeTrace({
        traceId: `var:${v}`,
        coords: [v],
        byteInValue: b,
        byteCount: 4,
        dtype: 'float32',
      }));
    }
  }
  return traces;
}

describe('propagateTracesValuePreserving', () => {
  it('preserves traces for same-size dtypes', () => {
    const input = makeFloat32Traces(3); // 12 traces (3 values * 4 bytes)
    const output = propagateTracesValuePreserving(input, 'float32', 'int32');

    expect(output.length).toBe(12);
    for (const t of output) {
      expect(t.dtype).toBe('int32');
      expect(t.byteCount).toBe(4);
    }
  });

  it('handles dtype size change (float32 → int16)', () => {
    const input = makeFloat32Traces(3); // 12 traces (3 values * 4 bytes each)
    const output = propagateTracesValuePreserving(input, 'float32', 'int16');

    // 3 values * 2 bytes each = 6 output traces
    expect(output.length).toBe(6);
    for (const t of output) {
      expect(t.dtype).toBe('int16');
      expect(t.byteCount).toBe(2);
    }
    // Check byteInValue sequence
    expect(output[0].byteInValue).toBe(0);
    expect(output[1].byteInValue).toBe(1);
    expect(output[2].byteInValue).toBe(0);
    expect(output[3].byteInValue).toBe(1);
  });

  it('handles dtype size increase (int16 → float32)', () => {
    const input: ByteTrace[] = [];
    for (let v = 0; v < 2; v++) {
      for (let b = 0; b < 2; b++) {
        input.push(makeTrace({
          traceId: `var:${v}`,
          coords: [v],
          byteInValue: b,
          byteCount: 2,
          dtype: 'int16',
        }));
      }
    }

    const output = propagateTracesValuePreserving(input, 'int16', 'float32');
    // 2 values * 4 bytes each = 8 output traces
    expect(output.length).toBe(8);
    for (const t of output) {
      expect(t.dtype).toBe('float32');
      expect(t.byteCount).toBe(4);
    }
  });

  it('handles empty input', () => {
    const output = propagateTracesValuePreserving([], 'float32', 'int32');
    expect(output).toEqual([]);
  });
});

describe('degradeTracesToChunkLevel', () => {
  it('produces chunk-level traces', () => {
    const input = makeFloat32Traces(3);
    const output = degradeTracesToChunkLevel(input, 10);

    expect(output.length).toBe(10);
    for (const t of output) {
      expect(t.traceId).toBe('chunk:0');
      expect(t.dtype).toBe('uint8');
      expect(t.byteInValue).toBe(0);
      expect(t.byteCount).toBe(1);
    }
  });

  it('handles empty input', () => {
    const output = degradeTracesToChunkLevel([], 0);
    expect(output).toEqual([]);
  });

  it('handles zero output bytes', () => {
    const input = makeFloat32Traces(1);
    const output = degradeTracesToChunkLevel(input, 0);
    expect(output).toEqual([]);
  });

  it('preserves variableName and variableColor when all traces share same variable', () => {
    const input = makeFloat32Traces(3); // all have variableName='var', variableColor='#f00'
    const output = degradeTracesToChunkLevel(input, 5);

    expect(output.length).toBe(5);
    for (const t of output) {
      expect(t.variableName).toBe('var');
      expect(t.variableColor).toBe('#f00');
    }
  });

  it('clears variableName and variableColor when traces have mixed variables', () => {
    const input = [
      makeTrace({ variableName: 'a', variableColor: '#f00' }),
      makeTrace({ variableName: 'a', variableColor: '#f00' }),
      makeTrace({ variableName: 'b', variableColor: '#0f0' }),
      makeTrace({ variableName: 'b', variableColor: '#0f0' }),
    ];
    const output = degradeTracesToChunkLevel(input, 3);

    expect(output.length).toBe(3);
    for (const t of output) {
      expect(t.variableName).toBe('');
      expect(t.variableColor).toBe('');
    }
  });

  it('clears variable info when variableName is empty', () => {
    const input = [
      makeTrace({ variableName: '', variableColor: '' }),
      makeTrace({ variableName: '', variableColor: '' }),
    ];
    const output = degradeTracesToChunkLevel(input, 2);

    for (const t of output) {
      expect(t.variableName).toBe('');
      expect(t.variableColor).toBe('');
    }
  });
});

describe('isChunkLevelTrace', () => {
  it('detects chunk-level trace ids', () => {
    expect(isChunkLevelTrace('chunk:0')).toBe(true);
    expect(isChunkLevelTrace('chunk:0,1')).toBe(true);
  });

  it('rejects value-level trace ids', () => {
    expect(isChunkLevelTrace('temperature:0')).toBe(false);
    expect(isChunkLevelTrace('var:1,2')).toBe(false);
  });
});

// ─── D8 (remediation-plan.md, Phase 3.4): traceId helpers ──────────────────

describe('makeTraceId', () => {
  it('builds a value traceId from a variable name and 1D coords', () => {
    expect(makeTraceId('temperature', [5])).toBe('temperature:5');
  });

  it('builds a value traceId from multi-dimensional coords', () => {
    expect(makeTraceId('humidity', [2, 3])).toBe('humidity:2,3');
  });

  it('handles empty coords', () => {
    expect(makeTraceId('scalar', [])).toBe('scalar:');
  });
});

describe('makeChunkTraceId', () => {
  it('prefixes a raw chunk identifier with "chunk:"', () => {
    expect(makeChunkTraceId('0,1')).toBe('chunk:0,1');
  });

  it('prefixes a per-variable raw chunk identifier', () => {
    expect(makeChunkTraceId('temperature:0')).toBe('chunk:temperature:0');
  });

  it('is idempotent — does not double-prefix an already-prefixed id', () => {
    expect(makeChunkTraceId('chunk:0,1')).toBe('chunk:0,1');
    expect(makeChunkTraceId(makeChunkTraceId('0,1'))).toBe('chunk:0,1');
  });
});

describe('parseTraceId', () => {
  it('parses a 1D value traceId', () => {
    expect(parseTraceId('temperature:5')).toEqual({
      kind: 'value',
      variableName: 'temperature',
      coords: [5],
    });
  });

  it('parses a multi-dimensional value traceId', () => {
    expect(parseTraceId('humidity:2,3,4')).toEqual({
      kind: 'value',
      variableName: 'humidity',
      coords: [2, 3, 4],
    });
  });

  it('round-trips through makeTraceId', () => {
    const id = makeTraceId('pressure', [1, 2]);
    expect(parseTraceId(id)).toEqual({ kind: 'value', variableName: 'pressure', coords: [1, 2] });
  });

  it('parses a chunk-level traceId, returning the full prefixed chunkId', () => {
    expect(parseTraceId('chunk:0,1')).toEqual({ kind: 'chunk', chunkId: 'chunk:0,1' });
    expect(parseTraceId('chunk:temperature:0')).toEqual({ kind: 'chunk', chunkId: 'chunk:temperature:0' });
  });

  it('round-trips through makeChunkTraceId', () => {
    const id = makeChunkTraceId('temperature:0');
    expect(parseTraceId(id)).toEqual({ kind: 'chunk', chunkId: 'chunk:temperature:0' });
  });

  it('never mis-parses a chunk-level id as value coordinates (UI-3 regression)', () => {
    // Before the D8 fix, TableView/GridView split on the FIRST ':' without
    // checking for the chunk prefix, so 'chunk:0,1' "parsed" as variableName
    // 'chunk' with coords [0, 1] — silently wrong instead of falling back to
    // the chunk-level lookup path.
    const parsed = parseTraceId('chunk:0,1');
    expect(parsed.kind).toBe('chunk');
    if (parsed.kind === 'chunk') {
      expect(parsed.chunkId).toBe('chunk:0,1');
    }
  });

  it('parses a bare identifier with no colon as a value with empty coords', () => {
    expect(parseTraceId('metadata')).toEqual({ kind: 'value', variableName: 'metadata', coords: [] });
  });

  // Documented choice (D8): split on the FIRST ':' only. Variable names
  // containing ':' are not supported — the remainder after the first colon
  // is treated as the coordinate string, which for a colon-bearing name
  // simply fails to parse as clean numeric coords rather than corrupting
  // unrelated data.
  it('a variable name containing ":" does not round-trip through makeTraceId/parseTraceId', () => {
    const id = makeTraceId('a:b', [0]);
    expect(id).toBe('a:b:0');
    const parsed = parseTraceId(id);
    expect(parsed).toEqual({ kind: 'value', variableName: 'a', coords: [NaN] });
  });
});
