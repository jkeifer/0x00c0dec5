import { describe, it, expect } from 'vitest';
import { computePipelineStages } from '../../../src/engine/pipelineCompute.ts';
import { traceAt, byteRangesForTrace, encodedChunkMeta, type ChunkBlockRegion } from '../../../src/engine/layout.ts';
import { DEFAULT_STATE } from '../../../src/types/state.ts';
import type { AppState } from '../../../src/types/state.ts';
import type { CodecStep } from '../../../src/types/codecs.ts';

/**
 * The Encoded stage must describe the bytes it actually holds.
 *
 * Before this suite, `buildEncodedLayout` re-based the Linearized region onto
 * the encoded byte range unchanged and `buildStageSources` pointed the stage
 * at the *pre-codec* typed values. So every codec displayed its input values,
 * and a byte-moving codec (byte shuffle) additionally pointed each byte at the
 * wrong element — hovering an element highlighted a byte range that no longer
 * held its data.
 */

/** One 8-element int16 variable in a single chunk — small enough that every
 *  byte's expected identity can be written out by hand. */
function stateWithPipeline(steps: CodecStep[]): AppState {
  const v = {
    ...DEFAULT_STATE.variables[0],
    id: 'temp',
    name: 'temp',
    typeAssignment: { ...DEFAULT_STATE.variables[0].typeAssignment, storageDtype: 'int16' as const },
  };
  return {
    ...DEFAULT_STATE,
    shape: [8],
    chunkShape: [8],
    interleaving: 'column',
    variables: [v],
    fieldPipelines: { temp: steps },
    chunkPipeline: [],
  };
}

function encoded(steps: CodecStep[]) {
  const result = computePipelineStages(stateWithPipeline(steps));
  const stage = result.stages[3];
  expect(stage.name).toBe('Encoded');
  return { stage, sources: result.stageSources.get('encoded')! };
}

/** Every byte's (traceId, displayValue) at the Encoded stage. */
function tracePerByte(steps: CodecStep[]) {
  const { stage, sources } = encoded(steps);
  return Array.from({ length: stage.bytes.length }, (_, i) => {
    const t = traceAt(stage.layout, i, sources)!;
    return { traceId: t.traceId, displayValue: t.displayValue };
  });
}

describe('encodedChunkMeta trace modes', () => {
  const cases: [string, CodecStep[], string][] = [
    ['no codecs', [], 'value-preserving'],
    ['delta', [{ codec: 'delta', params: { elementSize: 2 } }], 'value-preserving'],
    ['zigzag', [{ codec: 'zigzag', params: {} }], 'value-preserving'],
    ['byte shuffle', [{ codec: 'byte-shuffle', params: { elementSize: 2 } }], 'positional'],
    ['bit shuffle', [{ codec: 'bit-shuffle', params: {} }], 'chunk-level'],
    ['rle', [{ codec: 'rle', params: {} }], 'chunk-level'],
  ];
  for (const [name, steps, mode] of cases) {
    it(`${name} -> ${mode}`, () => {
      expect(encodedChunkMeta(steps, 'int16').traceMode).toBe(mode);
    });
  }

  it('takes the worst mode in the pipeline, in either order', () => {
    const shuffle: CodecStep = { codec: 'byte-shuffle', params: { elementSize: 2 } };
    const delta: CodecStep = { codec: 'delta', params: { elementSize: 2 } };
    const rle: CodecStep = { codec: 'rle', params: {} };
    expect(encodedChunkMeta([delta, shuffle], 'int16').traceMode).toBe('positional');
    expect(encodedChunkMeta([shuffle, delta], 'int16').traceMode).toBe('positional');
    expect(encodedChunkMeta([shuffle, rle], 'int16').traceMode).toBe('chunk-level');
  });
});

describe('encodedChunkMeta: what the bytes are vs what a slot draws', () => {
  const shuffle: CodecStep = { codec: 'byte-shuffle', params: { elementSize: 2 } };
  const bitShuffle: CodecStep = { codec: 'bit-shuffle', params: { elementSize: 2 } };
  const delta: CodecStep = { codec: 'delta', params: { elementSize: 2 } };

  it('agree when nothing destroys element structure', () => {
    const meta = encodedChunkMeta([delta], 'int16');
    expect(meta.outputDtype).toBe('int16');
    expect(meta.slotDtype).toBe('int16');
  });

  it('diverge across a shuffle: the bytes are uint8, the slot still draws int16', () => {
    // outputDtype is what the NEXT codec receives — byte planes, so uint8.
    // slotDtype is what a reader ignoring the codec would try to decode at
    // that offset, which is the whole point of a positional slot.
    const meta = encodedChunkMeta([shuffle], 'int16');
    expect(meta.outputDtype).toBe('uint8');
    expect(meta.slotDtype).toBe('int16');
    expect(meta.traceMode).toBe('positional');
  });

  it('freezes slotDtype at the FIRST destroying step, not the last', () => {
    expect(encodedChunkMeta([delta, shuffle, delta], 'int16').slotDtype).toBe('int16');
    expect(encodedChunkMeta([bitShuffle, shuffle], 'float32').slotDtype).toBe('float32');
  });

  it('feeds a following codec uint8, which is what the editor seeds elementSize from', () => {
    expect(encodedChunkMeta([shuffle, delta], 'float64').outputDtype).toBe('uint8');
  });
});

