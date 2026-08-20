import type { Variable } from '../../types/state.ts';
import type { CodecStep } from '../../types/codecs.ts';
import type { DtypeKey } from '../../types/dtypes.ts';
import { DTYPE_REGISTRY } from '../../types/dtypes.ts';
import type { CodecStepStats } from '../../engine/codecs.ts';
import { splitStructuredPrefix, pipelineOutputDtype, rowModeChunkInputDtype } from '../../engine/codecs.ts';
import { CodecPipelineEditor } from './CodecPipelineEditor.tsx';
import { colors, fontSizes, radii, spacing } from '../../theme.ts';

interface CodecSectionProps {
  interleaving: 'row' | 'column';
  variables: Variable[];
  fieldPipelines: Record<string, CodecStep[]>;
  chunkPipeline: CodecStep[];
  runtimeStatus?: 'loading' | 'ready' | 'error';
  /** Task 10: per-step transform stats keyed by Variable.id or 'chunk'. */
  codecStats?: Record<string, (CodecStepStats | null)[]>;
  onFieldPipelineChange: (variableId: string, steps: CodecStep[]) => void;
  onChunkPipelineChange: (steps: CodecStep[]) => void;
}

/** TN-3: the per-variable editor block (color dot, name, dtype label,
 *  CodecPipelineEditor) shared by CodecSection's column and row branches —
 *  identical apart from `inactiveFrom` (row mode's post-prefix inert steps;
 *  undefined in column mode, where the whole pipeline is always active). */
function VariableCodecEditor({
  variable,
  steps,
  inactiveFrom,
  stepStats,
  runtimeStatus,
  onChange,
}: {
  variable: Variable;
  steps: CodecStep[];
  inactiveFrom?: number;
  stepStats?: (CodecStepStats | null)[];
  runtimeStatus?: 'loading' | 'ready' | 'error';
  onChange: (steps: CodecStep[]) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.xs }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: spacing.xs }}>
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: variable.color,
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: fontSizes.sm, color: colors.textPrimary }}>
          {variable.name || '(unnamed)'}
        </span>
        <span style={{ fontSize: fontSizes.xs, color: colors.textTertiary }}>
          {DTYPE_REGISTRY[variable.typeAssignment.storageDtype]?.label ?? variable.typeAssignment.storageDtype}
        </span>
      </div>
      <CodecPipelineEditor
        steps={steps}
        inputDtype={variable.typeAssignment.storageDtype}
        onChange={onChange}
        variableSlot={variable.name}
        runtimeStatus={runtimeStatus}
        stepStats={stepStats}
        inactiveFrom={inactiveFrom}
      />
    </div>
  );
}

export function CodecSection({
  interleaving,
  variables,
  fieldPipelines,
  chunkPipeline,
  runtimeStatus,
  codecStats,
  onFieldPipelineChange,
  onChunkPipelineChange,
}: CodecSectionProps) {
  if (interleaving === 'column') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm }}>
        <div
          style={{
            background: colors.accentDim,
            borderLeft: `2px solid ${colors.accent}`,
            borderRadius: radii.sm,
            padding: spacing.xs,
            fontSize: fontSizes.xs,
            color: colors.textSecondary,
          }}
        >
          Column mode: each variable has its own codec pipeline.
        </div>
        {variables.map((v) => (
          <VariableCodecEditor
            key={v.id}
            variable={v}
            steps={fieldPipelines[v.id] ?? []}
            stepStats={codecStats?.[v.id]}
            runtimeStatus={runtimeStatus}
            onChange={(steps) => onFieldPipelineChange(v.id, steps)}
          />
        ))}
      </div>
    );
  }

  // Row mode. Each variable's own field pipeline still runs, but only its
  // maximal leading run of element-structured steps (splitStructuredPrefix) —
  // anything after that has no per-element structure left to interleave, so
  // it can't run per-variable and sits inactive until interleaving switches
  // back to column. The chunk editor picks up from there, on whatever dtype
  // each variable's prefix leaves it in.
  const postPrefixDtypes = variables.map((v) =>
    pipelineOutputDtype(
      splitStructuredPrefix(fieldPipelines[v.id] ?? []).prefix,
      v.typeAssignment.storageDtype,
    ),
  );
  const mixedPostPrefixDtypes = new Set(postPrefixDtypes).size > 1;
  const inputDtype: DtypeKey = rowModeChunkInputDtype(variables, fieldPipelines);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm }}>
      <div
        style={{
          background: colors.accentDim,
          borderLeft: `2px solid ${colors.accent}`,
          borderRadius: radii.sm,
          padding: spacing.xs,
          fontSize: fontSizes.xs,
          color: colors.textSecondary,
        }}
      >
        Row mode: each variable's structured codec steps still run per-variable; anything after
        that (and the shared chunk pipeline below) applies to all interleaved data.
      </div>
      {mixedPostPrefixDtypes && (
        <div
          data-testid="codec-mixed-dtype-warning"
          style={{
            background: colors.warningDim,
            borderLeft: `2px solid ${colors.warning}`,
            borderRadius: radii.sm,
            padding: spacing.xs,
            fontSize: fontSizes.xs,
            color: colors.textSecondary,
          }}
        >
          The interleaved stream mixes dtypes (after each variable's structured steps) — codecs
          like Byte Shuffle and Delta that assume uniform element size will produce garbled
          output.
        </div>
      )}
      {variables.map((v) => {
        const steps = fieldPipelines[v.id] ?? [];
        const inactiveFrom = steps.length - splitStructuredPrefix(steps).remainder.length;
        return (
          <VariableCodecEditor
            key={v.id}
            variable={v}
            steps={steps}
            inactiveFrom={inactiveFrom}
            stepStats={codecStats?.[v.id]}
            runtimeStatus={runtimeStatus}
            onChange={(newSteps) => onFieldPipelineChange(v.id, newSteps)}
          />
        );
      })}
      <CodecPipelineEditor
        steps={chunkPipeline}
        inputDtype={inputDtype}
        onChange={onChunkPipelineChange}
        variableSlot="chunk"
        runtimeStatus={runtimeStatus}
        stepStats={codecStats?.['chunk']}
      />
    </div>
  );
}
