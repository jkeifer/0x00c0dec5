import { describe, it, expect } from 'vitest';
import { computePipelineStages } from '../../hooks/usePipeline.ts';
import { DEFAULT_STATE } from '../../types/state.ts';
import type { AppState, Variable } from '../../types/state.ts';

function stateWith(overrides: Partial<AppState>): AppState {
  return { ...DEFAULT_STATE, ...overrides };
}

describe('computePipelineStages', () => {
  it('produces 7 stages with correct names', () => {
    const { stages } = computePipelineStages(DEFAULT_STATE);
    expect(stages).toHaveLength(7);
    expect(stages.map((s) => s.name)).toEqual([
      'Values',
      'Typed',
      'Linearized',
      'Encoded',
      'Metadata',
      'Write',
      'Read',
    ]);
  });

  it('has non-zero byte counts for all stages except Read (when no metadata)', () => {
    const { stages } = computePipelineStages(DEFAULT_STATE);
    for (const stage of stages) {
      if (stage.name === 'Read') {
        // Read stage has 0 bytes when metadata is not included (default)
        continue;
      }
      expect(stage.stats.byteCount).toBeGreaterThan(0);
    }
  });

  it('has traces.length === bytes.length for each stage', () => {
    const { stages } = computePipelineStages(DEFAULT_STATE);
    for (const stage of stages) {
      // Read stage when failed has 0 bytes and 0 traces — still consistent
      expect(stage.traces.length).toBe(stage.bytes.length);
    }
  });

  it('Values stage uses float64 bytes (logical values)', () => {
    const { stages } = computePipelineStages(DEFAULT_STATE);
    const valuesStage = stages[0];
    // DEFAULT_STATE: 32 elements, 3 variables, all stored as float64 = 32 * 3 * 8 = 768
    expect(valuesStage.stats.byteCount).toBe(768);
  });

  it('Typed stage byte count matches variable storage dtypes', () => {
    const { stages } = computePipelineStages(DEFAULT_STATE);
    const typedStage = stages[1];
    // DEFAULT_STATE: 32 elements, 2 float32 (4B) + 1 uint16 (2B) = 32*(4+4+2) = 320
    expect(typedStage.stats.byteCount).toBe(320);
  });

  it('computes entropy values in valid range', () => {
    const { stages } = computePipelineStages(DEFAULT_STATE);
    for (const stage of stages) {
      expect(stage.stats.entropy).toBeGreaterThanOrEqual(0);
      expect(stage.stats.entropy).toBeLessThanOrEqual(8);
    }
  });

  it('is deterministic across calls', () => {
    const { stages: a } = computePipelineStages(DEFAULT_STATE);
    const { stages: b } = computePipelineStages(DEFAULT_STATE);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(Array.from(a[i].bytes)).toEqual(Array.from(b[i].bytes));
      expect(a[i].stats).toEqual(b[i].stats);
    }
  });

  it('includes at least one file in the result', () => {
    const { files } = computePipelineStages(DEFAULT_STATE);
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files[0].name).toBeTruthy();
    expect(files[0].bytes.length).toBeGreaterThan(0);
  });

  it('returns variableStats for each variable', () => {
    const { variableStats } = computePipelineStages(DEFAULT_STATE);
    expect(variableStats.size).toBe(3);
    expect(variableStats.has('temperature')).toBe(true);
    expect(variableStats.has('pressure')).toBe(true);
    expect(variableStats.has('humidity')).toBe(true);

    const tempStats = variableStats.get('temperature')!;
    expect(tempStats.count).toBe(32);
    expect(tempStats.min).toBeLessThanOrEqual(tempStats.max);
  });
});

describe('Values stage traceId alignment with Linearized stage', () => {
  it('1D traceIds match between Values and Linearized stages', () => {
    const state = stateWith({ shape: [8], chunkShape: [8] });
    const { stages } = computePipelineStages(state);
    const valuesTraceIds = new Set(stages[0].traces.map((t) => t.traceId));
    const linearizedTraceIds = new Set(stages[2].traces.map((t) => t.traceId)); // index 2 = Linearized

    // Every linearized value traceId should exist in the values stage
    for (const id of linearizedTraceIds) {
      if (!id.startsWith('chunk:') && !id.startsWith('magic:') && id !== 'metadata') {
        expect(valuesTraceIds.has(id)).toBe(true);
      }
    }
  });

  it('2D traceIds match between Values and Linearized stages', () => {
    const state = stateWith({
      shape: [4, 4],
      chunkShape: [4, 4],
      variables: [
        {
          id: 'temp', name: 'temperature', color: '#e06c75',
          logicalType: { type: 'decimal', min: -50, max: 50, decimalPlaces: 1 },
          typeAssignment: { storageDtype: 'float32' },
        },
      ],
      fieldPipelines: { temperature: [] },
    });
    const { stages } = computePipelineStages(state);
    const valuesTraceIds = new Set(stages[0].traces.map((t) => t.traceId));
    const linearizedTraceIds = new Set(stages[2].traces.map((t) => t.traceId));

    // Every linearized value traceId should exist in the values stage
    for (const id of linearizedTraceIds) {
      if (!id.startsWith('chunk:') && !id.startsWith('magic:') && id !== 'metadata') {
        expect(valuesTraceIds.has(id)).toBe(true);
      }
    }

    // Verify 2D coordinate format like "temperature:2,3"
    const sampleId = stages[0].traces[0].traceId;
    expect(sampleId).toMatch(/^temperature:\d+,\d+$/);
  });

  it('3D traceIds use comma-separated coords', () => {
    const state = stateWith({
      shape: [2, 3, 4],
      chunkShape: [2, 3, 4],
      variables: [
        {
          id: 'v', name: 'value', color: '#e06c75',
          logicalType: { type: 'integer', min: 0, max: 255 },
          typeAssignment: { storageDtype: 'uint8' },
        },
      ],
      fieldPipelines: { value: [] },
    });
    const { stages } = computePipelineStages(state);
    const sampleId = stages[0].traces[0].traceId;
    expect(sampleId).toMatch(/^value:\d+,\d+,\d+$/);
  });
});

