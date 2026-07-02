import type { AppState } from '../../types/state.ts';
import { Radio } from '../shared/Radio.tsx';
import { colors, fonts, fontSizes, spacing } from '../../theme.ts';
import { inputStyle } from '../shared/controlStyles.ts';

interface WriteConfigProps {
  write: AppState['write'];
  onMagicChange: (magicNumber: string) => void;
  onPartitioningChange: (partitioning: 'single' | 'per-chunk') => void;
  onMetadataPlacementChange: (placement: 'header' | 'footer' | 'sidecar') => void;
  onChunkOrderChange: (order: 'row-major' | 'column-major') => void;
  onIncludeMetadataChange: (includeMetadata: boolean) => void;
  onFooterLocatorChange: (footerLocator: 'trailer' | 'none') => void;
}

function isValidHex(v: string): boolean {
  return /^[0-9a-fA-F]*$/.test(v) && v.length % 2 === 0;
}

const warningTextStyle: React.CSSProperties = {
  fontSize: fontSizes.xs,
  color: colors.warning,
};

export function WriteConfig({
  write,
  onMagicChange,
  onPartitioningChange,
  onMetadataPlacementChange,
  onChunkOrderChange,
  onIncludeMetadataChange,
  onFooterLocatorChange,
}: WriteConfigProps) {
  const hexValid = isValidHex(write.magicNumber);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm }}>
      {/* Include metadata — first control, most consequential */}
      <div data-testid="include-metadata-toggle" style={{ display: 'flex', flexDirection: 'column', gap: spacing.xs }}>
        <span style={{ fontSize: fontSizes.xs, color: colors.textSecondary }}>Include Metadata</span>
        <Radio
          options={[
            { value: 'yes', label: 'Yes' },
            { value: 'no', label: 'No' },
          ]}
          value={write.includeMetadata ? 'yes' : 'no'}
          onChange={(v) => onIncludeMetadataChange(v === 'yes')}
          size="sm"
        />
      </div>

      {/* Magic number */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.xs }}>
        <span style={{ fontSize: fontSizes.xs, color: colors.textSecondary }}>Magic Number</span>
        <input
          type="text"
          value={write.magicNumber}
          onChange={(e) => onMagicChange(e.target.value)}
          data-testid="magic-input"
          style={{
            ...inputStyle(),
            fontFamily: fonts.mono,
            borderColor: hexValid ? colors.border : colors.warning,
          }}
        />
        {!hexValid && (
          <span style={warningTextStyle}>
            Invalid hex — non-hex characters are ignored
          </span>
        )}
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

      {/* Footer locator — only meaningful when placement is footer */}
      {write.metadataPlacement === 'footer' && (
        <div data-testid="footer-locator-toggle" style={{ display: 'flex', flexDirection: 'column', gap: spacing.xs }}>
          <span style={{ fontSize: fontSizes.xs, color: colors.textSecondary }}>Footer Locator</span>
          <Radio
            options={[
              { value: 'trailer', label: 'Length trailer' },
              { value: 'none', label: 'None (reader must scan)' },
            ]}
            value={write.footerLocator}
            onChange={(v) => onFooterLocatorChange(v as 'trailer' | 'none')}
            size="sm"
          />
          <span style={{ fontSize: fontSizes.xs, color: colors.textTertiary }}>
            How the reader finds footer metadata with no separate index to consult.
            "Length trailer" appends a 4-byte length before the closing magic, exactly
            like Parquet ([footer][len][&quot;PAR1&quot;]) — the reader seeks straight to it.
            "None" leaves the reader to scan backward for metadata, which can fail —
            that failure is itself the lesson: real formats use a trailer so they never have to guess.
          </span>
        </div>
      )}

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
