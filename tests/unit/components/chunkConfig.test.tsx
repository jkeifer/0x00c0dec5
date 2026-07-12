// @vitest-environment jsdom
//
// Task 7 (codec-curation plan): ChunkConfig gains a `linearization-select`
// control, shown only for multi-dimensional array data models (dataModel
// 'array' with shape.length > 1 — tabular data and 1-D arrays have no
// meaningful linearization order to pick). Wired the same way as the rest of
// the Chunk section: Sidebar.tsx passes state slices + a dispatch callback,
// mirroring InterleaveConfig's `onChange` idiom.
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChunkConfig } from '../../../src/components/config/ChunkConfig.tsx';

const noop = () => {};

describe('ChunkConfig linearization select', () => {
  it('renders for a 2-D array data model', () => {
    render(
      <ChunkConfig
        shape={[4, 4]}
        chunkShape={[2, 2]}
        onChunkShapeChange={noop}
        dataModel="array"
        linearization="c"
        onLinearizationChange={noop}
      />,
    );

    expect(screen.getByTestId('linearization-select')).toBeTruthy();
  });

  it('is hidden for tabular data model', () => {
    render(
      <ChunkConfig
        shape={[4, 4]}
        chunkShape={[2, 2]}
        onChunkShapeChange={noop}
        dataModel="tabular"
        linearization="c"
        onLinearizationChange={noop}
      />,
    );

    expect(screen.queryByTestId('linearization-select')).toBeNull();
  });

  it('is hidden for a 1-D array data model', () => {
    render(
      <ChunkConfig
        shape={[10]}
        chunkShape={[5]}
        onChunkShapeChange={noop}
        dataModel="array"
        linearization="c"
        onLinearizationChange={noop}
      />,
    );

    expect(screen.queryByTestId('linearization-select')).toBeNull();
  });

  it('changing the select calls onLinearizationChange with the chosen order', () => {
    let picked: string | null = null;
    render(
      <ChunkConfig
        shape={[4, 4]}
        chunkShape={[2, 2]}
        onChunkShapeChange={noop}
        dataModel="array"
        linearization="c"
        onLinearizationChange={(order) => {
          picked = order;
        }}
      />,
    );

    fireEvent.change(screen.getByTestId('linearization-select'), {
      target: { value: 'morton' },
    });

    expect(picked).toBe('morton');
  });
});
