import type { Variable } from '../../types/state.ts';
import type { DtypeKey } from '../../types/dtypes.ts';
import { DTYPE_KEYS, DTYPE_REGISTRY } from '../../types/dtypes.ts';
import { colors, fontSizes, radii, spacing } from '../../theme.ts';

interface SchemaEditorProps {
  variables: Variable[];
  shape: number[];
  dataModel: 'tabular' | 'array';
  onAddVariable: () => void;
  onRemoveVariable: (id: string) => void;
  onUpdateVariable: (id: string, changes: Partial<Pick<Variable, 'name' | 'dtype'>>) => void;
  onShapeChange: (shape: number[]) => void;
}

const inputStyle: React.CSSProperties = {
  background: colors.surfaceInput,
  border: `1px solid ${colors.border}`,
  borderRadius: radii.sm,
  fontSize: fontSizes.sm,
  color: colors.textPrimary,
  padding: `${spacing.xs}px ${spacing.sm}px`,
  outline: 'none',
  fontFamily: 'inherit',
};

export function SchemaEditor({
  variables,
  shape,
  dataModel,
  onAddVariable,
  onRemoveVariable,
  onUpdateVariable,
  onShapeChange,
}: SchemaEditorProps) {
  const duplicateNames = new Set<string>();
  const seen = new Set<string>();
  for (const v of variables) {
    if (v.name && seen.has(v.name)) duplicateNames.add(v.name);
    seen.add(v.name);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm }}>
      {/* Shape inputs */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.xs }}>
        {dataModel === 'tabular' ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: spacing.sm }}>
            <span style={{ fontSize: fontSizes.sm, color: colors.textSecondary, minWidth: 40 }}>
              Rows
            </span>
            <input
              type="number"
              min={1}
              value={shape[0]}
              onChange={(e) => {
                const v = Math.max(1, parseInt(e.target.value) || 1);
                onShapeChange([v]);
              }}
              style={{ ...inputStyle, width: 60 }}
            />
          </div>
        ) : (
          <>
            {shape.map((dim, d) => (
              <div key={d} style={{ display: 'flex', alignItems: 'center', gap: spacing.sm }}>
                <span
                  style={{ fontSize: fontSizes.sm, color: colors.textSecondary, minWidth: 40 }}
                >
                  Dim {d}
                </span>
                <input
                  type="number"
                  min={1}
                  value={dim}
                  onChange={(e) => {
                    const v = Math.max(1, parseInt(e.target.value) || 1);
                    const newShape = [...shape];
                    newShape[d] = v;
                    onShapeChange(newShape);
                  }}
                  style={{ ...inputStyle, width: 60 }}
                />
              </div>
            ))}
            <div style={{ display: 'flex', gap: spacing.xs }}>
              <button
                onClick={() => onShapeChange([...shape, 4])}
                style={{
                  ...inputStyle,
                  cursor: 'pointer',
                  color: colors.accent,
                  background: 'transparent',
                  fontSize: fontSizes.xs,
                }}
              >
                + Dim
              </button>
              {shape.length > 1 && (
                <button
                  onClick={() => onShapeChange(shape.slice(0, -1))}
                  style={{
                    ...inputStyle,
                    cursor: 'pointer',
                    color: colors.textSecondary,
                    background: 'transparent',
                    fontSize: fontSizes.xs,
                  }}
                >
                  - Dim
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {(() => {
        const totalElements = shape.reduce((a, b) => a * b, 1);
        const totalValues = totalElements * Math.max(variables.length, 1);
        return totalValues > 10_000 ? (
          <div style={{
            fontSize: fontSizes.xs,
            color: colors.paneAccentRight,
            padding: `${spacing.xs}px 0`,
          }}>
            {totalValues.toLocaleString()} total values — large datasets may be slow
          </div>
        ) : null;
      })()}

      {/* Variable list */}
      {variables.length === 0 ? (
        <div
          style={{
            fontSize: fontSizes.sm,
            color: colors.textTertiary,
            textAlign: 'center',
            padding: `${spacing.md}px 0`,
          }}
        >
          Add a variable to get started
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.xs }}>
          {variables.map((v) => {
            const hasWarning = !v.name || duplicateNames.has(v.name);
            return (
              <div
                key={v.id}
                style={{ display: 'flex', alignItems: 'center', gap: spacing.xs }}
              >
                <div
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: v.color,
                    flexShrink: 0,
                  }}
                />
                <input
                  type="text"
                  value={v.name}
                  placeholder="name"
                  onChange={(e) => onUpdateVariable(v.id, { name: e.target.value })}
                  style={{
                    ...inputStyle,
                    flex: 1,
                    minWidth: 0,
                    borderColor: hasWarning ? colors.paneAccentRight : colors.border,
                  }}
                />
                <select
                  value={v.dtype}
                  onChange={(e) =>
                    onUpdateVariable(v.id, { dtype: e.target.value as DtypeKey })
                  }
                  style={{ ...inputStyle, cursor: 'pointer' }}
                >
                  {DTYPE_KEYS.map((dk) => (
                    <option key={dk} value={dk}>
                      {DTYPE_REGISTRY[dk].label}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => onRemoveVariable(v.id)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: colors.textTertiary,
                    cursor: 'pointer',
                    fontSize: fontSizes.sm,
                    padding: `0 ${spacing.xs}px`,
                    lineHeight: 1,
                  }}
                >
                  x
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Add variable button */}
      <button
        onClick={onAddVariable}
        style={{
          ...inputStyle,
          cursor: 'pointer',
          color: colors.accent,
          background: 'transparent',
          textAlign: 'center',
          fontSize: fontSizes.xs,
        }}
      >
        + Variable
      </button>
    </div>
  );
}
