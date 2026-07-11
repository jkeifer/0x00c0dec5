import { expect } from 'vitest';
import type { ByteTrace } from '../../../src/types/pipeline.ts';
import { traceAt, type StageLayout, type ValueSources } from '../../../src/engine/layout.ts';

/** Assert traceAt(layout, i, sources) deep-equals reference[i] for every byte. */
export function expectTraceEquivalence(
  layout: StageLayout, sources: ValueSources, reference: ByteTrace[],
): void {
  expect(layout.byteLength).toBe(reference.length);
  for (let i = 0; i < reference.length; i++) {
    const got = traceAt(layout, i, sources);
    // One expect per byte would drown output; compare and report the first mismatch.
    if (JSON.stringify(got) !== JSON.stringify(reference[i])) {
      expect(got, `byte ${i}`).toEqual(reference[i]);
    }
  }
}
