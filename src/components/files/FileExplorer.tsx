import type { VirtualFile } from '../../types/pipeline.ts';
import { colors, fonts, fontSizes, spacing, radii } from '../../theme.ts';

interface FileExplorerProps {
  files: VirtualFile[];
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileExplorer({ files }: FileExplorerProps) {
  if (files.length === 0) return null;

  return (
    <div style={{
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
            {formatFileSize(file.bytes.length)}
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
