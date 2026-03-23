import type { AppState } from '../../types/state.ts';
import { Radio } from '../shared/Radio.tsx';
import { colors, fonts, fontSizes, radii, spacing } from '../../theme.ts';

interface WriteConfigProps {
  write: AppState['write'];
  onMagicChange: (magicNumber: string) => void;
  onPartitioningChange: (partitioning: 'single' | 'per-chunk') => void;
  onMetadataPlacementChange: (placement: 'header' | 'footer' | 'sidecar') => void;
  onChunkOrderChange: (order: 'row-major' | 'column-major') => void;
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

function isValidHex(v: string): boolean {
  return /^[0-9a-fA-F]*$/.test(v) && v.length % 2 === 0;
}

export function WriteConfig({
  write,
  onMagicChange,
  onPartitioningChange,
  onMetadataPlacementChange,
  onChunkOrderChange,
}: WriteConfigProps) {
  const hexValid = isValidHex(write.magicNumber);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm }}>
      {/* Magic number */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.xs }}>
        <span style={{ fontSize: fontSizes.xs, color: colors.textSecondary }}>Magic Number</span>
        <input
          type="text"
          value={write.magicNumber}
          onChange={(e) => onMagicChange(e.target.value)}
          style={{
            ...inputStyle,
            fontFamily: fonts.mono,
            borderColor: hexValid ? colors.border : colors.paneAccentRight,
          }}
        />
      </div>

      {/* Partitioning */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.xs }}>
        <span style={{ fontSize: fontSizes.xs, color: colors.textSecondary }}>Partitioning</span>
        <Radio
          options={[
            { value: 'single', label: 'Single file' },
            { value: 'per-chunk', label: 'Per-chunk' },
          ]}
          value={write.partitioning}
          onChange={(v) => onPartitioningChange(v as 'single' | 'per-chunk')}
          size="sm"
        />
      </div>

      {/* Metadata placement */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.xs }}>
        <span style={{ fontSize: fontSizes.xs, color: colors.textSecondary }}>
          Metadata Placement
        </span>
        <Radio
          options={[
            { value: 'header', label: 'Header' },
            { value: 'footer', label: 'Footer' },
            { value: 'sidecar', label: 'Sidecar' },
          ]}
          value={write.metadataPlacement}
          onChange={(v) =>
            onMetadataPlacementChange(v as 'header' | 'footer' | 'sidecar')
          }
          size="sm"
        />
      </div>

      {/* Chunk ordering */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.xs }}>
        <span style={{ fontSize: fontSizes.xs, color: colors.textSecondary }}>Chunk Ordering</span>
        <Radio
          options={[
            { value: 'row-major', label: 'Row-major' },
            { value: 'column-major', label: 'Column-major' },
          ]}
          value={write.chunkOrder}
          onChange={(v) => onChunkOrderChange(v as 'row-major' | 'column-major')}
          size="sm"
        />
      </div>
    </div>
  );
}
