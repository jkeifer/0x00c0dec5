// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { HexRowRenderer } from '../../components/viewers/HexRowRenderer.tsx';
import { buildValueBlocksLayout, type ValueSources } from '../../engine/layout.ts';

function renderRow(byteStart: number, byteEnd: number, totalBytes: number): string {
  const bytes = new Uint8Array(totalBytes).map((_, i) => i);
  const values = Array.from({ length: totalBytes }, (_, i) => i);
  const layout = buildValueBlocksLayout(
    [{ name: 'v', color: '#e06c75' }],
    [totalBytes],
    new Map([['v', values]]),
    () => 'uint8',
  );
  const sources: ValueSources = { values: new Map([['v', values]]), format: 'typed' };
  const { container } = render(
    <div>
      <HexRowRenderer
        rowIndex={0}
        byteStart={byteStart}
        byteEnd={byteEnd}
        bytesPerRow={16}
        bytes={bytes}
        layout={layout}
        sources={sources}
        regionByByte={new Uint8Array(totalBytes)}
        regionBoundaries={new Set()}
        offsetWidth={8}
        totalBytes={totalBytes}
        hoveredTraceId={null}
        hoveredChunkId={null}
        isCrossPane={false}
        onHover={() => {}}
      />
    </div>,
  );
  return container.textContent ?? '';
}

// Regression for UI-1: a partial final row must occupy exactly the same
// character width as a full row, or the ASCII column drifts.
describe('hex row alignment (UI-1)', () => {
  it('renders partial final rows at the same width as full rows', () => {
    const full = renderRow(0, 16, 21); // full 16-byte row
    const partial = renderRow(16, 21, 21); // final row with 5 bytes
    expect(partial.length).toBe(full.length);
  });

  it('aligns the ASCII column delimiter at the same position', () => {
    const full = renderRow(0, 16, 21);
    const partial = renderRow(16, 21, 21);
    expect(partial.indexOf('│')).toBe(full.indexOf('│'));
    expect(partial.lastIndexOf('│')).toBe(full.lastIndexOf('│'));
  });

  it('single-byte final row stays aligned', () => {
    const full = renderRow(0, 16, 17);
    const partial = renderRow(16, 17, 17);
    expect(partial.length).toBe(full.length);
    expect(partial.indexOf('│')).toBe(full.indexOf('│'));
  });
});
