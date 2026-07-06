import type { Variable, LogicalTypeConfig, LogicalType, WordSetKey } from '../../types/state.ts';
import { wordSetMaxLength } from '../../engine/generate.ts';
import { colors, fontSizes, radii, spacing } from '../../theme.ts';
import { inputStyle } from '../shared/controlStyles.ts';
import { NumberInput } from '../shared/NumberInput.tsx';

interface SchemaEditorProps {
  variables: Variable[];
  shape: number[];
  dataModel: 'tabular' | 'array';
  onAddVariable: () => void;
  onRemoveVariable: (id: string) => void;
  onUpdateVariable: (id: string, changes: Partial<Pick<Variable, 'name' | 'logicalType' | 'typeAssignment'>>) => void;
  onShapeChange: (shape: number[]) => void;
}

const LOGICAL_TYPES: { value: LogicalType; label: string }[] = [
  { value: 'integer', label: 'Integer' },
  { value: 'decimal', label: 'Decimal' },
  { value: 'continuous', label: 'Continuous' },
  { value: 'text', label: 'Text' },
];

const WORD_SETS_UI: { value: WordSetKey; label: string }[] = [
  { value: 'names', label: 'Names' },
  { value: 'cities', label: 'Cities' },
  { value: 'countries', label: 'Countries' },
  { value: 'stations', label: 'Station IDs' },
];

// D9 (remediation-plan.md, Phase 6.1): one-line descriptions shown next to
// the generation-mode select and as its tooltip.
const GENERATION_DESCRIPTIONS: Record<LogicalTypeConfig['generation'], string> = {
  smooth: 'smooth — like temperature over time',
  sorted: 'sorted — like timestamps or IDs',
  stepped: 'stepped — constant regions, occasional jumps',
  random: 'random — noise; watch compression fail',
};

