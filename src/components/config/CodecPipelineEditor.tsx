import type { CodecStep } from '../../types/codecs.ts';
import type { DtypeKey } from '../../types/dtypes.ts';
import { CODEC_REGISTRY, outputDtypeFor, stepWarnings, type CodecStepStats } from '../../engine/codecs.ts';
import { DTYPE_REGISTRY, getDtype } from '../../types/dtypes.ts';
import { colors, fontSizes, radii, spacing } from '../../theme.ts';
import { inputStyle, clampParamValue } from '../shared/controlStyles.ts';
import { NumberInput } from '../shared/NumberInput.tsx';

interface CodecPipelineEditorProps {
  steps: CodecStep[];
  inputDtype: DtypeKey;
  onChange: (steps: CodecStep[]) => void;
  /** Identifies the pipeline owner for test ids: a variable name in column mode, or 'chunk' in row mode. */
  variableSlot?: string;
  /** Project 4 task 4: Pyodide runtime status — gates whether real (numcodecs-backed)
   *  codec entries are selectable. Defaults to 'ready' so existing callers/tests are unchanged. */
  runtimeStatus?: 'loading' | 'ready' | 'error';
  /** Task 10: per-step transform stats (clipped/rounded), aligned to `steps`
   *  by index — worker-computed, summed across chunks. Renders a lossy badge
   *  next to a step whose clipped+rounded > 0; absent/null entries render none. */
  stepStats?: (CodecStepStats | null)[];
  /** Task 11: row-mode per-variable editors pass the index of the first step
   *  that can't run per-variable (splitStructuredPrefix's remainder start).
   *  Steps at/after this index render dimmed (opacity 0.45) and the first one
   *  gets an explanatory note. Absent, or >= steps.length, renders nothing
   *  special (column mode, or an all-structured row-mode pipeline). */
  inactiveFrom?: number;
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
    // F31: a disabled step is a pass-through in the dtype flow — its output
    // dtype must not affect the next step's input (CLAUDE.md pitfall 3). We
    // still push an entry per step index so the display stays index-aligned.
    if (codec && step.enabled !== false) {
      dtype = outputDtypeFor(codec, dtype, step.params);
    }
    dtypes.push(dtype);
  }
  return dtypes;
}

const codecEntries = Object.values(CODEC_REGISTRY);

