import type { VirtualFile } from '../../types/pipeline.ts';
import { colors, fonts, fontSizes, spacing, radii } from '../../theme.ts';
import { formatByteCount } from '../../engine/bytes.ts';
import { downloadAll, downloadBytes, normalizeDownloadFilename } from './download.ts';

interface FileExplorerProps {
  files: VirtualFile[];
}

const downloadButtonStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 20,
  height: 20,
  padding: 0,
  marginLeft: spacing.sm,
  background: 'transparent',
  border: `1px solid ${colors.border}`,
  borderRadius: radii.sm,
  color: colors.textSecondary,
  cursor: 'pointer',
  lineHeight: 1,
  flexShrink: 0,
};

/** Minimal inline "download" glyph — no icon library dependency. */
function DownloadIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 1.5v8.5m0 0L4.5 6.5M8 10l3.5-3.5M2.5 12.5v1a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-1"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
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
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
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
        {files.length > 1 && (
          <button
            type="button"
            data-testid="download-all"
            title="Download all files"
            onClick={() => { void downloadAll(files); }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: spacing.xs,
              padding: `2px ${spacing.xs}px`,
              background: 'transparent',
              border: `1px solid ${colors.border}`,
              borderRadius: radii.sm,
              color: colors.textSecondary,
              fontSize: fontSizes.xs,
              cursor: 'pointer',
            }}
          >
            <DownloadIcon />
            Download all
          </button>
        )}
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
          <span style={{ color: colors.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {file.name}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
            <span style={{ color: colors.textTertiary, marginLeft: spacing.sm }}>
              {formatByteCount(file.bytes.length)}
            </span>
            <button
              type="button"
              data-testid={`download-file-${i}`}
              title={`Download ${normalizeDownloadFilename(file.name)}`}
              onClick={() => downloadBytes(file.bytes, normalizeDownloadFilename(file.name))}
              style={downloadButtonStyle}
            >
              <DownloadIcon />
            </button>
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
