import { describe, it, expect } from 'vitest';
import { computePipelineStages } from '../../../src/hooks/usePipeline.ts';
import { DEFAULT_STATE } from '../../../src/types/state.ts';
import { chunkRegionsOf, traceAt } from '../../../src/engine/layout.ts';
import { referenceStageTraces } from '../helpers/referenceTraces.ts';
import { STAGE_ORDER } from '../../../src/types/pipeline.ts';
import type { StageName } from '../../../src/types/pipeline.ts';

// PipelineStage.name uses display casing ('Values', 'Typed', ...);
// stageSources is keyed by the lowercase StageName. Map index -> StageName
// via STAGE_ORDER, which is defined to match this same 7-stage order.
const NAME_TO_STAGE_NAME: Record<number, StageName> = Object.fromEntries(
  STAGE_ORDER.map((name, i) => [i, name]),
);

describe('pipeline stage layouts', () => {
  it('every stage layout byteLength matches its bytes, chunkRegions match chunkRegionsOf(layout), and traceAt spot-checks against the reference tracer', () => {
    const result = computePipelineStages(DEFAULT_STATE);
    const reference = referenceStageTraces(DEFAULT_STATE);

    expect(result.stages).toHaveLength(STAGE_ORDER.length);

    result.stages.forEach((stage, i) => {
      const stageName = NAME_TO_STAGE_NAME[i];

      expect(stage.layout.byteLength).toBe(stage.bytes.length);
      expect(stage.chunkRegions).toEqual(chunkRegionsOf(stage.layout));

      if (stage.bytes.length > 0) {
        const sources = result.stageSources.get(stageName);
        expect(sources).toBeDefined();
        const trace = traceAt(stage.layout, 0, sources!);
        expect(trace).toEqual(reference.get(stageName)![0]);
      }
    });
  });
});
