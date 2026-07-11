import { describe, it, expect } from 'vitest';
import { collectTransferables } from '../../../src/worker/protocol.ts';
import { computePipelineStages } from '../../../src/hooks/usePipeline.ts';
import { DEFAULT_STATE } from '../../../src/types/state.ts';

describe('collectTransferables', () => {
  it('includes every stage bytes buffer, dedupes, and covers shared value-map buffers once', () => {
    const result = computePipelineStages(DEFAULT_STATE);
    const list = collectTransferables(result);
    const set = new Set(list);

    // (a) every stage bytes buffer is present
    for (const stage of result.stages) {
      expect(set.has(stage.bytes.buffer as ArrayBuffer)).toBe(true);
    }

    // (b) no duplicates
    expect(list.length).toBe(set.size);

    // (c) buffers shared between logicalValues and stageSources appear once
    const valuesSource = result.stageSources.get('values');
    expect(valuesSource).toBeDefined();
    for (const [name, arr] of result.logicalValues) {
      const sourceArr = valuesSource!.values.get(name);
      if (arr instanceof Float64Array && sourceArr instanceof Float64Array) {
        expect(sourceArr.buffer).toBe(arr.buffer); // same underlying buffer (precondition for dedupe to matter)
        const occurrences = list.filter((b) => b === (arr.buffer as ArrayBuffer)).length;
        expect(occurrences).toBe(1);
      }
    }
  });
});