describe('Encoded stage shows the values its own bytes hold', () => {
  it('no codecs: unchanged per-element traces and values', () => {
    const traces = tracePerByte([]);
    expect(traces[0].traceId).toBe('temp:0');
    expect(traces[1].traceId).toBe('temp:0');
    expect(traces[2].traceId).toBe('temp:1');
    // Sanity: the stage really does hold the typed values.
    const typed = computePipelineStages(stateWithPipeline([])).typedValues.get('temp')!;
    expect(traces[0].displayValue).toBe(String(typed[0]));
  });

  it('delta: keeps per-element traces but displays the DIFFERENCES, not the input', () => {
    const plain = tracePerByte([]);
    const delta = tracePerByte([{ codec: 'delta', params: { elementSize: 2 } }]);

    // Delta doesn't move bytes, so identity is untouched...
    expect(delta.map((t) => t.traceId)).toEqual(plain.map((t) => t.traceId));

    // ...but the values are now differences. Element 0 is unchanged by delta;
    // every later element should read as (v[i] - v[i-1]).
    const values = plain.filter((_, i) => i % 2 === 0).map((t) => Number(t.displayValue));
    const shown = delta.filter((_, i) => i % 2 === 0).map((t) => Number(t.displayValue));
    expect(shown[0]).toBe(values[0]);
    for (let i = 1; i < values.length; i++) {
      expect(shown[i]).toBe(values[i] - values[i - 1]);
    }
    // The bug this pins: at least one element must differ from its input.
    expect(shown).not.toEqual(values);
  });

  it('byte shuffle: slots are positional, not elements, and decode to the transposed bytes', () => {
    const steps: CodecStep[] = [{ codec: 'byte-shuffle', params: { elementSize: 2 } }];
    const { stage, sources } = encoded(steps);
    const traces = tracePerByte(steps);

    // 8 int16s = 16 bytes; the transpose puts all low bytes first, then all
    // high bytes. Slot i is bytes [2i, 2i+2) — which after the shuffle are the
    // low bytes of elements 2i and 2i+1, not element i's data.
    expect(stage.bytes.length).toBe(16);
    expect(traces.map((t) => t.traceId)).toEqual([
      'slot:0:2', 'slot:0:2', 'slot:2:2', 'slot:2:2', 'slot:4:2', 'slot:4:2', 'slot:6:2', 'slot:6:2',
      'slot:8:2', 'slot:8:2', 'slot:10:2', 'slot:10:2', 'slot:12:2', 'slot:12:2', 'slot:14:2', 'slot:14:2',
    ]);

    // Each slot displays what a reader ignoring the codec would decode there:
    // little-endian int16 straight out of the stage's own bytes.
    for (let slot = 0; slot < 8; slot++) {
      const lo = stage.bytes[slot * 2];
      const hi = stage.bytes[slot * 2 + 1];
      const expected = new DataView(new Uint8Array([lo, hi]).buffer).getInt16(0, true);
      expect(Number(traces[slot * 2].displayValue)).toBe(expected);
    }

    // No real element claims bytes here — so a cross-pane value hover finds
    // nothing and falls back to the chunk wash instead of lighting up a byte
    // range that isn't that element's.
    for (let el = 0; el < 8; el++) {
      expect(byteRangesForTrace(stage.layout, `temp:${el}`)).toEqual([]);
    }
    // The chunk itself is still locatable, which is what the fallback uses.
    expect(byteRangesForTrace(stage.layout, 'chunk:temp:0')).toEqual([{ start: 0, end: 16 }]);

    // A slot id resolves to exactly its own bytes.
    expect(byteRangesForTrace(stage.layout, 'slot:6:2')).toEqual([{ start: 6, end: 8 }]);
    // ...and only in a layout that actually has a positional region there: the
    // same id is a meaningless byte offset in any other stage.
    const linearized = computePipelineStages(stateWithPipeline(steps)).stages[2];
    expect(byteRangesForTrace(linearized.layout, 'slot:6:2')).toEqual([]);

    // traceAt round-trips its own ids: the byte a slot id points at reports
    // that same id (the inversion property the layout suite pins generally).
    for (const id of new Set(traces.map((t) => t.traceId))) {
      const [{ start }] = byteRangesForTrace(stage.layout, id);
      expect(traceAt(stage.layout, start, sources)!.traceId).toBe(id);
    }
  });

  it('bit shuffle: degrades all the way to chunk-level', () => {
    const traces = tracePerByte([{ codec: 'bit-shuffle', params: {} }]);
    expect(new Set(traces.map((t) => t.traceId))).toEqual(new Set(['chunk:temp:0']));
  });
});

