import { describe, it, expect } from 'vitest';
import { DEFAULT_STATE } from '../../../src/types/state.ts';
import type { AppState } from '../../../src/types/state.ts';
import { collectMetadata, METADATA_KEY_GROUPS } from '../../../src/engine/metadata.ts';
import {
  computeValuesStage, computeTypedStage, computeLinearizedStage, computeEncodedStage,
} from '../../../src/engine/pipelineCompute.ts';

function stateWith(include: Partial<AppState['metadata']['include']>): AppState {
  return {
    ...DEFAULT_STATE,
    metadata: {
      ...DEFAULT_STATE.metadata,
      customEntries: [{ key: 'author', value: 'test' }],
      include: { ...DEFAULT_STATE.metadata.include, ...include },
    },
  };
}

/**
 * Build encodedChunks/variableStats via the real pipeline stage functions
 * (same pattern as tests/unit/engine/layout.equivalence.test.ts) and run
 * collectMetadata on the result.
 */
function collectFor(state: AppState) {
  const values = computeValuesStage(state.shape, state.variables);
  const typed = computeTypedStage(state.shape, state.variables, values.variableValues);
  const linearized = computeLinearizedStage(
    state.shape, state.chunkShape, state.interleaving, state.variables, typed.typedVariableValues,
  );
  const encoded = computeEncodedStage(
    linearized.chunks, linearized.linearizedChunks, state.interleaving,
    state.variables, state.fieldPipelines, state.chunkPipeline, linearized.stage.layout,
  );
  return collectMetadata(state, encoded.encodedChunks, typed.variableStats);
}

const GROUP_KEYS: Record<string, string[]> = {
  schema: ['schema', 'type_assignments', 'logical_types'],
  layout: ['shape', 'chunk_shape', 'chunk_grid', 'chunk_order', 'partitioning', 'interleaving'],
  codecs: ['codec_pipelines'],
  chunkIndex: ['chunk_index'],
  endianness: ['byte_order'],
};

describe('collectMetadata group filtering', () => {
  it('all-on emits every key plus envelope + custom entries', () => {
    const entries = collectFor(stateWith({}));
    const keys = entries.map((e) => e.key);
    for (const k of ['schema', 'shape', 'codec_pipelines', 'metadata_format', 'byte_order', 'author']) {
      expect(keys).toContain(k);
    }
  });

  for (const [group, keys] of Object.entries(GROUP_KEYS)) {
    it(`${group} off omits exactly its keys`, () => {
      const off = collectFor(stateWith({ [group]: false } as never)).map((e) => e.key);
      const on = collectFor(stateWith({})).map((e) => e.key);
      for (const k of keys) expect(off).not.toContain(k);
      // nothing else disappears:
      expect(on.filter((k) => !keys.includes(k)).every((k) => off.includes(k))).toBe(true);
    });
  }

  it('descriptive off omits variable_statistics AND custom entries', () => {
    const off = collectFor(stateWith({ descriptive: false })).map((e) => e.key);
    expect(off).not.toContain('variable_statistics');
    expect(off).not.toContain('author');
  });

  it('metadata_format envelope key is always present regardless of toggles', () => {
    const allOff = collectFor(stateWith({
      schema: false, layout: false, codecs: false, chunkIndex: false, descriptive: false, endianness: false,
    }));
    const keys = allOff.map((e) => e.key);
    expect(keys).toContain('metadata_format');
  });

  it('endianness off omits byte_order (cl-8: its own group, not envelope)', () => {
    const off = collectFor(stateWith({ endianness: false })).map((e) => e.key);
    expect(off).not.toContain('byte_order');
    // metadata_format (the true envelope key) still present.
    expect(off).toContain('metadata_format');
  });

  it('METADATA_KEY_GROUPS covers every non-envelope auto key collectMetadata emits', () => {
    const keys = collectFor(stateWith({})).map((e) => e.key);
    const envelope = new Set(['metadata_format']);
    for (const k of keys) {
      if (envelope.has(k) || k === 'author') continue;
      expect(METADATA_KEY_GROUPS[k], `unmapped auto key: ${k}`).toBeDefined();
    }
  });
});
