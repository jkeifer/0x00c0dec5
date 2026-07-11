import { describe, it, expect } from 'vitest';
import { fileMapColors, fileMapByteAt } from '../../../src/components/viewers/fileMap.ts';
import { DEFAULT_STATE } from '../../../src/types/state.ts';
import { computePipelineStages } from '../../../src/engine/pipelineCompute.ts';

describe('fileMapColors', () => {
  const result = computePipelineStages(DEFAULT_STATE);
  const typed = result.stages[1]; // typed stage: one block per variable, distinct colors

  it('produces width*4 RGBA and colors columns by owning region', () => {
    const width = 300;
    const px = fileMapColors(typed.layout, width);
    expect(px.length).toBe(width * 4);
    // First and last columns belong to the first/last variable blocks:
    const first = typed.layout.regions[0];
    const last = typed.layout.regions[typed.layout.regions.length - 1];
    expect(first.kind).toBe('values');
    // Column 0's color equals the first region's variableColor hex:
    const hex = (r: number, g: number, b: number) =>
      '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
    if (first.kind === 'values') expect(hex(px[0], px[1], px[2])).toBe(first.variableColor);
    if (last.kind === 'values') {
      const o = (width - 1) * 4;
      expect(hex(px[o], px[o + 1], px[o + 2])).toBe(last.variableColor);
    }
  });

  it('fileMapByteAt inverts the column mapping within region tolerance', () => {
    const width = 300;
    for (const x of [0, 150, 299]) {
      const byte = fileMapByteAt(typed.layout, width, x);
      expect(byte).toBeGreaterThanOrEqual(0);
      expect(byte).toBeLessThan(typed.layout.byteLength);
      // The byte's own column round-trips to x (center-sampling symmetry):
      expect(Math.floor((byte / typed.layout.byteLength) * width)).toBe(x);
    }
  });

  it('empty layout yields transparent strip and byte 0', () => {
    const empty = { byteLength: 0, shape: [], regions: [] };
    expect(fileMapColors(empty, 10).every((v, i) => (i % 4 === 3 ? v === 0 : true))).toBe(true);
    expect(fileMapByteAt(empty, 10, 5)).toBe(0);
  });
});
