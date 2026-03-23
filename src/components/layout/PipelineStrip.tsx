import { colors, fontSizes, spacing, radii } from '../../theme.ts';
import type { PipelineStage, ReadFileResult, VariableStats } from '../../types/pipeline.ts';

function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatEntropy(entropy: number): string {
  return `${entropy.toFixed(2)} b/B`;
}

interface PipelineStripProps {
  stages: PipelineStage[];
  readResult: ReadFileResult;
  variableStats: Map<string, VariableStats>;
}

export function PipelineStrip({ stages, readResult, variableStats }: PipelineStripProps) {
  // Check if any variable has lossy type assignment
  const hasLossyTyping = Array.from(variableStats.values()).some((s) => s.isLossy);

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
        const isTypedStage = stage.name === 'Typed';

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
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                {stage.name}
                {stage.name === 'Read' && (
                  <span style={{
                    color: readResult.success ? '#98c379' : '#e06c75',
                    fontWeight: 700,
                    fontSize: fontSizes.md,
                  }}>
                    {readResult.success ? '\u2713' : '\u2717'}
                  </span>
                )}
                {isTypedStage && hasLossyTyping && (
                  <span
                    style={{
                      color: colors.warning,
                      fontWeight: 700,
                      fontSize: fontSizes.sm,
                    }}
                    title="Some variables lose precision during type assignment"
                  >
                    !
                  </span>
                )}
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