// ─── Fixed-ratio slot geometry (Task 5) ────────────────────────────────────
//
// A fixed-ratio codec (scale-offset) narrows every slot's byte width, not
// just its dtype label — 4 float32 elements (16 bytes) encode to 4 int16
// slots (8 bytes). Unlike delta/byte-shuffle (size-preserving), the slot
// geometry itself must shrink to match the pipeline's real output width.

/** 4-element float32 variable, single column chunk — matches the brief's
 *  fixture shape exactly (16 raw bytes -> 8 encoded bytes). */
function stateWithScaleOffset(steps: CodecStep[]): AppState {
  const v = { ...DEFAULT_STATE.variables[0], id: 'temp', name: 'temp' }; // storageDtype: float32
  return {
    ...DEFAULT_STATE,
    shape: [4],
    chunkShape: [4],
    interleaving: 'column',
    variables: [v],
    fieldPipelines: { temp: steps },
    chunkPipeline: [],
  };
}

function encodedScaleOffset(steps: CodecStep[]) {
  const result = computePipelineStages(stateWithScaleOffset(steps));
  const stage = result.stages[3];
  expect(stage.name).toBe('Encoded');
  return { stage, sources: result.stageSources.get('encoded')! };
}

describe('fixed-ratio pipeline: slots take the post-pipeline dtype AND width', () => {
  const steps: CodecStep[] = [
    { codec: 'scale-offset', params: { scale: 10, offset: 0, sourceDtype: 'float32', targetDtype: 'int16' } },
  ];

  it('encodedChunkMeta reports int16 for both outputDtype and slotDtype', () => {
    const meta = encodedChunkMeta(steps, 'float32');
    expect(meta).toEqual({ outputDtype: 'int16', slotDtype: 'int16', traceMode: 'value-preserving' });
  });

  it('the Encoded stage narrows to 8 bytes with int16 slot geometry', () => {
    const { stage } = encodedScaleOffset(steps);
    expect(stage.bytes.length).toBe(8); // 4 elements x 2 bytes, not 4 x 4
    const region = stage.layout.regions[0] as ChunkBlockRegion;
    expect(region.byteLength).toBe(8);
    expect(region.fields).toEqual([{
      variableName: 'temp', variableColor: DEFAULT_STATE.variables[0].color, dtype: 'int16', size: 2, offset: 0,
    }]);
  });

  it('traceAt: element i sits at byte i*2, decodes int16 straight out of stage bytes', () => {
    const { stage, sources } = encodedScaleOffset(steps);
    const t0 = traceAt(stage.layout, 0, sources)!;
    const t1 = traceAt(stage.layout, 2, sources)!;
    expect(t0.traceId).toBe('temp:0');
    expect(t1.traceId).toBe('temp:1');
    expect(t0.byteCount).toBe(2);
    expect(t1.byteCount).toBe(2);
    expect(t0.dtype).toBe('int16');
    // Stage bytes are the real encode output — decode int16 LE by hand and
    // compare, rather than re-deriving the codec's own rounding.
    const view = new DataView(stage.bytes.buffer, stage.bytes.byteOffset, stage.bytes.byteLength);
    expect(Number(t0.displayValue)).toBe(view.getInt16(0, true));
    expect(Number(t1.displayValue)).toBe(view.getInt16(2, true));
  });

  it('byteRangesForTrace inverts traceAt across the new (narrower) width', () => {
    const { stage } = encodedScaleOffset(steps);
    expect(byteRangesForTrace(stage.layout, 'temp:0')).toEqual([{ start: 0, end: 2 }]);
    expect(byteRangesForTrace(stage.layout, 'temp:1')).toEqual([{ start: 2, end: 4 }]);
    expect(byteRangesForTrace(stage.layout, 'temp:3')).toEqual([{ start: 6, end: 8 }]);
  });
});
