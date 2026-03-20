import { colors, fonts, fontSizes, spacing } from '../../theme.ts';
import { Radio } from '../shared/Radio.tsx';
import { useAppState } from '../../state/useAppState.ts';

const MODEL_OPTIONS = [
  { value: 'tabular', label: 'Tabular' },
  { value: 'array', label: 'N-d Array' },
];

export function Header() {
  const { state, dispatch } = useAppState();

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: 40,
        padding: `0 ${spacing.md}px`,
        background: colors.surface,
        borderBottom: `1px solid ${colors.border}`,
        flexShrink: 0,
      }}
    >
      <span
        style={{
          fontFamily: fonts.mono,
          fontSize: fontSizes.lg,
          color: colors.textPrimary,
          fontWeight: 600,
          letterSpacing: '0.5px',
        }}
      >
        0x00C0DEC5
      </span>
      <Radio
        options={MODEL_OPTIONS}
        value={state.dataModel}
        onChange={(model) =>
          dispatch({ type: 'SET_DATA_MODEL', model: model as 'tabular' | 'array' })
        }
        size="sm"
      />
    </div>
  );
}
