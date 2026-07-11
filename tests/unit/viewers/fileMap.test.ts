import { describe, it, expect } from 'vitest';
import { fileMapColors, fileMapByteAt, columnByte } from '../../../src/components/viewers/fileMap.ts';
import { DEFAULT_STATE } from '../../../src/types/state.ts';
import { computePipelineStages } from '../../../src/engine/pipelineCompute.ts';
import type { StageLayout } from '../../../src/engine/layout.ts';

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

  // fileMapByteAt(x) must return exactly the byte fileMapColors used to
  // color column x (center sampling), NOT the inverse of the naive
  // round-trip identity floor(byte/byteLength*width) === x — that identity
  // finds the column containing a byte's *left edge*, which differs from
  // center sampling whenever byteLength/width isn't integral. See
  // columnByte's doc comment.
  describe('fileMapByteAt / columnByte sampling contract', () => {
    const synthetic320: StageLayout = {
      byteLength: 320,
      shape: [],
      regions: [{ kind: 'structural', start: 0, byteLength: 320, traceId: 'metadata', label: 'metadata' }],
    };

    const cases: [string, StageLayout, number][] = [
      ['typed fixture', typed.layout, 300],
      ['awkward ratio 300/320', synthetic320, 300],
    ];

    for (const [label, layout, width] of cases) {
      it(`${label}: every column's click matches its rendered byte`, () => {
        for (let x = 0; x < width; x++) {
          const byte = fileMapByteAt(layout, width, x);
          expect(byte).toBe(columnByte(layout.byteLength, width, x));
          expect(byte).toBeGreaterThanOrEqual(0);
          expect(byte).toBeLessThan(layout.byteLength);
        }
      });

      it(`${label}: fileMapByteAt is monotonic non-decreasing across columns`, () => {
        let prev = fileMapByteAt(layout, width, 0);
        for (let x = 1; x < width; x++) {
          const byte = fileMapByteAt(layout, width, x);
          expect(byte).toBeGreaterThanOrEqual(prev);
          prev = byte;
        }
      });

      it(`${label}: first/last columns sample within their own bucket`, () => {
        const { byteLength } = layout;
        const first = fileMapByteAt(layout, width, 0);
        const last = fileMapByteAt(layout, width, width - 1);
        // columnByte(0) = floor(0.5/width * byteLength); bounded by one
        // bucket width (byteLength/width) above 0.
        expect(first).toBeLessThan(byteLength / width + 1);
        // columnByte(width-1) = floor((width-0.5)/width * byteLength), i.e.
        // within one bucket width of the final byte.
        expect(last).toBeGreaterThan(byteLength - byteLength / width - 2);
      });
    }
  });

  it('empty layout yields transparent strip and byte 0', () => {
    const empty = { byteLength: 0, shape: [], regions: [] };
    expect(fileMapColors(empty, 10).every((v, i) => (i % 4 === 3 ? v === 0 : true))).toBe(true);
    expect(fileMapByteAt(empty, 10, 5)).toBe(0);
  });
});