export function CodecPipelineEditor({
  steps,
  inputDtype,
  onChange,
  variableSlot = 'chunk',
  runtimeStatus = 'ready',
  stepStats,
  inactiveFrom,
}: CodecPipelineEditorProps) {
  function moveStep(index: number, direction: -1 | 1) {
    const newSteps = [...steps];
    const target = index + direction;
    [newSteps[index], newSteps[target]] = [newSteps[target], newSteps[index]];
    onChange(newSteps);
  }

  function removeStep(index: number) {
    onChange(steps.filter((_, i) => i !== index));
  }

  function toggleStep(index: number) {
    // F31: absent enabled = enabled, so the first toggle writes `false`; the
    // next writes `true` (not `undefined`) — explicit re-enable reads cleanly.
    const newSteps = steps.map((s, i) =>
      i === index ? { ...s, enabled: s.enabled === false } : s,
    );
    onChange(newSteps);
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
    // SW-7: seed any `elementSize` param from the dtype size at add time rather
    // than the codec's static default (4) — a step added after, say, an int16
    // variable should start out matching the element boundary instead of
    // immediately showing a mismatch warning. Byte Shuffle and Delta both have
    // one and it means the same thing in both: where elements begin.
    //
    // Seed from the running dtype at this point in the pipeline, not the
    // variable's own: an earlier entropy codec or shuffle makes the stream
    // uint8, and uint8 is one byte — which is the right element size for bytes
    // that no longer have elements in them. That falls out of `outputDtypeFor`
    // now that it degrades on `traceMode`; it needed a separate traceMode check
    // back when a shuffle still claimed to emit its pre-shuffle dtype.
    if ('elementSize' in codec.params) {
      // Computed here rather than read off the component-level `runningDtypes`:
      // that const lives past the empty-pipeline early return, so the first
      // codec you ever add would hit its temporal dead zone.
      const running = computeRunningDtypes(steps, inputDtype)[steps.length];
      defaultParams.elementSize = getDtype(running).size;
    }
    // Same idea for `sourceDtype` (Scale/Offset's decode-side dtype, CLAUDE.md
    // pitfall 3): seed it from the running dtype at add time rather than the
    // codec's static default, so it starts out matching what's actually
    // flowing into this step instead of immediately being wrong.
    if ('sourceDtype' in codec.params) {
      const running = computeRunningDtypes(steps, inputDtype)[steps.length];
      defaultParams.sourceDtype = running;
    }
    onChange([...steps, { codec: codecKey, params: defaultParams }]);
  }

  if (steps.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm }}>
        <div style={{ fontSize: fontSizes.xs, color: colors.textTertiary }}>
          No codecs applied — data passes through unchanged
        </div>
        <AddCodecSelect onAdd={addCodec} runtimeStatus={runtimeStatus} variableSlot={variableSlot} />
      </div>
    );
  }

  const runningDtypes = computeRunningDtypes(steps, inputDtype);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.xs }}>
      {steps.map((step, i) => {
        const codec = CODEC_REGISTRY[step.codec];
        if (!codec) return null;

        const enabled = step.enabled !== false;
        const prevDtype = runningDtypes[i];
        const currentDtype = runningDtypes[i + 1];
        // Task 4.3 (UI-4, SW-7): `stepWarnings` is the single source of truth
        // shared with `PipelineStrip` — it covers both dtype-level
        // applicability (codec.applicableTo) and Byte Shuffle's
        // param-vs-dtype elementSize mismatch, which `applicableTo` alone
        // can't express (it never sees step params).
        const warnings = stepWarnings([step], prevDtype);
        const applicable = warnings.length === 0;
        const inactive = inactiveFrom !== undefined && i >= inactiveFrom;

        return (
          <div key={i}>
          <div
            data-testid={`codec-step-${variableSlot}-${i}`}
            style={{
              background: colors.surfaceInput,
              border: `1px solid ${colors.border}`,
              borderRadius: radii.sm,
              padding: spacing.xs,
              display: 'flex',
              flexDirection: 'column',
              gap: spacing.xs,
              opacity: enabled && !inactive ? 1 : 0.45,
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
                →{DTYPE_REGISTRY[currentDtype]?.label ?? currentDtype}
              </span>
              {stepStats?.[i] && (stepStats[i]!.clipped > 0 || stepStats[i]!.rounded > 0) && (
                <span
                  data-testid={`codec-lossy-${variableSlot}-${i}`}
                  style={{ color: colors.warning, fontSize: 11 }}
                >
                  lossy: {stepStats[i]!.clipped} clipped, {stepStats[i]!.rounded} rounded
                </span>
              )}
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
              <button
                onClick={() => toggleStep(i)}
                data-testid={`codec-enabled-${variableSlot}-${i}`}
                aria-label={`${enabled ? 'Disable' : 'Enable'} ${codec.label}`}
                aria-pressed={enabled}
                title={enabled ? 'Disable this step (kept, but skipped)' : 'Enable this step'}
                style={{ ...btnStyle, color: enabled ? colors.accent : colors.textTertiary }}
              >
                {enabled ? '⏻' : '○'}
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
          {inactive && i === inactiveFrom && (
            <div
              data-testid={`codec-row-inactive-note-${variableSlot}`}
              style={{
                fontSize: fontSizes.xs,
                color: colors.textTertiary,
                fontStyle: 'italic',
                padding: `0 ${spacing.xs}px`,
              }}
            >
              inactive in row mode — output past this step has no per-element structure to
              interleave
            </div>
          )}
          </div>
        );
      })}
      <AddCodecSelect onAdd={addCodec} runtimeStatus={runtimeStatus} variableSlot={variableSlot} />
    </div>
  );
}

function AddCodecSelect({
  onAdd,
  runtimeStatus,
  variableSlot,
}: {
  onAdd: (key: string) => void;
  runtimeStatus: 'loading' | 'ready' | 'error';
  variableSlot: string;
}) {
  const pyodideDisabled = runtimeStatus !== 'ready';
  const pyodideSuffix =
    runtimeStatus === 'loading' ? ' (loading…)' : runtimeStatus === 'error' ? ' (unavailable)' : '';
  return (
    <select
      value=""
      data-testid={`codec-add-${variableSlot}`}
      onChange={(e) => {
        if (e.target.value) onAdd(e.target.value);
      }}
      style={{ ...inputStyle(), cursor: 'pointer', color: colors.accent }}
    >
      <option value="">+ Add codec</option>
      {codecEntries.map((c) => (
        <option key={c.key} value={c.key} disabled={c.runtime === 'pyodide' && pyodideDisabled}>
          {c.label}
          {c.runtime === 'pyodide' ? pyodideSuffix : ''}
        </option>
      ))}
    </select>
  );
}
