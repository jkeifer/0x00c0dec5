import type { Variable, TypeAssignment } from '../../types/state.ts';
import type { VariableStats } from '../../types/pipeline.ts';
import type { DtypeKey } from '../../types/dtypes.ts';
import { DTYPE_KEYS, DTYPE_REGISTRY } from '../../types/dtypes.ts';
import { colors, fontSizes, radii, spacing } from '../../theme.ts';
import { inputStyle } from '../shared/controlStyles.ts';

interface TypeAssignConfigProps {
  variables: Variable[];
  variableStats: Map<string, VariableStats>;
  onUpdateVariable: (id: string, changes: Partial<Pick<Variable, 'typeAssignment'>>) => void;
}

/** Compact number for the observed-range note: integers verbatim, otherwise
 * up to 3 decimals (trailing zeros trimmed). Keeps 2469 / 176.5 readable. */
function fmtRange(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}

export function TypeAssignConfig({ variables, variableStats, onUpdateVariable }: TypeAssignConfigProps) {
  function updateAssignment(v: Variable, changes: Partial<TypeAssignment>) {
    onUpdateVariable(v.id, { typeAssignment: { ...v.typeAssignment, ...changes } });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm }}>
      {variables.map((v) => {
        const stats = variableStats.get(v.id);
        const outDtype = v.typeAssignment.storageDtype;
        // Text variables choose among char widths only; numeric variables
        // never see the char dtypes.
        const isText = v.logicalType.type === 'text';
        const dtypeOptions = DTYPE_KEYS.filter((dk) => Boolean(DTYPE_REGISTRY[dk].char) === isText);
        // Observed logical range, so the dtype/scale choice has a number to aim
        // at (e.g. "0 … 2469" → ×10 fits int16). NaN-only vars report NaN; skip.
        const rangeNote = stats && Number.isFinite(stats.min) && Number.isFinite(stats.max)
          ? `range ${fmtRange(stats.min)} … ${fmtRange(stats.max)}`
          : '';
        const lossyParts = stats
          ? [
              stats.clipped > 0 ? `${stats.clipped} clipped` : null,
              stats.rounded > 0 ? `${stats.rounded} rounded` : null,
              (stats.truncated ?? 0) > 0 ? `${stats.truncated} truncated` : null,
            ].filter(Boolean).join(', ')
          : '';

        return (
          <div
            key={v.id}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: spacing.xs,
              background: colors.surfaceInput,
              border: `1px solid ${colors.border}`,
              borderRadius: radii.sm,
              padding: spacing.xs,
            }}
          >
            {/* Variable name + storage dtype */}
            <div style={{ display: 'flex', alignItems: 'center', gap: spacing.xs }}>
              <div
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: v.color,
                  flexShrink: 0,
                }}
              />
              <span style={{ fontSize: fontSizes.sm, color: colors.textPrimary, flex: 1 }}>
                {v.name || '(unnamed)'}
              </span>
              <select
                value={outDtype}
                onChange={(e) => updateAssignment(v, { storageDtype: e.target.value as DtypeKey })}
                style={{ ...inputStyle(fontSizes.xs), cursor: 'pointer' }}
              >
                {dtypeOptions.map((dk) => (
                  <option key={dk} value={dk}>
                    {DTYPE_REGISTRY[dk].label}
                  </option>
                ))}
              </select>
            </div>

            {/* Observed range + lossy indicator */}
            {stats && (
              <div style={{ display: 'flex', alignItems: 'center', gap: spacing.xs, fontSize: fontSizes.xs, flexWrap: 'wrap' }}>
                {rangeNote && (
                  <span data-testid={`type-assign-range-${v.id}`} style={{ color: colors.textTertiary }}>
                    {rangeNote}
                  </span>
                )}
                {stats.isLossy ? (
                  <span style={{ color: colors.warning }}>{lossyParts}</span>
                ) : (
                  <span style={{ color: colors.success }}>lossless</span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
