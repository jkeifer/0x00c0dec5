import type { CodecStep } from '../../types/codecs.ts';
import type { DtypeKey } from '../../types/dtypes.ts';
import { CODEC_REGISTRY, outputDtypeFor, stepWarnings } from '../../engine/codecs.ts';
import { DTYPE_REGISTRY, getDtype } from '../../types/dtypes.ts';
import { colors, fontSizes, radii, spacing } from '../../theme.ts';
import { inputStyle } from '../shared/controlStyles.ts';
import { NumberInput } from '../shared/NumberInput.tsx';

interface CodecPipelineEditorProps {
  steps: CodecStep[];
  inputDtype: DtypeKey;
  onChange: (steps: CodecStep[]) => void;
  /** Identifies the pipeline owner for test ids: a variable name in column mode, or 'chunk' in row mode. */
  variableSlot?: string;
}

const btnStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: colors.textTertiary,
  cursor: 'pointer',
  fontSize: fontSizes.xs,
  padding: `0 ${spacing.xs}px`,
  lineHeight: 1,
};

/**
 * UI-15: dtype flow derived from the registry via `outputDtypeFor`, instead
 * of a local re-implementation of "entropy codecs collapse to uint8, other
 * codecs preserve dtype" that would go silently stale the day a
 * dtype-changing codec is added. `runningDtypes[i]` is the *input* dtype
 * `steps[i]` receives; one past the end is the pipeline's overall output.
 */
function computeRunningDtypes(steps: CodecStep[], inputDtype: DtypeKey): DtypeKey[] {
  const dtypes: DtypeKey[] = [inputDtype];
  let dtype = inputDtype;
  for (const step of steps) {
    const codec = CODEC_REGISTRY[step.codec];
    if (codec) {
      dtype = outputDtypeFor(codec, dtype);
    }
    dtypes.push(dtype);
  }
  return dtypes;
}

/**
 * UI-15: number param inputs used `parseFloat(v) || 0`, so clearing the
 * field (or typing something non-numeric mid-edit) set the param to 0 even
 * when the param's `min` is 1 (e.g. delta's `order`) — an out-of-range value
 * silently reached the pipeline. Clamp into [min, max] instead, falling back
 * to `min` (if set) or the param's own default when the input doesn't parse.
 */
function clampParamValue(raw: string, min: number | undefined, max: number | undefined, fallback: number): number {
  const parsed = parseFloat(raw);
  let value = Number.isNaN(parsed) ? fallback : parsed;
  if (min !== undefined && value < min) value = min;
  if (max !== undefined && value > max) value = max;
  return value;
}

const codecEntries = Object.values(CODEC_REGISTRY);
const categories: Array<{ label: string; key: string }> = [
  { label: 'Reordering', key: 'reordering' },
  { label: 'Entropy', key: 'entropy' },
];

