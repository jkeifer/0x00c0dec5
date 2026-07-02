import type { VirtualFile } from '../../types/pipeline.ts';
import { colors, fonts, fontSizes, spacing, radii } from '../../theme.ts';
import { formatByteCount } from '../../engine/bytes.ts';

interface FileExplorerProps {
  files: VirtualFile[];
}

export function FileExplorer({ files }: FileExplorerProps) {
  if (files.length === 0) return null;

  return (
    <div data-testid="file-explorer" style={{
      display: 'flex',
      flexDirection: 'column',
      gap: spacing.xs,
      marginTop: spacing.sm,
    }}>
      <div style={{
        fontSize: fontSizes.xs,
        color: colors.textSecondary,
        textTransform: 'uppercase',
        letterSpacing: '0.8px',
        fontWeight: 600,
      }}>
        Files
      </div>
      {files.map((file, i) => (
        <div
          key={i}
          data-testid={`file-entry-${i}`}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: `${spacing.xs}px ${spacing.sm}px`,
            background: colors.surfaceInput,
            borderRadius: radii.sm,
            fontFamily: fonts.mono,
            fontSize: fontSizes.sm,
          }}
        >
          <span style={{ color: colors.textPrimary }}>{file.name}</span>
          <span style={{ color: colors.textTertiary, marginLeft: spacing.sm }}>
            {formatByteCount(file.bytes.length)}
          </span>
        </div>
      ))}
      {files.length > 1 && (
        <div style={{
          fontSize: fontSizes.xs,
          color: colors.textTertiary,
          textAlign: 'right',
        }}>
          {files.length} files
        </div>
      )}
    </div>
  );
}
