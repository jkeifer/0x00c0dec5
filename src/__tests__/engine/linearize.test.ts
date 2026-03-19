import { describe, it, expect } from 'vitest';
import { linearizeChunk, buildTraces } from '../../engine/linearize.ts';
import { bytesToValues } from '../../engine/elements.ts';
import type { Chunk } from '../../types/pipeline.ts';

function makeChunk(overrides?: Partial<Chunk>): Chunk {
  return {
    coords: [0],
    flatIndex: 0,
    variables: [
      {
        variableName: 'a',
        variableColor: '#f00',
        dtype: 'float32',
        values: [1.0, 2.0, 3.0],
        sourceCoords: [[0], [1], [2]],
      },
      {
        variableName: 'b',
        variableColor: '#0f0',
        dtype: 'float32',
        values: [10.0, 20.0, 30.0],
        sourceCoords: [[0], [1], [2]],
      },
    ],
    ...overrides,
  };
}

describe('linearizeChunk - column interleaving', () => {
  it('produces bytes in variable-contiguous order', () => {
    const chunk = makeChunk();
    const result = linearizeChunk(chunk, 'column');

    // Column: all a bytes (3*4=12), then all b bytes (3*4=12) → 24 bytes
    expect(result.bytes.length).toBe(24);

    const aValues = bytesToValues(result.bytes.slice(0, 12), 'float32');
    const bValues = bytesToValues(result.bytes.slice(12, 24), 'float32');

    expect(aValues[0]).toBeCloseTo(1.0);
    expect(aValues[1]).toBeCloseTo(2.0);
    expect(aValues[2]).toBeCloseTo(3.0);
    expect(bValues[0]).toBeCloseTo(10.0);
    expect(bValues[1]).toBeCloseTo(20.0);
    expect(bValues[2]).toBeCloseTo(30.0);
  });

  it('produces traces matching byte count', () => {
    const chunk = makeChunk();
    const result = linearizeChunk(chunk, 'column');
    expect(result.traces.length).toBe(result.bytes.length);
  });

  it('traces reference correct variable names in column order', () => {
    const chunk = makeChunk();
    const result = linearizeChunk(chunk, 'column');

    // First 12 traces should be for 'a', next 12 for 'b'
    for (let i = 0; i < 12; i++) {
      expect(result.traces[i].variableName).toBe('a');
    }
    for (let i = 12; i < 24; i++) {
      expect(result.traces[i].variableName).toBe('b');
    }
  });
});

describe('linearizeChunk - row interleaving', () => {
  it('interleaves variable bytes per element', () => {
    const chunk = makeChunk();
    const result = linearizeChunk(chunk, 'row');

    // Row: for each element, a[i] (4 bytes) then b[i] (4 bytes)
    // Total: 3 elements * (4+4) = 24 bytes
    expect(result.bytes.length).toBe(24);

    // Element 0: a[0], b[0]
    const a0 = bytesToValues(result.bytes.slice(0, 4), 'float32');
    const b0 = bytesToValues(result.bytes.slice(4, 8), 'float32');
    expect(a0[0]).toBeCloseTo(1.0);
    expect(b0[0]).toBeCloseTo(10.0);

    // Element 1: a[1], b[1]
    const a1 = bytesToValues(result.bytes.slice(8, 12), 'float32');
    const b1 = bytesToValues(result.bytes.slice(12, 16), 'float32');
    expect(a1[0]).toBeCloseTo(2.0);
    expect(b1[0]).toBeCloseTo(20.0);
  });

  it('produces traces matching byte count', () => {
    const chunk = makeChunk();
    const result = linearizeChunk(chunk, 'row');
    expect(result.traces.length).toBe(result.bytes.length);
  });

  it('traces interleave variable names per element', () => {
    const chunk = makeChunk();
    const result = linearizeChunk(chunk, 'row');

    // Element 0: 4 bytes of 'a', 4 bytes of 'b'
    for (let i = 0; i < 4; i++) expect(result.traces[i].variableName).toBe('a');
    for (let i = 4; i < 8; i++) expect(result.traces[i].variableName).toBe('b');
    // Element 1
    for (let i = 8; i < 12; i++) expect(result.traces[i].variableName).toBe('a');
    for (let i = 12; i < 16; i++) expect(result.traces[i].variableName).toBe('b');
  });
});

describe('linearizeChunk - mixed dtypes in row mode', () => {
  it('handles variables with different byte sizes', () => {
    const chunk: Chunk = {
      coords: [0],
      flatIndex: 0,
      variables: [
        {
          variableName: 'x',
          variableColor: '#f00',
          dtype: 'float32', // 4 bytes
          values: [1.0, 2.0],
          sourceCoords: [[0], [1]],
        },
        {
          variableName: 'y',
          variableColor: '#0f0',
          dtype: 'uint8', // 1 byte
          values: [10, 20],
          sourceCoords: [[0], [1]],
        },
      ],
    };

    const result = linearizeChunk(chunk, 'row');
    // Element 0: x[0] (4 bytes) + y[0] (1 byte) = 5 bytes
    // Element 1: x[1] (4 bytes) + y[1] (1 byte) = 5 bytes
    expect(result.bytes.length).toBe(10);
    expect(result.traces.length).toBe(10);

    // Check byte layout
    const x0 = bytesToValues(result.bytes.slice(0, 4), 'float32');
    expect(x0[0]).toBeCloseTo(1.0);
    expect(result.bytes[4]).toBe(10); // y[0]

    const x1 = bytesToValues(result.bytes.slice(5, 9), 'float32');
    expect(x1[0]).toBeCloseTo(2.0);
    expect(result.bytes[9]).toBe(20); // y[1]
  });
});

describe('buildTraces', () => {
  it('sets correct byteInValue and byteCount', () => {
    const chunk = makeChunk();
    const traces = buildTraces(chunk, 'column');

    // First value of 'a' is float32 (4 bytes)
    expect(traces[0].byteInValue).toBe(0);
    expect(traces[0].byteCount).toBe(4);
    expect(traces[1].byteInValue).toBe(1);
    expect(traces[2].byteInValue).toBe(2);
    expect(traces[3].byteInValue).toBe(3);
  });

  it('sets correct chunkId', () => {
    const chunk = makeChunk({ coords: [1, 2] });
    const traces = buildTraces(chunk, 'column');
    expect(traces[0].chunkId).toBe('chunk:1,2');
  });

  it('sets correct traceId with coords', () => {
    const chunk = makeChunk();
    const traces = buildTraces(chunk, 'column');
    expect(traces[0].traceId).toBe('a:0');
    expect(traces[4].traceId).toBe('a:1');
  });
});
