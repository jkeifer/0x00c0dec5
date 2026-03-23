import type { Variable, LogicalTypeConfig, LogicalType } from '../../types/state.ts';
import { colors, fontSizes, radii, spacing } from '../../theme.ts';

interface SchemaEditorProps {
  variables: Variable[];
  shape: number[];
  dataModel: 'tabular' | 'array';
  onAddVariable: () => void;
  onRemoveVariable: (id: string) => void;
  onUpdateVariable: (id: string, changes: Partial<Pick<Variable, 'name' | 'logicalType' | 'typeAssignment'>>) => void;
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

const LOGICAL_TYPES: { value: LogicalType; label: string }[] = [
  { value: 'integer', label: 'Integer' },
  { value: 'decimal', label: 'Decimal' },
  { value: 'continuous', label: 'Continuous' },
];

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

  function updateLogicalType(v: Variable, changes: Partial<LogicalTypeConfig>) {
    const newType = { ...v.logicalType, ...changes };
    onUpdateVariable(v.id, { logicalType: newType });
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
                const val = Math.max(1, parseInt(e.target.value) || 1);
                onShapeChange([val]);
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
                    const val = Math.max(1, parseInt(e.target.value) || 1);
                    const newShape = [...shape];
                    newShape[d] = val;
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm }}>
          {variables.map((v) => {
            const hasWarning = !v.name || duplicateNames.has(v.name);
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
                {/* Name + delete row */}
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

                {/* Logical type + params row */}
                <div style={{ display: 'flex', alignItems: 'center', gap: spacing.xs, flexWrap: 'wrap' }}>
                  <select
                    value={v.logicalType.type}
                    onChange={(e) => {
                      const newType = e.target.value as LogicalType;
                      const base: LogicalTypeConfig = { type: newType, min: v.logicalType.min, max: v.logicalType.max };
                      if (newType === 'decimal') base.decimalPlaces = 1;
                      if (newType === 'continuous') base.significantFigures = 6;
                      onUpdateVariable(v.id, { logicalType: base });
                    }}
                    style={{ ...inputStyle, cursor: 'pointer', fontSize: fontSizes.xs }}
                  >
                    {LOGICAL_TYPES.map((lt) => (
                      <option key={lt.value} value={lt.value}>{lt.label}</option>
                    ))}
                  </select>

                  <span style={{ fontSize: fontSizes.xs, color: colors.textTertiary }}>min</span>
                  <input
                    type="number"
                    value={v.logicalType.min}
                    onChange={(e) => updateLogicalType(v, { min: parseFloat(e.target.value) || 0 })}
                    style={{ ...inputStyle, width: 55, fontSize: fontSizes.xs }}
                  />
                  <span style={{ fontSize: fontSizes.xs, color: colors.textTertiary }}>max</span>
                  <input
                    type="number"
                    value={v.logicalType.max}
                    onChange={(e) => updateLogicalType(v, { max: parseFloat(e.target.value) || 0 })}
                    style={{ ...inputStyle, width: 55, fontSize: fontSizes.xs }}
                  />

                  {v.logicalType.type === 'decimal' && (
                    <>
                      <span style={{ fontSize: fontSizes.xs, color: colors.textTertiary }}>places</span>
                      <input
                        type="number"
                        min={0}
                        max={10}
                        value={v.logicalType.decimalPlaces ?? 1}
                        onChange={(e) => updateLogicalType(v, { decimalPlaces: Math.max(0, parseInt(e.target.value) || 0) })}
                        style={{ ...inputStyle, width: 40, fontSize: fontSizes.xs }}
                      />
                    </>
                  )}

                  {v.logicalType.type === 'continuous' && (
                    <>
                      <span style={{ fontSize: fontSizes.xs, color: colors.textTertiary }}>sig figs</span>
                      <input
                        type="number"
                        min={1}
                        max={15}
                        value={v.logicalType.significantFigures ?? 6}
                        onChange={(e) => updateLogicalType(v, { significantFigures: Math.max(1, parseInt(e.target.value) || 6) })}
                        style={{ ...inputStyle, width: 40, fontSize: fontSizes.xs }}
                      />
                    </>
                  )}
                </div>
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
