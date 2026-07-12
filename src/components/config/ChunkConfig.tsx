import { computeChunkGrid, computeChunkCount } from '../../engine/chunk.ts';
import type { LinearizationOrder } from '../../engine/order.ts';
import { colors, fontSizes, spacing } from '../../theme.ts';
import { inputStyle } from '../shared/controlStyles.ts';
import { NumberInput } from '../shared/NumberInput.tsx';

interface ChunkConfigProps {
  shape: number[];
  chunkShape: number[];
  onChunkShapeChange: (chunkShape: number[]) => void;
  dataModel: 'tabular' | 'array';
  linearization: LinearizationOrder;
  onLinearizationChange: (linearization: LinearizationOrder) => void;
  byteOrder: 'little' | 'big';
  onByteOrderChange: (byteOrder: 'little' | 'big') => void;
}

const LINEARIZATION_OPTIONS: { value: LinearizationOrder; label: string; title: string }[] = [
  { value: 'c', label: 'C order (row-major)', title: 'Last dimension varies fastest — standard row-major layout.' },
  { value: 'fortran', label: 'Fortran order (column-major)', title: 'First dimension varies fastest — standard column-major layout.' },
  { value: 'morton', label: 'Morton (Z-order)', title: 'Bit-interleaved coordinates — spatial locality in the byte stream.' },
];

// Task cl-9: unlike linearization, byte order applies to both data models
// and every ndim (any multi-byte dtype has an endianness, even scalar-shaped
// data), so this control has no visibility gate.
const BYTE_ORDER_OPTIONS: { value: 'little' | 'big'; label: string; title: string }[] = [
  { value: 'little', label: 'Little-endian', title: 'LSB first — the default, matches most consumer hardware.' },
  { value: 'big', label: 'Big-endian', title: 'MSB first — network byte order.' },
];

export function ChunkConfig({
  shape,
  chunkShape,
  onChunkShapeChange,
  dataModel,
  linearization,
  onLinearizationChange,
  byteOrder,
  onByteOrderChange,
}: ChunkConfigProps) {
  const grid = computeChunkGrid(shape, chunkShape);
  const count = computeChunkCount(shape, chunkShape);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm }}>
      {chunkShape.map((cs, d) => (
        <div key={d} style={{ display: 'flex', alignItems: 'center', gap: spacing.sm }}>
          <span style={{ fontSize: fontSizes.sm, color: colors.textSecondary, minWidth: 40 }}>
            Dim {d}
          </span>
          <NumberInput
            min={1}
            max={shape[d]}
            value={cs}
            onValue={(n) => {
              const newChunkShape = [...chunkShape];
              newChunkShape[d] = Math.max(1, Math.min(shape[d], Math.trunc(n)));
              onChunkShapeChange(newChunkShape);
            }}
            style={{ ...inputStyle(), width: 60 }}
          />
          <span style={{ fontSize: fontSizes.xs, color: colors.textTertiary }}>
            / {shape[d]}
          </span>
        </div>
      ))}

      {dataModel === 'array' && shape.length > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: spacing.sm }}>
          <span style={{ fontSize: fontSizes.sm, color: colors.textSecondary }}>
            Order
          </span>
          <select
            data-testid="linearization-select"
            value={linearization}
            onChange={(e) => onLinearizationChange(e.target.value as LinearizationOrder)}
            style={{ ...inputStyle(), cursor: 'pointer' }}
          >
            {LINEARIZATION_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value} title={opt.title}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: spacing.sm }}>
        <span style={{ fontSize: fontSizes.sm, color: colors.textSecondary }}>
          Byte order
        </span>
        <select
          data-testid="byte-order-toggle"
          value={byteOrder}
          onChange={(e) => onByteOrderChange(e.target.value as 'little' | 'big')}
          style={{ ...inputStyle(), cursor: 'pointer' }}
        >
          {BYTE_ORDER_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value} title={opt.title}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div style={{ fontSize: fontSizes.xs, color: colors.textSecondary }}>
        Grid: {grid.join(' x ')}
      </div>
      <div
        style={{
          fontSize: fontSizes.xs,
          color: count > 1000 ? colors.warning : colors.textSecondary,
        }}
      >
        {count} chunk{count !== 1 ? 's' : ''}
        {count > 1000 && ' — consider larger chunks'}
      </div>
    </div>
  );
}
