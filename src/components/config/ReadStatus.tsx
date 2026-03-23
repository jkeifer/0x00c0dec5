import type { ReadFileResult } from '../../types/pipeline.ts';
import { Radio } from '../shared/Radio.tsx';
import { colors, fontSizes, spacing } from '../../theme.ts';

interface ReadStatusProps {
  readResult: ReadFileResult;
  showDiff: boolean;
  onShowDiffChange: (showDiff: boolean) => void;
}

export function ReadStatus({ readResult, showDiff, onShowDiffChange }: ReadStatusProps) {
  if (!readResult.success) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: spacing.xs }}>
          <span style={{ color: '#e06c75', fontSize: fontSizes.md, fontWeight: 700 }}>&#x2717;</span>
          <span style={{ color: '#e06c75', fontSize: fontSizes.sm, fontWeight: 600 }}>Read failed</span>
        </div>
        <div
          style={{
            fontSize: fontSizes.xs,
            color: colors.textSecondary,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
          }}
        >
          {readResult.errorMessage}
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: spacing.xs }}>
        <span style={{ color: '#98c379', fontSize: fontSizes.md, fontWeight: 700 }}>&#x2713;</span>
        <span style={{ color: '#98c379', fontSize: fontSizes.sm, fontWeight: 600 }}>
          File parsed successfully
        </span>
      </div>

      <div style={{ fontSize: fontSizes.xs, color: colors.textSecondary, lineHeight: 1.6 }}>
        <div>{varCount} variable{varCount !== 1 ? 's' : ''} recovered</div>
        <div>{totalValues.toLocaleString()} total values</div>
        {lossyCount > 0 && (
          <div style={{ color: colors.warning }}>
            {lossyCount} lossy variable{lossyCount !== 1 ? 's' : ''} (precision lost during type assignment):{' '}
            {[...readResult.lossyVariables].join(', ')}
          </div>
        )}
      </div>

      {/* Diff toggle */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.xs }}>
        <span style={{ fontSize: fontSizes.xs, color: colors.textSecondary }}>
          Show differences from original
        </span>
        <Radio
          options={[
            { value: 'yes', label: 'Yes' },
            { value: 'no', label: 'No' },
          ]}
          value={showDiff ? 'yes' : 'no'}
          onChange={(v) => onShowDiffChange(v === 'yes')}
          size="sm"
        />
      </div>
    </div>
  );
}
