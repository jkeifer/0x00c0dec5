import { colors, fontSizes, spacing } from '../../theme.ts';

const SECTIONS = ['Schema', 'Chunk', 'Interleave', 'Codecs', 'Metadata', 'Write'];

export function Sidebar() {
  return (
    <div
      style={{
        background: colors.surface,
        overflowY: 'auto',
        padding: spacing.md,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        height: '100%',
      }}
    >
      {SECTIONS.map((section, i) => (
        <div key={section}>
          {i > 0 && (
            <div
              style={{
                height: 1,
                background: colors.borderSubtle,
                marginBottom: 14,
              }}
            />
          )}
          <div
            style={{
              fontSize: fontSizes.sm,
              color: colors.textSecondary,
              textTransform: 'uppercase',
              letterSpacing: '0.8px',
              fontWeight: 600,
              marginBottom: spacing.xs,
            }}
          >
            {section}
          </div>
          <div
            style={{
              fontSize: fontSizes.md,
              color: colors.textTertiary,
            }}
          >
            Phase 4
          </div>
        </div>
      ))}
    </div>
  );
}