const GENERATION_MODES: { value: LogicalTypeConfig['generation']; label: string }[] = [
  { value: 'random', label: 'Random' },
  { value: 'smooth', label: 'Smooth' },
  { value: 'sorted', label: 'Sorted' },
  { value: 'stepped', label: 'Stepped' },
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
            <NumberInput
              min={1}
              value={shape[0]}
              onValue={(n) => onShapeChange([Math.max(1, Math.trunc(n))])}
              data-testid="shape-input"
              style={{ ...inputStyle(), width: 60 }}
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
                <NumberInput
                  min={1}
                  value={dim}
                  onValue={(n) => {
                    const newShape = [...shape];
                    newShape[d] = Math.max(1, Math.trunc(n));
                    onShapeChange(newShape);
                  }}
                  data-testid={`shape-input-${d}`}
                  style={{ ...inputStyle(), width: 60 }}
                />
              </div>
            ))}
            <div style={{ display: 'flex', gap: spacing.xs }}>
              <button
                onClick={() => onShapeChange([...shape, 4])}
                style={{
                  ...inputStyle(fontSizes.xs),
                  cursor: 'pointer',
                  color: colors.accent,
                  background: 'transparent',
                }}
              >
                + Dim
              </button>
              {shape.length > 1 && (
                <button
                  onClick={() => onShapeChange(shape.slice(0, -1))}
                  style={{
                    ...inputStyle(fontSizes.xs),
                    cursor: 'pointer',
                    color: colors.textSecondary,
                    background: 'transparent',
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
            color: colors.warning,
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
          {variables.map((v, varIdx) => {
            const hasWarning = !v.name || duplicateNames.has(v.name);
            // For text, 'smooth' means drifting through the sorted word set
            // rather than a numeric random walk.
            const genDesc = v.logicalType.type === 'text' && v.logicalType.generation === 'smooth'
              ? 'smooth — drifts between alphabetical neighbors'
              : GENERATION_DESCRIPTIONS[v.logicalType.generation];
            return (
              <div
                key={v.id}
                data-testid={`variable-row-${varIdx}`}
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
                    data-testid={`variable-name-${varIdx}`}
                    style={{
                      ...inputStyle(),
                      flex: 1,
                      minWidth: 0,
                      borderColor: hasWarning ? colors.warning : colors.border,
                    }}
                  />
                  <button
                    onClick={() => onRemoveVariable(v.id)}
                    aria-label={v.name ? `Remove variable ${v.name}` : 'Remove variable'}
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
                      const wasText = v.logicalType.type === 'text';
                      const isText = newType === 'text';
                      const base: LogicalTypeConfig = {
                        type: newType,
                        min: isText ? 0 : v.logicalType.min,
                        max: isText ? 0 : v.logicalType.max,
                        generation: v.logicalType.generation,
                      };
                      if (newType === 'decimal') base.decimalPlaces = 1;
                      if (newType === 'continuous') base.significantFigures = 6;
                      if (isText) base.wordSet = v.logicalType.wordSet ?? 'names';
                      // Swap storageDtype in the same update: text needs char
                      // storage, numeric types need a numeric dtype back.
                      if (isText && !wasText) {
                        onUpdateVariable(v.id, {
                          logicalType: base,
                          typeAssignment: { storageDtype: 'char8' },
                        });
                      } else if (!isText && wasText) {
                        onUpdateVariable(v.id, {
                          logicalType: base,
                          typeAssignment: { storageDtype: 'float32' },
                        });
                      } else {
                        onUpdateVariable(v.id, { logicalType: base });
                      }
                    }}
                    style={{ ...inputStyle(fontSizes.xs), cursor: 'pointer' }}
                  >
                    {LOGICAL_TYPES.map((lt) => (
                      <option key={lt.value} value={lt.value}>{lt.label}</option>
                    ))}
                  </select>

                  {v.logicalType.type === 'text' ? (
                    <>
                      <span style={{ fontSize: fontSizes.xs, color: colors.textTertiary }}>words</span>
                      <select
                        value={v.logicalType.wordSet ?? 'names'}
                        onChange={(e) => updateLogicalType(v, { wordSet: e.target.value as WordSetKey })}
                        data-testid={`wordset-select-${varIdx}`}
                        style={{ ...inputStyle(fontSizes.xs), cursor: 'pointer' }}
                      >
                        {WORD_SETS_UI.map((ws) => (
                          <option key={ws.value} value={ws.value}>{ws.label}</option>
                        ))}
                      </select>
                      <span style={{ fontSize: fontSizes.xs, color: colors.textTertiary }}>
                        longest word: {wordSetMaxLength(v.logicalType.wordSet ?? 'names')} chars
                      </span>
                    </>
                  ) : (
                    <>
                      <span style={{ fontSize: fontSizes.xs, color: colors.textTertiary }}>min</span>
                      <NumberInput
                        value={v.logicalType.min}
                        onValue={(n) => updateLogicalType(v, { min: n })}
                        style={{ ...inputStyle(fontSizes.xs), width: 55 }}
                      />
                      <span style={{ fontSize: fontSizes.xs, color: colors.textTertiary }}>max</span>
                      <NumberInput
                        value={v.logicalType.max}
                        onValue={(n) => updateLogicalType(v, { max: n })}
                        style={{ ...inputStyle(fontSizes.xs), width: 55 }}
                      />
                    </>
                  )}

                  {v.logicalType.type === 'decimal' && (
                    <>
                      <span style={{ fontSize: fontSizes.xs, color: colors.textTertiary }}>places</span>
                      <NumberInput
                        min={0}
                        max={10}
                        value={v.logicalType.decimalPlaces ?? 1}
                        onValue={(n) => updateLogicalType(v, { decimalPlaces: Math.max(0, Math.trunc(n)) })}
                        style={{ ...inputStyle(fontSizes.xs), width: 40 }}
                      />
                    </>
                  )}

                  {v.logicalType.type === 'continuous' && (
                    <>
                      <span style={{ fontSize: fontSizes.xs, color: colors.textTertiary }}>sig figs</span>
                      <NumberInput
                        min={1}
                        max={15}
                        value={v.logicalType.significantFigures ?? 6}
                        onValue={(n) => updateLogicalType(v, { significantFigures: Math.max(1, Math.trunc(n)) })}
                        style={{ ...inputStyle(fontSizes.xs), width: 40 }}
                      />
                    </>
                  )}
                </div>

                {/* Generation mode row (D9) */}
                <div style={{ display: 'flex', alignItems: 'center', gap: spacing.xs }}>
                  <span style={{ fontSize: fontSizes.xs, color: colors.textTertiary }}>gen</span>
                  <select
                    value={v.logicalType.generation}
                    onChange={(e) =>
                      updateLogicalType(v, { generation: e.target.value as LogicalTypeConfig['generation'] })
                    }
                    data-testid={`generation-mode-${varIdx}`}
                    title={genDesc}
                    style={{ ...inputStyle(fontSizes.xs), cursor: 'pointer' }}
                  >
                    {GENERATION_MODES.map((gm) => (
                      <option key={gm.value} value={gm.value}>{gm.label}</option>
                    ))}
                  </select>
                  <span
                    style={{
                      fontSize: fontSizes.xs,
                      color: colors.textTertiary,
                      fontStyle: 'italic',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      flex: 1,
                      minWidth: 0,
                    }}
                  >
                    {genDesc}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add variable button */}
      <button
        onClick={onAddVariable}
        data-testid="add-variable"
        style={{
          ...inputStyle(fontSizes.xs),
          cursor: 'pointer',
          color: colors.accent,
          background: 'transparent',
          textAlign: 'center',
        }}
      >
        + Variable
      </button>
    </div>
  );
}