export function CodecPipelineEditor({ steps, inputDtype, onChange, variableSlot = 'chunk' }: CodecPipelineEditorProps) {
  function moveStep(index: number, direction: -1 | 1) {
    const newSteps = [...steps];
    const target = index + direction;
    [newSteps[index], newSteps[target]] = [newSteps[target], newSteps[index]];
    onChange(newSteps);
  }

  function removeStep(index: number) {
    onChange(steps.filter((_, i) => i !== index));
  }

  function updateParam(index: number, paramKey: string, value: number | string) {
    const newSteps = steps.map((s, i) => {
      if (i !== index) return s;
      return { ...s, params: { ...s.params, [paramKey]: value } };
    });
    onChange(newSteps);
  }

  function addCodec(codecKey: string) {
    const codec = CODEC_REGISTRY[codecKey];
    if (!codec) return;
    const defaultParams: Record<string, number | string> = {};
    for (const [k, def] of Object.entries(codec.params)) {
      defaultParams[k] = def.default;
    }
    // SW-7: auto-default Byte Shuffle's elementSize to the *input* dtype's
    // size at add time, rather than the codec's static default (4) — a step
    // added after, say, an int16 variable should start out matching the
    // element boundary instead of immediately showing a mismatch warning.
    if (codecKey === 'byte-shuffle') {
      defaultParams.elementSize = getDtype(inputDtype).size;
    }
    onChange([...steps, { codec: codecKey, params: defaultParams }]);
  }

  if (steps.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm }}>
        <div style={{ fontSize: fontSizes.xs, color: colors.textTertiary }}>
          No codecs applied — data passes through unchanged
        </div>
        <AddCodecSelect onAdd={addCodec} />
      </div>
    );
  }

  const runningDtypes = computeRunningDtypes(steps, inputDtype);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.xs }}>
      {steps.map((step, i) => {
        const codec = CODEC_REGISTRY[step.codec];
        if (!codec) return null;

        const prevDtype = runningDtypes[i];
        const currentDtype = runningDtypes[i + 1];
        // Task 4.3 (UI-4, SW-7): `stepWarnings` is the single source of truth
        // shared with `PipelineStrip` — it covers both dtype-level
        // applicability (codec.applicableTo) and Byte Shuffle's
        // param-vs-dtype elementSize mismatch, which `applicableTo` alone
        // can't express (it never sees step params).
        const warnings = stepWarnings([step], prevDtype);
        const applicable = warnings.length === 0;

        return (
          <div
            key={i}
            data-testid={`codec-step-${variableSlot}-${i}`}
            style={{
              background: colors.surfaceInput,
              border: `1px solid ${colors.border}`,
              borderRadius: radii.sm,
              padding: spacing.xs,
              display: 'flex',
              flexDirection: 'column',
              gap: spacing.xs,
            }}
          >
            {/* Header row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: spacing.xs }}>
              {!applicable && (
                <span
                  title={warnings.join('\n')}
                  data-testid={`codec-warning-${variableSlot}-${i}`}
                  style={{
                    color: colors.warning,
                    fontWeight: 700,
                    fontSize: fontSizes.sm,
                    cursor: 'help',
                  }}
                >
                  ⚠
                </span>
              )}
              <span style={{ fontSize: fontSizes.sm, color: colors.textPrimary, flex: 1 }}>
                {codec.label}
              </span>
              <span style={{ fontSize: fontSizes.xs, color: colors.textTertiary }}>
                {DTYPE_REGISTRY[currentDtype]?.label ?? currentDtype}
              </span>
              <button
                onClick={() => moveStep(i, -1)}
                disabled={i === 0}
                aria-label={`Move ${codec.label} up`}
                style={{ ...btnStyle, opacity: i === 0 ? 0.3 : 1 }}
              >
                ^
              </button>
              <button
                onClick={() => moveStep(i, 1)}
                disabled={i === steps.length - 1}
                aria-label={`Move ${codec.label} down`}
                style={{ ...btnStyle, opacity: i === steps.length - 1 ? 0.3 : 1 }}
              >
                v
              </button>
              <button onClick={() => removeStep(i)} aria-label={`Remove ${codec.label}`} style={btnStyle}>
                x
              </button>
            </div>

            {/* Param controls */}
            {Object.entries(codec.params).map(([paramKey, paramDef]) => (
              <div
                key={paramKey}
                style={{ display: 'flex', alignItems: 'center', gap: spacing.xs }}
              >
                <span
                  style={{
                    fontSize: fontSizes.xs,
                    color: colors.textSecondary,
                    minWidth: 60,
                  }}
                >
                  {paramDef.label}
                </span>
                {paramDef.type === 'number' ? (
                  <NumberInput
                    min={paramDef.min}
                    max={paramDef.max}
                    step={paramDef.step}
                    value={Number(step.params[paramKey] ?? paramDef.default)}
                    onValue={(n) =>
                      updateParam(
                        i,
                        paramKey,
                        clampParamValue(String(n), paramDef.min, paramDef.max, Number(paramDef.default)),
                      )
                    }
                    style={{ ...inputStyle(), width: 70 }}
                  />
                ) : (
                  <select
                    value={String(step.params[paramKey] ?? paramDef.default)}
                    onChange={(e) => updateParam(i, paramKey, e.target.value)}
                    style={{ ...inputStyle(), cursor: 'pointer' }}
                  >
                    {paramDef.options?.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            ))}
          </div>
        );
      })}
      <AddCodecSelect onAdd={addCodec} />
    </div>
  );
}

function AddCodecSelect({ onAdd }: { onAdd: (key: string) => void }) {
  return (
    <select
      value=""
      onChange={(e) => {
        if (e.target.value) onAdd(e.target.value);
      }}
      style={{ ...inputStyle(), cursor: 'pointer', color: colors.accent }}
    >
      <option value="">+ Add codec</option>
      {categories.map((cat) => {
        const codecs = codecEntries.filter((c) => c.category === cat.key);
        if (codecs.length === 0) return null;
        return (
          <optgroup key={cat.key} label={cat.label}>
            {codecs.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </optgroup>
        );
      })}
    </select>
  );
}
