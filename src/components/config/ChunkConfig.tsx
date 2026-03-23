import { computeChunkGrid, computeChunkCount } from '../../engine/chunk.ts';
import { colors, fontSizes, radii, spacing } from '../../theme.ts';

interface ChunkConfigProps {
  shape: number[];
  chunkShape: number[];
  onChunkShapeChange: (chunkShape: number[]) => void;
}

const inputStyle: React.CSSProperties = {
  background: colors.surfaceInput,
  border: `1px solid ${colors.border}`,
  borderRadius: radii.sm,
  fontSize: fontSizes.sm,
  color: colors.textPrimary,
  padding: `${spacing.xs}px ${spacing.sm}px`,
  outline: 'none',
  fontFamily: 'inherit',
};

export function ChunkConfig({ shape, chunkShape, onChunkShapeChange }: ChunkConfigProps) {
  const grid = computeChunkGrid(shape, chunkShape);
  const count = computeChunkCount(shape, chunkShape);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm }}>
      {chunkShape.map((cs, d) => (
        <div key={d} style={{ display: 'flex', alignItems: 'center', gap: spacing.sm }}>
          <span style={{ fontSize: fontSizes.sm, color: colors.textSecondary, minWidth: 40 }}>
            Dim {d}
          </span>
          <input
            type="number"
            min={1}
            max={shape[d]}
            value={cs}
            onChange={(e) => {
              const v = Math.max(1, Math.min(shape[d], parseInt(e.target.value) || 1));
              const newChunkShape = [...chunkShape];
              newChunkShape[d] = v;
              onChunkShapeChange(newChunkShape);
            }}
            style={{ ...inputStyle, width: 60 }}
          />
          <span style={{ fontSize: fontSizes.xs, color: colors.textTertiary }}>
            / {shape[d]}
          </span>
        </div>
      ))}

      <div style={{ fontSize: fontSizes.xs, color: colors.textSecondary }}>
        Grid: {grid.join(' x ')}
      </div>
      <div
        style={{
          fontSize: fontSizes.xs,
          color: count > 1000 ? colors.paneAccentRight : colors.textSecondary,
        }}
      >
        {count} chunk{count !== 1 ? 's' : ''}
        {count > 1000 && ' — consider larger chunks'}
      </div>
    </div>
  );
}
