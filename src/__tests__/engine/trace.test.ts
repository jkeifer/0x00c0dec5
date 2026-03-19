import { describe, it, expect } from 'vitest';
import {
  propagateTracesValuePreserving,
  degradeTracesToChunkLevel,
  isChunkLevelTrace,
} from '../../engine/trace.ts';
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
      expect(t.traceId).toBe('chunk:chunk:0');
      expect(t.dtype).toBe('uint8');
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
});

describe('isChunkLevelTrace', () => {
  it('detects chunk-level trace ids', () => {
    expect(isChunkLevelTrace('chunk:chunk:0')).toBe(true);
    expect(isChunkLevelTrace('chunk:0,1')).toBe(true);
  });

  it('rejects value-level trace ids', () => {
    expect(isChunkLevelTrace('temperature:0')).toBe(false);
    expect(isChunkLevelTrace('var:1,2')).toBe(false);
  });
});
