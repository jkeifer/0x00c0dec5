// @vitest-environment jsdom
//
// Gate test for Phase 3.2 (remediation-plan.md, fixes SW-3): usePipeline must
// be split into chained useMemos with real dependency boundaries so that
// typing into a metadata custom-entry field (or any other late-stage-only
// input) does not recompute generation/typing/chunking/encoding. This is the
// only test file in the suite that needs a DOM, hence the jsdom pragma above
// scoped to just this file (the project otherwise runs vitest under the
// `node` environment — see vite.config.ts).
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePipeline } from '../../hooks/usePipeline.ts';
import { DEFAULT_STATE } from '../../types/state.ts';
import type { AppState } from '../../types/state.ts';

const STAGE_NAMES = ['Values', 'Typed', 'Linearized', 'Encoded', 'Metadata', 'Write', 'Read'] as const;

function stageByName(result: ReturnType<typeof usePipeline>, name: string) {
  const stage = result.stages.find((s) => s.name === name);
  if (!stage) throw new Error(`stage ${name} not found`);
  return stage;
}

describe('usePipeline memoization boundaries', () => {
  it('produces the fixed 7-stage list', () => {
    const { result } = renderHook((state: AppState) => usePipeline(state), {
      initialProps: DEFAULT_STATE,
    });
    expect(result.current.stages.map((s) => s.name)).toEqual(STAGE_NAMES);
  });

  it('a metadata customEntries change leaves Values/Typed/Linearized/Encoded bytes referentially stable', () => {
    const { result, rerender } = renderHook((state: AppState) => usePipeline(state), {
      initialProps: DEFAULT_STATE,
    });

    const before = {
      values: stageByName(result.current, 'Values').bytes,
      typed: stageByName(result.current, 'Typed').bytes,
      linearized: stageByName(result.current, 'Linearized').bytes,
      encoded: stageByName(result.current, 'Encoded').bytes,
    };

    const changed: AppState = {
      ...DEFAULT_STATE,
      metadata: {
        ...DEFAULT_STATE.metadata,
        customEntries: [{ key: 'note', value: 'hello' }],
      },
    };
    rerender(changed);

    const after = {
      values: stageByName(result.current, 'Values').bytes,
      typed: stageByName(result.current, 'Typed').bytes,
      linearized: stageByName(result.current, 'Linearized').bytes,
      encoded: stageByName(result.current, 'Encoded').bytes,
    };

    expect(after.values).toBe(before.values);
    expect(after.typed).toBe(before.typed);
    expect(after.linearized).toBe(before.linearized);
    expect(after.encoded).toBe(before.encoded);

    // Sanity: the Metadata stage itself DID pick up the change.
    const metaStage = stageByName(result.current, 'Metadata');
    const metaText = new TextDecoder().decode(metaStage.bytes);
    expect(metaText).toContain('hello');
  });

  it('a codec param change leaves Values/Typed/Linearized bytes stable but changes Encoded', () => {
    const withEmptyPipeline: AppState = {
      ...DEFAULT_STATE,
      fieldPipelines: {
        ...DEFAULT_STATE.fieldPipelines,
        temperature: [],
      },
    };
    const { result, rerender } = renderHook((state: AppState) => usePipeline(state), {
      initialProps: withEmptyPipeline,
    });

    const before = {
      values: stageByName(result.current, 'Values').bytes,
      typed: stageByName(result.current, 'Typed').bytes,
      linearized: stageByName(result.current, 'Linearized').bytes,
      encoded: stageByName(result.current, 'Encoded').bytes,
    };

    const withDelta: AppState = {
      ...withEmptyPipeline,
      fieldPipelines: {
        ...withEmptyPipeline.fieldPipelines,
        temperature: [{ codec: 'delta', params: { order: 1 } }],
      },
    };
    rerender(withDelta);

    const after = {
      values: stageByName(result.current, 'Values').bytes,
      typed: stageByName(result.current, 'Typed').bytes,
      linearized: stageByName(result.current, 'Linearized').bytes,
      encoded: stageByName(result.current, 'Encoded').bytes,
    };

    expect(after.values).toBe(before.values);
    expect(after.typed).toBe(before.typed);
    expect(after.linearized).toBe(before.linearized);
    // Encoded must actually be recomputed (different bytes) — the pipeline
    // for the 'temperature' variable changed from empty to [delta].
    expect(after.encoded).not.toBe(before.encoded);
    expect(Array.from(after.encoded)).not.toEqual(Array.from(before.encoded));
  });
});
