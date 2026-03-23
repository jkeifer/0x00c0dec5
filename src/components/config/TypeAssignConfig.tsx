import type { Variable, TypeAssignment } from '../../types/state.ts';
import type { VariableStats } from '../../types/pipeline.ts';
import type { DtypeKey } from '../../types/dtypes.ts';
import { DTYPE_KEYS, DTYPE_REGISTRY, getDtype } from '../../types/dtypes.ts';
import { colors, fontSizes, radii, spacing } from '../../theme.ts';

interface TypeAssignConfigProps {
  variables: Variable[];
  variableStats: Map<string, VariableStats>;
  onUpdateVariable: (id: string, changes: Partial<Pick<Variable, 'typeAssignment'>>) => void;
}

const inputStyle: React.CSSProperties = {
  background: colors.surfaceInput,
  border: `1px solid ${colors.border}`,
  borderRadius: radii.sm,
  fontSize: fontSizes.xs,
  color: colors.textPrimary,
  padding: `${spacing.xs}px ${spacing.sm}px`,
  outline: 'none',
  fontFamily: 'inherit',
};

export function TypeAssignConfig({ variables, variableStats, onUpdateVariable }: TypeAssignConfigProps) {
  function updateAssignment(v: Variable, changes: Partial<TypeAssignment>) {
    onUpdateVariable(v.id, { typeAssignment: { ...v.typeAssignment, ...changes } });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm }}>
      {variables.map((v) => {
        const stats = variableStats.get(v.name);
        const outDtype = v.typeAssignment.storageDtype;
        const outInfo = getDtype(outDtype);
        const isIntStorage = !outInfo.float;
        const isDecimalOrContinuous = v.logicalType.type === 'decimal' || v.logicalType.type === 'continuous';
        const showScaleOffset = isIntStorage && isDecimalOrContinuous;
        const showKeepBits = outInfo.float;

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
                style={{ ...inputStyle, cursor: 'pointer' }}
              >
                {DTYPE_KEYS.map((dk) => (
                  <option key={dk} value={dk}>
                    {DTYPE_REGISTRY[dk].label}
                  </option>
                ))}
              </select>
            </div>

            {/* Scale/Offset (for integer storage of decimal/continuous) */}
            {showScaleOffset && (
              <div style={{ display: 'flex', alignItems: 'center', gap: spacing.xs, flexWrap: 'wrap' }}>
                <span style={{ fontSize: fontSizes.xs, color: colors.textTertiary }}>scale</span>
                <input
                  type="number"
                  value={v.typeAssignment.scale ?? 1}
                  step={0.1}
                  onChange={(e) => updateAssignment(v, { scale: parseFloat(e.target.value) || 1 })}
                  style={{ ...inputStyle, width: 55 }}
                />
                <span style={{ fontSize: fontSizes.xs, color: colors.textTertiary }}>offset</span>
                <input
                  type="number"
                  value={v.typeAssignment.offset ?? 0}
                  step={1}
                  onChange={(e) => updateAssignment(v, { offset: parseFloat(e.target.value) || 0 })}
                  style={{ ...inputStyle, width: 55 }}
                />
              </div>
            )}

            {/* Keep bits (for float precision reduction) */}
            {showKeepBits && (
              <div style={{ display: 'flex', alignItems: 'center', gap: spacing.xs }}>
                <span style={{ fontSize: fontSizes.xs, color: colors.textTertiary }}>keepBits</span>
                <input
                  type="number"
                  min={1}
                  max={outDtype === 'float64' ? 52 : 23}
                  value={v.typeAssignment.keepBits ?? ''}
                  placeholder="all"
                  onChange={(e) => {
                    const val = parseInt(e.target.value);
                    updateAssignment(v, { keepBits: isNaN(val) ? undefined : val });
                  }}
                  style={{ ...inputStyle, width: 55 }}
                />
              </div>
            )}

            {/* Lossy indicator */}
            {stats && (
              <div style={{ display: 'flex', alignItems: 'center', gap: spacing.xs, fontSize: fontSizes.xs }}>
                {stats.isLossy ? (
                  <span style={{ color: colors.warning }}>
                    {stats.clipped > 0 && `${stats.clipped} clipped`}
                    {stats.clipped > 0 && stats.rounded > 0 && ', '}
                    {stats.rounded > 0 && `${stats.rounded} rounded`}
                  </span>
                ) : (
                  <span style={{ color: '#98c379' }}>lossless</span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
