import { Radio } from '../shared/Radio.tsx';
import { colors, fontSizes, spacing } from '../../theme.ts';

interface InterleaveConfigProps {
  interleaving: 'row' | 'column';
  dataModel: 'tabular' | 'array';
  onChange: (interleaving: 'row' | 'column') => void;
}

export function InterleaveConfig({ interleaving, dataModel, onChange }: InterleaveConfigProps) {
  const columnLabel = dataModel === 'tabular' ? 'Column-oriented' : 'Band-sequential (BSQ)';
  const rowLabel = dataModel === 'tabular' ? 'Row-oriented' : 'Band-interleaved (BIP)';

  const explanation =
    interleaving === 'column'
      ? 'Each variable is stored contiguously. Enables per-variable codec pipelines.'
      : 'Variable bytes are interleaved per element. Forces a single codec pipeline.';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm }}>
      <Radio
        options={[
          { value: 'column', label: columnLabel },
          { value: 'row', label: rowLabel },
        ]}
        value={interleaving}
        onChange={(v) => onChange(v as 'row' | 'column')}
        size="sm"
      />
      <div style={{ fontSize: fontSizes.xs, color: colors.textTertiary }}>
        {explanation}
      </div>
    </div>
  );
}