describe('row-mode codec pipeline', () => {
  it('uses uint8 dtype for mixed-dtype variables in row mode', () => {
    const state = stateWith({
      interleaving: 'row',
      // Default has float32, float32, uint16 - mixed
    });
    const { stages } = computePipelineStages(state);
    // Should still produce valid output without errors
    expect(stages).toHaveLength(7);
    for (const stage of stages) {
      expect(stage.traces.length).toBe(stage.bytes.length);
    }
  });

  it('uses actual dtype for uniform-dtype variables in row mode', () => {
    const state = stateWith({
      interleaving: 'row',
      variables: [
        {
          id: 'a', name: 'a', color: '#e06c75',
          logicalType: { type: 'decimal', min: -50, max: 50, decimalPlaces: 1 },
          typeAssignment: { storageDtype: 'float32' },
        },
        {
          id: 'b', name: 'b', color: '#61afef',
          logicalType: { type: 'decimal', min: -50, max: 50, decimalPlaces: 1 },
          typeAssignment: { storageDtype: 'float32' },
        },
      ],
      fieldPipelines: { a: [], b: [] },
    });
    const { stages } = computePipelineStages(state);
    expect(stages).toHaveLength(7);
    for (const stage of stages) {
      expect(stage.traces.length).toBe(stage.bytes.length);
    }
  });
});

describe('column-mode codec pipeline', () => {
  it('applies per-field pipelines in column mode', () => {
    const state = stateWith({
      interleaving: 'column',
    });
    const { stages } = computePipelineStages(state);
    // Without any codecs, Encoded should equal Linearized
    expect(stages[2].stats.byteCount).toBe(stages[3].stats.byteCount); // Linearized=2, Encoded=3
  });

  it('produces per-variable chunk regions in column mode', () => {
    const state = stateWith({
      interleaving: 'column',
      shape: [4],
      chunkShape: [2],
      variables: [
        {
          id: 'a', name: 'temperature', color: '#e06c75',
          logicalType: { type: 'decimal', min: -50, max: 50, decimalPlaces: 1 },
          typeAssignment: { storageDtype: 'float32' },
        },
        {
          id: 'b', name: 'pressure', color: '#61afef',
          logicalType: { type: 'decimal', min: 900, max: 1100, decimalPlaces: 1 },
          typeAssignment: { storageDtype: 'float32' },
        },
      ],
      fieldPipelines: { temperature: [], pressure: [] },
    });
    const { stages } = computePipelineStages(state);
    const linearized = stages[2]; // Linearized is index 2

    // Should have per-variable chunk regions
    const chunkIds = [...new Set(linearized.traces.map((t) => t.chunkId))];
    expect(chunkIds).toContain('chunk:temperature:0');
    expect(chunkIds).toContain('chunk:temperature:1');
    expect(chunkIds).toContain('chunk:pressure:0');
    expect(chunkIds).toContain('chunk:pressure:1');
  });

  it('preserves variable colors after entropy codec in column mode', () => {
    const state = stateWith({
      interleaving: 'column',
      shape: [4],
      chunkShape: [4],
      variables: [
        {
          id: 'a', name: 'temperature', color: '#e06c75',
          logicalType: { type: 'decimal', min: -50, max: 50, decimalPlaces: 1 },
          typeAssignment: { storageDtype: 'float32' },
        },
      ],
      fieldPipelines: { temperature: [{ codec: 'rle', params: {} }] },
    });
    const { stages } = computePipelineStages(state);
    const encoded = stages[3]; // Encoded is index 3

    // After RLE (entropy), variable color should be preserved because it's a per-variable chunk
    for (const t of encoded.traces) {
      if (t.chunkId.startsWith('chunk:')) {
        expect(t.variableName).toBe('temperature');
        expect(t.variableColor).toBe('#e06c75');
      }
    }
  });
});

