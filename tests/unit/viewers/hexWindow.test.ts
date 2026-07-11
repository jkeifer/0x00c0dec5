import { describe, it, expect } from 'vitest';
import { clampWindowStart, windowStartForByte, WINDOW_ROWS } from '../../../src/components/viewers/useHexData.ts';

describe('hex window math', () => {
  it('clamps to [0, rowCount - WINDOW_ROWS]', () => {
    expect(clampWindowStart(-5, 1_000_000)).toBe(0);
    expect(clampWindowStart(999_999_999, 1_000_000)).toBe(1_000_000 - WINDOW_ROWS);
    expect(clampWindowStart(1234, 1_000_000)).toBe(1234);
  });
  it('rowCount below one window pins start to 0', () => {
    expect(clampWindowStart(50, 100)).toBe(0);
  });
  it('shrink-safe: a persisted windowStart from a larger shape clamps against the new, smaller rowCount', () => {
    // Simulates a shape shrink that leaves a section still windowed: the
    // component reads windowStart from parent state (unchanged since the
    // shrink) but must clamp it against the CURRENT rowCount at the read
    // site (HexView.tsx), not the rowCount the value was set under.
    expect(clampWindowStart(500_000, 300_000)).toBe(300_000 - WINDOW_ROWS);
  });
  it('windowStartForByte centers the target row', () => {
    const start = windowStartForByte(8_000_000, 16, 1_000_000); // row 500,000
    expect(start).toBe(500_000 - WINDOW_ROWS / 2);
    // target row is inside [start, start + WINDOW_ROWS)
    expect(500_000).toBeGreaterThanOrEqual(start);
    expect(500_000).toBeLessThan(start + WINDOW_ROWS);
  });
});
