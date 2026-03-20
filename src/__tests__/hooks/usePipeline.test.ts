import { describe, it, expect } from 'vitest';
import { computePipelineStages } from '../../hooks/usePipeline.ts';
import { DEFAULT_STATE } from '../../types/state.ts';

describe('computePipelineStages', () => {
  it('produces 5 stages with correct names', () => {
    const stages = computePipelineStages(DEFAULT_STATE);
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
    const stages = computePipelineStages(DEFAULT_STATE);
    for (const stage of stages) {
      expect(stage.stats.byteCount).toBeGreaterThan(0);
    }
  });

  it('has traces.length === bytes.length for each stage', () => {
    const stages = computePipelineStages(DEFAULT_STATE);
    for (const stage of stages) {
      expect(stage.traces.length).toBe(stage.bytes.length);
    }
  });

  it('Values stage byte count matches expected from variables', () => {
    const stages = computePipelineStages(DEFAULT_STATE);
    const valuesStage = stages[0];
    // DEFAULT_STATE: 32 elements, 2 float32 (4B) + 1 uint16 (2B) = 32*(4+4+2) = 320
    expect(valuesStage.stats.byteCount).toBe(320);
  });

  it('computes entropy values in valid range', () => {
    const stages = computePipelineStages(DEFAULT_STATE);
    for (const stage of stages) {
      expect(stage.stats.entropy).toBeGreaterThanOrEqual(0);
      expect(stage.stats.entropy).toBeLessThanOrEqual(8);
    }
  });

  it('is deterministic across calls', () => {
    const a = computePipelineStages(DEFAULT_STATE);
    const b = computePipelineStages(DEFAULT_STATE);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(Array.from(a[i].bytes)).toEqual(Array.from(b[i].bytes));
      expect(a[i].stats).toEqual(b[i].stats);
    }
  });
});
