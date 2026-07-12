// @vitest-environment jsdom
//
// Task 7 (codec-curation plan): ChunkConfig gains a `linearization-select`
// control, shown only for multi-dimensional array data models (dataModel
// 'array' with shape.length > 1 — tabular data and 1-D arrays have no
// meaningful linearization order to pick). Wired the same way as the rest of
// the Chunk section: Sidebar.tsx passes state slices + a dispatch callback,
// mirroring InterleaveConfig's `onChange` idiom.
//
// Task 9: ChunkConfig also gains a `byte-order-toggle` control, unlike
// linearization this is visible for BOTH data models and ALL ndims (a
// scalar-shaped byte still has an endianness for multi-byte dtypes).
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
        byteOrder="little"
        onByteOrderChange={noop}
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
        byteOrder="little"
        onByteOrderChange={noop}
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
        byteOrder="little"
        onByteOrderChange={noop}
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
        byteOrder="little"
        onByteOrderChange={noop}
      />,
    );

    fireEvent.change(screen.getByTestId('linearization-select'), {
      target: { value: 'morton' },
    });

    expect(picked).toBe('morton');
  });
});

// Task 9 (codec-curation plan): byte-order-toggle, unlike linearization,
// is visible for BOTH data models and ALL ndims — a scalar-shaped dataset
// still has multi-byte dtypes with an endianness. Little/big two-option
// control, dispatches SET_BYTE_ORDER via onByteOrderChange.
describe('ChunkConfig byte-order toggle', () => {
  it('renders for tabular data model', () => {
    render(
      <ChunkConfig
        shape={[4, 4]}
        chunkShape={[2, 2]}
        onChunkShapeChange={noop}
        dataModel="tabular"
        linearization="c"
        onLinearizationChange={noop}
        byteOrder="little"
        onByteOrderChange={noop}
      />,
    );

    expect(screen.getByTestId('byte-order-toggle')).toBeTruthy();
  });

  it('renders for a 1-D array data model', () => {
    render(
      <ChunkConfig
        shape={[10]}
        chunkShape={[5]}
        onChunkShapeChange={noop}
        dataModel="array"
        linearization="c"
        onLinearizationChange={noop}
        byteOrder="little"
        onByteOrderChange={noop}
      />,
    );

    expect(screen.getByTestId('byte-order-toggle')).toBeTruthy();
  });

  it('renders for a multi-dimensional array data model', () => {
    render(
      <ChunkConfig
        shape={[4, 4]}
        chunkShape={[2, 2]}
        onChunkShapeChange={noop}
        dataModel="array"
        linearization="c"
        onLinearizationChange={noop}
        byteOrder="little"
        onByteOrderChange={noop}
      />,
    );

    expect(screen.getByTestId('byte-order-toggle')).toBeTruthy();
  });

  it('changing the control calls onByteOrderChange with "big"', () => {
    let picked: string | null = null;
    render(
      <ChunkConfig
        shape={[4, 4]}
        chunkShape={[2, 2]}
        onChunkShapeChange={noop}
        dataModel="tabular"
        linearization="c"
        onLinearizationChange={noop}
        byteOrder="little"
        onByteOrderChange={(order) => {
          picked = order;
        }}
      />,
    );

    fireEvent.change(screen.getByTestId('byte-order-toggle'), {
      target: { value: 'big' },
    });

    expect(picked).toBe('big');
  });
});
