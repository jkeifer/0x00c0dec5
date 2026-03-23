import type { CodecStep } from '../../types/codecs.ts';
import type { DtypeKey } from '../../types/dtypes.ts';
import { CODEC_REGISTRY } from '../../engine/codecs.ts';
import { DTYPE_REGISTRY } from '../../types/dtypes.ts';
import { colors, fontSizes, radii, spacing } from '../../theme.ts';

interface CodecPipelineEditorProps {
  steps: CodecStep[];
  inputDtype: DtypeKey;
  onChange: (steps: CodecStep[]) => void;
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

const btnStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: colors.textTertiary,
  cursor: 'pointer',
  fontSize: fontSizes.xs,
  padding: `0 ${spacing.xs}px`,
  lineHeight: 1,
};

function computeRunningDtype(steps: CodecStep[], inputDtype: DtypeKey, upTo: number): DtypeKey {
  let dtype = inputDtype;
  for (let i = 0; i <= upTo; i++) {
    const step = steps[i];
    const codec = CODEC_REGISTRY[step.codec];
    if (!codec) continue;
    if (codec.category === 'entropy') {
      dtype = 'uint8';
    }
    // Reordering codecs preserve dtype
  }
  return dtype;
}

const codecEntries = Object.values(CODEC_REGISTRY);
const categories: Array<{ label: string; key: string }> = [
  { label: 'Reordering', key: 'reordering' },
  { label: 'Entropy', key: 'entropy' },
];

export function CodecPipelineEditor({ steps, inputDtype, onChange }: CodecPipelineEditorProps) {
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
    onChange([...steps, { codec: codecKey, params: defaultParams }]);
  }

  if (steps.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm }}>
        <div style={{ fontSize: fontSizes.xs, color: colors.textTertiary }}>
          No codecs applied
        </div>
        <AddCodecSelect onAdd={addCodec} />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.xs }}>
      {steps.map((step, i) => {
        const codec = CODEC_REGISTRY[step.codec];
        if (!codec) return null;

        const prevDtype = i === 0 ? inputDtype : computeRunningDtype(steps, inputDtype, i - 1);
        const currentDtype = computeRunningDtype(steps, inputDtype, i);
        const applicable = codec.applicableTo(prevDtype);

        return (
          <div
            key={i}
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
                  title={`${codec.label} is not applicable to ${DTYPE_REGISTRY[prevDtype]?.label ?? prevDtype} input — results may be garbled or meaningless`}
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
                style={{ ...btnStyle, opacity: i === 0 ? 0.3 : 1 }}
              >
                ^
              </button>
              <button
                onClick={() => moveStep(i, 1)}
                disabled={i === steps.length - 1}
                style={{ ...btnStyle, opacity: i === steps.length - 1 ? 0.3 : 1 }}
              >
                v
              </button>
              <button onClick={() => removeStep(i)} style={btnStyle}>
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
                  <input
                    type="number"
                    min={paramDef.min}
                    max={paramDef.max}
                    step={paramDef.step}
                    value={Number(step.params[paramKey] ?? paramDef.default)}
                    onChange={(e) => updateParam(i, paramKey, parseFloat(e.target.value) || 0)}
                    style={{ ...inputStyle, width: 70 }}
                  />
                ) : (
                  <select
                    value={String(step.params[paramKey] ?? paramDef.default)}
                    onChange={(e) => updateParam(i, paramKey, e.target.value)}
                    style={{ ...inputStyle, cursor: 'pointer' }}
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
      style={{ ...inputStyle, cursor: 'pointer', color: colors.accent }}
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
