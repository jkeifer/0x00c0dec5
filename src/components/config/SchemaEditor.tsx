import { useEffect, useRef, useState } from 'react';
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
  onUpdateVariable: (id: string, changes: Partial<Pick<Variable, 'name' | 'logicalType' | 'typeAssignment' | 'color'>>) => void;
  onShapeChange: (shape: number[]) => void;
  dataset: { id: string; attribution: string } | null;
  datasetOptions: { id: string; label: string }[];
  datasetStatus: { loading: boolean; error: string | null };
  onSelectDataset: (id: string | 'custom') => void;
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

/** Soft cap on total values (shape product x variable count). Derived from
 * the Phase 1-3 exit profile — comfort data: 3M values (1024x1024 x 3 vars)
 * computes in ~2.2s with ~1GB peak heap; 8M takes ~20s — AND the open finding
 * of an unexplained pipeline stall at ~8.37M values that never settles (see
 * docs/remediation-plan.md open finding added alongside this cap change).
 * The cap sits below the stall so the advisory precedes it rather than firing
 * only after the hang zone. Advisory only — nothing blocks. */
export const SOFT_ELEMENT_CAP = 8_000_000;

export function SchemaEditor({
  variables,
  shape,
  dataModel,
  onAddVariable,
  onRemoveVariable,
  onUpdateVariable,
  onShapeChange,
  dataset,
  datasetOptions,
  datasetStatus,
  onSelectDataset,
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

  const locked = dataset !== null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm }}>
      {/* Dataset picker: real-data presets, Custom (generated) last */}
      <div style={{ display: 'flex', alignItems: 'center', gap: spacing.sm }}>
        <span style={{ fontSize: fontSizes.sm, color: colors.textSecondary, minWidth: 40 }}>Data</span>
        <select
          value={dataset?.id ?? 'custom'}
          disabled={datasetStatus.loading}
          onChange={(e) => onSelectDataset(e.target.value)}
          data-testid="dataset-select"
          style={{ ...inputStyle(fontSizes.xs), cursor: 'pointer', flex: 1, minWidth: 0 }}
        >
          {datasetOptions.map((d) => (
            <option key={d.id} value={d.id}>{d.label}</option>
          ))}
          <option value="custom">Custom (generated)</option>
        </select>
      </div>
      {datasetStatus.loading && (
        <div data-testid="dataset-loading" style={{ fontSize: fontSizes.xs, color: colors.textTertiary }}>
          loading dataset…
        </div>
      )}
      {datasetStatus.error && (
        <div
          data-testid="dataset-error"
          style={{
            background: colors.warningDim, borderLeft: `2px solid ${colors.warning}`,
            borderRadius: radii.sm, padding: spacing.xs, fontSize: fontSizes.xs, color: colors.warning,
          }}
        >
          {datasetStatus.error}
        </div>
      )}
      {dataset && (
        <div data-testid="dataset-attribution" style={{ fontSize: fontSizes.xs, color: colors.textTertiary, fontStyle: 'italic' }}>
          {dataset.attribution} · schema fixed by dataset
        </div>
      )}

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
              disabled={locked}
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
                  disabled={locked}
                  data-testid={`shape-input-${d}`}
                  style={{ ...inputStyle(), width: 60 }}
                />
              </div>
            ))}
            {!locked && (
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
            )}
          </>
        )}
      </div>

      {(() => {
        const totalElements = shape.reduce((a, b) => a * b, 1);
        const totalValues = totalElements * Math.max(variables.length, 1);
        return totalValues > SOFT_ELEMENT_CAP ? (
          <div
            data-testid="element-cap-warning"
            style={{
              background: colors.warningDim,
              borderLeft: `2px solid ${colors.warning}`,
              borderRadius: radii.sm,
              padding: spacing.xs,
              fontSize: fontSizes.xs,
              color: colors.warning,
            }}
          >
            {totalValues.toLocaleString()} values — beyond the comfortable limit; recomputes
            will be slow and memory-heavy. The app won't stop you.
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
                  <VariableColorPicker
                    color={v.color}
                    varIdx={varIdx}
                    onCommit={(color) => onUpdateVariable(v.id, { color })}
                  />
                  <input
                    type="text"
                    value={v.name}
                    placeholder="name"
                    onChange={(e) => onUpdateVariable(v.id, { name: e.target.value })}
                    disabled={locked}
                    data-testid={`variable-name-${varIdx}`}
                    style={{
                      ...inputStyle(),
                      flex: 1,
                      minWidth: 0,
                      borderColor: hasWarning ? colors.warning : colors.border,
                    }}
                  />
                  {!locked && (
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
                  )}
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
                    disabled={locked}
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
                        disabled={locked}
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
                        disabled={locked}
                        style={{ ...inputStyle(fontSizes.xs), width: 55 }}
                      />
                      <span style={{ fontSize: fontSizes.xs, color: colors.textTertiary }}>max</span>
                      <NumberInput
                        value={v.logicalType.max}
                        onValue={(n) => updateLogicalType(v, { max: n })}
                        disabled={locked}
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
                        disabled={locked}
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
                        disabled={locked}
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
                    disabled={locked}
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
        disabled={locked}
        data-testid="add-variable"
        style={{
          ...inputStyle(fontSizes.xs),
          cursor: locked ? 'default' : 'pointer',
          color: locked ? colors.textTertiary : colors.accent,
          background: 'transparent',
          textAlign: 'center',
        }}
      >
        + Variable
      </button>
    </div>
  );
}

/**
 * The per-variable color dot. Clicking it opens a popover of the 10 palette
 * swatches (the default experience); "Custom…" falls through to the native
 * OS color dialog. Every commit dispatches UPDATE_VARIABLE → a full worker
 * recompute, so commits must be discrete: swatch clicks commit once, and the
 * native input commits ONLY via the DOM `change` event (fires once, on dialog
 * close) — never React's onChange, which maps to `input` and fires
 * continuously while dragging in the dialog.
 */
export function VariableColorPicker({
  color,
  varIdx,
  onCommit,
}: {
  color: string;
  varIdx: number;
  onCommit: (color: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Native `change` (not React onChange = `input`): exactly one commit, when
  // the OS dialog is confirmed/dismissed. Cancel fires nothing — by design.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const onChange = () => {
      onCommit(input.value);
      setOpen(false);
    };
    input.addEventListener('change', onChange);
    return () => input.removeEventListener('change', onChange);
  }, [onCommit]);

  function commit(c: string) {
    onCommit(c);
    setOpen(false);
  }

  return (
    <div ref={rootRef} style={{ position: 'relative', flexShrink: 0, display: 'flex' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Change color"
        aria-label="Change color"
        data-testid={`variable-color-${varIdx}`}
        style={{
          width: 12,
          height: 12,
          padding: 0,
          border: 'none',
          borderRadius: '50%',
          background: color,
          cursor: 'pointer',
        }}
      />
      {/* Hidden but always mounted so its `change` event is still delivered
          if the popover closes while the OS dialog is up. */}
      <input
        ref={inputRef}
        type="color"
        defaultValue={color}
        tabIndex={-1}
        aria-hidden="true"
        style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none', border: 'none', padding: 0 }}
      />
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 16,
            left: 0,
            zIndex: 10,
            background: colors.surface,
            border: `1px solid ${colors.border}`,
            borderRadius: radii.md,
            padding: spacing.xs,
            display: 'flex',
            flexDirection: 'column',
            gap: spacing.xs,
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.35)',
          }}
        >
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 14px)', gap: spacing.xs }}>
            {colors.palette.map((hex, i) => (
              <button
                key={hex}
                onClick={() => commit(hex)}
                title={hex}
                aria-label={`Set color ${hex}`}
                data-testid={`variable-color-swatch-${i}`}
                style={{
                  width: 14,
                  height: 14,
                  padding: 0,
                  borderRadius: '50%',
                  background: hex,
                  border: hex === color ? `1px solid ${colors.textPrimary}` : `1px solid ${colors.border}`,
                  cursor: 'pointer',
                }}
              />
            ))}
          </div>
          <button
            onClick={() => {
              const input = inputRef.current;
              if (!input) return;
              input.value = color; // start the dialog at the current color
              input.click();
            }}
            data-testid="variable-color-custom"
            style={{
              ...inputStyle(fontSizes.xs),
              cursor: 'pointer',
              color: colors.accent,
              background: 'transparent',
            }}
          >
            Custom…
          </button>
        </div>
      )}
    </div>
  );
}
