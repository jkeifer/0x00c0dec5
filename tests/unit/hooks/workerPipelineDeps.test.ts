// Gate test for F15 (overhaul-plan.md): useWorkerPipeline's recompute effect
// depends on a hand-maintained list of AppState keys. This pins that list to
// stay exhaustive — every AppState key except `ui` must be tracked, so a
// future field added to AppState fails this test instead of silently going
// stale (as `linearization`/`byteOrder` once did per the hook's own comment).
import { describe, it, expect } from 'vitest';
import { PIPELINE_INPUT_KEYS } from '../../../src/hooks/useWorkerPipeline.ts';
import { DEFAULT_STATE } from '../../../src/types/state.ts';

describe('useWorkerPipeline PIPELINE_INPUT_KEYS', () => {
  it('covers every AppState key except ui', () => {
    const expected = Object.keys(DEFAULT_STATE).filter((k) => k !== 'ui').sort();
    expect([...PIPELINE_INPUT_KEYS].sort()).toEqual(expected);
  });
});
