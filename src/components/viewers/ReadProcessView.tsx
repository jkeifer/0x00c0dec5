import { colors, fontSizes, radii, spacing } from '../../theme.ts';
import type { ReadStep } from '../../types/pipeline.ts';

/**
 * Read plan Task 4: renders the reader's narrated 8-step log (ReadStep[],
 * Tasks 2-3 — READ_STEP_ORDER in src/engine/read.ts) as a checklist. Used
 * both for the Read stage's 'process' view mode (success case) and in place
 * of the plain failure message when the read failed (StagePane.tsx) — the
 * same component either way, since ReadStep[] is attached to both
 * ReadSuccess and ReadFailure and only the tail differs.
 */
interface ReadProcessViewProps {
  steps: ReadStep[];
}

const OUTCOME_ICON: Record<ReadStep['outcome'], string> = {
  ok: '✓',
  failed: '✗',
  skipped: '–',
};

export function ReadProcessView({ steps }: ReadProcessViewProps) {
  return (
    <div
      data-testid="read-process-view"
      style={{
        flex: 1,
        overflow: 'auto',
        padding: spacing.md,
        display: 'flex',
        flexDirection: 'column',
        gap: spacing.xs,
      }}
    >
      <div
        style={{
          fontSize: fontSizes.md,
          fontWeight: 700,
          color: colors.textPrimary,
          marginBottom: spacing.xs,
        }}
      >
        What the reader did
      </div>
      {steps.map((step) => {
        const isSkipped = step.outcome === 'skipped';
        const iconColor =
          step.outcome === 'ok' ? colors.success : step.outcome === 'failed' ? colors.error : colors.textTertiary;
        return (
          <div
            key={step.id}
            data-testid={`read-step-${step.id}`}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: spacing.xs - 2,
              padding: spacing.xs,
              borderRadius: radii.sm,
              color: isSkipped ? colors.textTertiary : colors.textPrimary,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: spacing.sm }}>
              <span style={{ color: iconColor, fontSize: fontSizes.md, fontFamily: 'inherit' }}>
                {OUTCOME_ICON[step.outcome]}
              </span>
              <span style={{ fontSize: fontSizes.sm, fontWeight: 600 }}>{step.label}</span>
            </div>
            <div style={{ fontSize: fontSizes.xs, color: isSkipped ? colors.textTertiary : colors.textSecondary, paddingLeft: spacing.lg }}>
              <div>Needed: {step.needed}</div>
              <div>Found: {step.found}</div>
            </div>
            {/* Render detail whenever the engine attached one — failed steps
                carry the failure message, and ok steps can carry a caveat
                (decode-chunks' assume-identity "assumed raw bytes" note,
                read plan Task 3) that must be just as visible. */}
            {step.detail && (
              <div
                style={{
                  marginLeft: spacing.lg,
                  background: colors.warningDim,
                  borderLeft: `2px solid ${colors.warning}`,
                  borderRadius: radii.sm,
                  padding: spacing.xs,
                  fontSize: fontSizes.xs,
                  color: colors.textSecondary,
                }}
              >
                {step.detail}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