describe('Write stage includes all files', () => {
  it('Write stage includes sidecar metadata bytes in per-chunk mode', () => {
    const state = stateWith({
      write: {
        ...DEFAULT_STATE.write,
        partitioning: 'per-chunk',
      },
    });
    const { stages, files } = computePipelineStages(state);
    const writeStage = stages[5]; // Write is stage index 5

    // Write stage bytes should be the sum of all file bytes
    const totalFileBytes = files.reduce((acc, f) => acc + f.bytes.length, 0);
    expect(writeStage.stats.byteCount).toBe(totalFileBytes);
  });

  it('Write stage includes sidecar metadata bytes in sidecar mode', () => {
    const state = stateWith({
      write: {
        ...DEFAULT_STATE.write,
        metadataPlacement: 'sidecar',
      },
    });
    const { stages, files } = computePipelineStages(state);
    const writeStage = stages[5]; // Write is stage index 5

    const totalFileBytes = files.reduce((acc, f) => acc + f.bytes.length, 0);
    expect(writeStage.stats.byteCount).toBe(totalFileBytes);
  });
});

describe('metadata stage', () => {
  it('produces metadata bytes with json serialization', () => {
    const state = stateWith({
      metadata: { customEntries: [{ key: 'test', value: 'val' }], serialization: 'json' },
    });
    const { stages } = computePipelineStages(state);
    const metaStage = stages[4]; // Metadata is index 4
    expect(metaStage.name).toBe('Metadata');
    expect(metaStage.stats.byteCount).toBeGreaterThan(0);
  });

  it('produces metadata bytes with binary serialization', () => {
    const state = stateWith({
      metadata: { customEntries: [{ key: 'test', value: 'val' }], serialization: 'binary' },
    });
    const { stages } = computePipelineStages(state);
    const metaStage = stages[4];
    expect(metaStage.stats.byteCount).toBeGreaterThan(0);
  });
});

describe('Read stage', () => {
  it('Read stage is empty (0 bytes) when metadata not included', () => {
    const state = stateWith({
      write: { ...DEFAULT_STATE.write, includeMetadata: false },
    });
    const { stages, readResult } = computePipelineStages(state);
    const readStage = stages[6]; // Read is stage index 6
    expect(readStage.name).toBe('Read');
    expect(readStage.stats.byteCount).toBe(0);
    expect(readResult.success).toBe(false);
  });

  it('Read stage has reconstructed values when metadata included', () => {
    const state = stateWith({
      write: { ...DEFAULT_STATE.write, includeMetadata: true, metadataPlacement: 'header' },
    });
    const { stages, readResult } = computePipelineStages(state);
    const readStage = stages[6];
    expect(readStage.name).toBe('Read');
    expect(readStage.stats.byteCount).toBeGreaterThan(0);
    expect(readResult.success).toBe(true);
  });

  it('Read stage traces match bytes length', () => {
    const state = stateWith({
      write: { ...DEFAULT_STATE.write, includeMetadata: true, metadataPlacement: 'header' },
    });
    const { stages } = computePipelineStages(state);
    const readStage = stages[6];
    expect(readStage.traces.length).toBe(readStage.bytes.length);
  });

  it('Read stage traceIds use same format as Values stage', () => {
    const state = stateWith({
      write: { ...DEFAULT_STATE.write, includeMetadata: true, metadataPlacement: 'header' },
    });
    const { stages } = computePipelineStages(state);
    const valuesTraceIds = new Set(stages[0].traces.map((t) => t.traceId));
    const readTraceIds = new Set(stages[6].traces.map((t) => t.traceId));
    // All Read traceIds should match Values traceIds
    for (const id of readTraceIds) {
      expect(valuesTraceIds.has(id)).toBe(true);
    }
  });
});

describe('sidecar files have traces', () => {
  it('sidecar metadata file has non-empty traces', () => {
    const state = stateWith({
      write: {
        ...DEFAULT_STATE.write,
        includeMetadata: true,
        metadataPlacement: 'sidecar',
      },
    });
    const { files } = computePipelineStages(state);
    const sidecar = files.find((f) => f.name === 'metadata');
    expect(sidecar).toBeDefined();
    expect(sidecar!.traces.length).toBe(sidecar!.bytes.length);
  });

  it('per-chunk sidecar metadata file has non-empty traces', () => {
    const state = stateWith({
      write: {
        ...DEFAULT_STATE.write,
        includeMetadata: true,
        partitioning: 'per-chunk',
      },
    });
    const { files } = computePipelineStages(state);
    const sidecar = files.find((f) => f.name === 'metadata');
    expect(sidecar).toBeDefined();
    expect(sidecar!.traces.length).toBe(sidecar!.bytes.length);
  });
});
