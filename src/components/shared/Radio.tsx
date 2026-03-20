import { colors, fontSizes, radii, spacing } from '../../theme.ts';

interface RadioOption {
  value: string;
  label: string;
}

interface RadioProps {
  options: RadioOption[];
  value: string;
  onChange: (value: string) => void;
  size?: 'sm' | 'md';
}

export function Radio({ options, value, onChange, size = 'md' }: RadioProps) {
  const fontSize = size === 'sm' ? fontSizes.xs : fontSizes.sm;
  const pad = size === 'sm' ? `${spacing.xs - 1}px ${spacing.sm - 2}px` : `${spacing.xs}px ${spacing.sm}px`;

  return (
    <div
      style={{
        display: 'inline-flex',
        border: `1px solid ${colors.border}`,
        borderRadius: radii.md,
        overflow: 'hidden',
      }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            style={{
              border: 'none',
              outline: 'none',
              cursor: 'pointer',
              fontSize,
              fontFamily: 'inherit',
              padding: pad,
              color: active ? colors.accent : colors.textSecondary,
              background: active ? colors.accentDim : 'transparent',
              transition: 'background 0.1s, color 0.1s',
            }}
            onMouseEnter={(e) => {
              if (!active) {
                e.currentTarget.style.background = colors.surfaceHover;
              }
            }}
            onMouseLeave={(e) => {
              if (!active) {
                e.currentTarget.style.background = 'transparent';
              }
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
