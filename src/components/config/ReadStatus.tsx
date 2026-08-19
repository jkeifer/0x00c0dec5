import type { ReadFileResult } from '../../types/pipeline.ts';
import { colors, fontSizes, spacing } from '../../theme.ts';

interface ReadStatusProps {
  readResult: ReadFileResult;
}

/** Progress line above the status message: "N/8 steps" on success, or
 * "N/8 steps · failed at: {label}" on failure, N = steps with outcome 'ok'.
 * `readResult.steps` is always the full 8-entry `READ_STEP_ORDER` log
 * (src/engine/read.ts), success or failure, so total is just its length. */
function stepsProgressText(readResult: ReadFileResult): string {
  const total = readResult.steps.length;
  const okCount = readResult.steps.filter((s) => s.outcome === 'ok').length;
  if (readResult.success) return `${okCount}/${total} steps`;
  const failedStep = readResult.steps.find((s) => s.outcome === 'failed');
  return `${okCount}/${total} steps · failed at: ${failedStep?.label}`;
}

export function ReadStatus({ readResult }: ReadStatusProps) {
  if (!readResult.success) {
    return (
      <div data-testid="read-status" style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm }}>
        <div data-testid="read-status-progress" style={{ fontSize: fontSizes.xs, color: colors.textSecondary }}>
          {stepsProgressText(readResult)}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: spacing.xs }}>
          <span style={{ color: colors.error, fontSize: fontSizes.md, fontWeight: 700 }}>&#x2717;</span>
          <span style={{ color: colors.error, fontSize: fontSizes.sm, fontWeight: 600 }}>Read failed</span>
        </div>
        <div
          style={{
            fontSize: fontSizes.xs,
            color: colors.textSecondary,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
          }}
        >
          {readResult.message}
        </div>
      </div>
    );
  }

  const varCount = readResult.reconstructedValues.size;
  let totalValues = 0;
  for (const vals of readResult.reconstructedValues.values()) {
    totalValues += vals.length;
  }
  const lossyCount = readResult.lossyVariables.size;

  return (
    <div data-testid="read-status" style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm }}>
      <div data-testid="read-status-progress" style={{ fontSize: fontSizes.xs, color: colors.textSecondary }}>
        {stepsProgressText(readResult)}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: spacing.xs }}>
        <span style={{ color: colors.success, fontSize: fontSizes.md, fontWeight: 700 }}>&#x2713;</span>
        <span style={{ color: colors.success, fontSize: fontSizes.sm, fontWeight: 600 }}>
          File parsed successfully
        </span>
      </div>

      <div style={{ fontSize: fontSizes.xs, color: colors.textSecondary, lineHeight: 1.6 }}>
        <div>{varCount} variable{varCount !== 1 ? 's' : ''} recovered</div>
        <div>{totalValues.toLocaleString()} total values</div>
        {lossyCount > 0 && (
          <div style={{ color: colors.warning }}>
            {lossyCount} lossy variable{lossyCount !== 1 ? 's' : ''} (precision lost or text truncated during type assignment):{' '}
            {[...readResult.lossyVariables].join(', ')}
          </div>
        )}
      </div>
    </div>
  );
}
