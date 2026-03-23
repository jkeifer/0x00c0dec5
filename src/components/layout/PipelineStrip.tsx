import { colors, fontSizes, spacing, radii } from '../../theme.ts';
import type { PipelineStage } from '../../types/pipeline.ts';

function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatEntropy(entropy: number): string {
  return `${entropy.toFixed(2)} b/B`;
}

interface PipelineStripProps {
  stages: PipelineStage[];
}

export function PipelineStrip({ stages }: PipelineStripProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: spacing.sm,
        padding: `${spacing.xs}px ${spacing.md}px`,
        background: colors.surface,
        borderTop: `1px solid ${colors.border}`,
        borderBottom: `1px solid ${colors.border}`,
        overflowX: 'auto',
        flexShrink: 0,
      }}
    >
      {stages.map((stage, i) => {
        const prevStage = i > 0 ? stages[i - 1] : null;
        const sizeIncreased = prevStage !== null && stage.stats.byteCount > prevStage.stats.byteCount;

        return (
          <div key={stage.name} style={{ display: 'flex', alignItems: 'center', gap: spacing.sm }}>
            {i > 0 && (
              <span
                style={{
                  color: colors.textTertiary,
                  fontSize: fontSizes.md,
                  lineHeight: 1,
                }}
              >
                {'\u2192'}
              </span>
            )}
            <div
              style={{
                background: colors.surfaceInput,
                border: `1px solid ${colors.borderSubtle}`,
                borderRadius: radii.sm,
                padding: `${spacing.xs}px ${spacing.sm + 2}px`,
                whiteSpace: 'nowrap',
              }}
            >
              <div
                style={{
                  fontSize: fontSizes.md,
                  color: colors.textPrimary,
                  marginBottom: 2,
                }}
              >
                {stage.name}
              </div>
              <div
                style={{
                  fontSize: fontSizes.xs,
                  color: colors.textSecondary,
                  display: 'flex',
                  gap: spacing.sm,
                }}
              >
                <span style={{ color: sizeIncreased ? colors.warning : undefined }}>
                  {formatByteCount(stage.stats.byteCount)}
                </span>
                <span>{formatEntropy(stage.stats.entropy)}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
