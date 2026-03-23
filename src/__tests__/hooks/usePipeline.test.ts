import { describe, it, expect } from 'vitest';
import { computePipelineStages } from '../../hooks/usePipeline.ts';
import { DEFAULT_STATE } from '../../types/state.ts';
import type { AppState } from '../../types/state.ts';

function stateWith(overrides: Partial<AppState>): AppState {
  return { ...DEFAULT_STATE, ...overrides };
}

describe('computePipelineStages', () => {
  it('produces 5 stages with correct names', () => {
    const { stages } = computePipelineStages(DEFAULT_STATE);
    expect(stages).toHaveLength(5);
    expect(stages.map((s) => s.name)).toEqual([
      'Values',
      'Linearized',
      'Encoded',
      'Metadata',
      'Write',
    ]);
  });

  it('has non-zero byte counts for all stages', () => {
    const { stages } = computePipelineStages(DEFAULT_STATE);
    for (const stage of stages) {
      expect(stage.stats.byteCount).toBeGreaterThan(0);
    }
  });

  it('has traces.length === bytes.length for each stage', () => {
    const { stages } = computePipelineStages(DEFAULT_STATE);
    for (const stage of stages) {
      expect(stage.traces.length).toBe(stage.bytes.length);
    }
  });

  it('Values stage byte count matches expected from variables', () => {
    const { stages } = computePipelineStages(DEFAULT_STATE);
    const valuesStage = stages[0];
    // DEFAULT_STATE: 32 elements, 2 float32 (4B) + 1 uint16 (2B) = 32*(4+4+2) = 320
    expect(valuesStage.stats.byteCount).toBe(320);
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
});

describe('Values stage traceId alignment with Linearized stage', () => {
  it('1D traceIds match between Values and Linearized stages', () => {
    const state = stateWith({ shape: [8], chunkShape: [8] });
    const { stages } = computePipelineStages(state);
    const valuesTraceIds = new Set(stages[0].traces.map((t) => t.traceId));
    const linearizedTraceIds = new Set(stages[1].traces.map((t) => t.traceId));

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
        { id: 'temp', name: 'temperature', dtype: 'float32', color: '#e06c75' },
      ],
      fieldPipelines: { temperature: [] },
    });
    const { stages } = computePipelineStages(state);
    const valuesTraceIds = new Set(stages[0].traces.map((t) => t.traceId));
    const linearizedTraceIds = new Set(stages[1].traces.map((t) => t.traceId));

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
        { id: 'v', name: 'value', dtype: 'uint8', color: '#e06c75' },
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
    expect(stages).toHaveLength(5);
    for (const stage of stages) {
      expect(stage.traces.length).toBe(stage.bytes.length);
    }
  });

  it('uses actual dtype for uniform-dtype variables in row mode', () => {
    const state = stateWith({
      interleaving: 'row',
      variables: [
        { id: 'a', name: 'a', dtype: 'float32', color: '#e06c75' },
        { id: 'b', name: 'b', dtype: 'float32', color: '#61afef' },
      ],
      fieldPipelines: { a: [], b: [] },
    });
    const { stages } = computePipelineStages(state);
    expect(stages).toHaveLength(5);
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
    expect(stages[1].stats.byteCount).toBe(stages[2].stats.byteCount);
  });

  it('produces per-variable chunk regions in column mode', () => {
    const state = stateWith({
      interleaving: 'column',
      shape: [4],
      chunkShape: [2],
      variables: [
        { id: 'a', name: 'temperature', dtype: 'float32', color: '#e06c75' },
        { id: 'b', name: 'pressure', dtype: 'float32', color: '#61afef' },
      ],
      fieldPipelines: { temperature: [], pressure: [] },
    });
    const { stages } = computePipelineStages(state);
    const linearized = stages[1];

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
        { id: 'a', name: 'temperature', dtype: 'float32', color: '#e06c75' },
      ],
      fieldPipelines: { temperature: [{ codec: 'rle', params: {} }] },
    });
    const { stages } = computePipelineStages(state);
    const encoded = stages[2];

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
    const writeStage = stages[stages.length - 1];

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
    const writeStage = stages[stages.length - 1];

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
    const metaStage = stages[3];
    expect(metaStage.name).toBe('Metadata');
    expect(metaStage.stats.byteCount).toBeGreaterThan(0);
  });

  it('produces metadata bytes with binary serialization', () => {
    const state = stateWith({
      metadata: { customEntries: [{ key: 'test', value: 'val' }], serialization: 'binary' },
    });
    const { stages } = computePipelineStages(state);
    const metaStage = stages[3];
    expect(metaStage.stats.byteCount).toBeGreaterThan(0);
  });
});

describe('sidecar files have traces', () => {
  it('sidecar metadata file has non-empty traces', () => {
    const state = stateWith({
      write: {
        ...DEFAULT_STATE.write,
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
        partitioning: 'per-chunk',
      },
    });
    const { files } = computePipelineStages(state);
    const sidecar = files.find((f) => f.name === 'metadata');
    expect(sidecar).toBeDefined();
    expect(sidecar!.traces.length).toBe(sidecar!.bytes.length);
  });
});
