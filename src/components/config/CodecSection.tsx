import type { Variable } from '../../types/state.ts';
import type { CodecStep } from '../../types/codecs.ts';
import type { DtypeKey } from '../../types/dtypes.ts';
import { DTYPE_REGISTRY } from '../../types/dtypes.ts';
import type { CodecStepStats } from '../../engine/codecs.ts';
import { foldUniformDtype } from '../../engine/codecs.ts';
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
 *  CodecPipelineEditor) — column-mode only; row mode has no per-variable
 *  editors. */
function VariableCodecEditor({
  variable,
  steps,
  stepStats,
  runtimeStatus,
  onChange,
}: {
  variable: Variable;
  steps: CodecStep[];
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

  // Row mode: field pipelines don't run — variables are cast to their
  // storage dtype and interleaved per element, and the interleaved stream
  // gets exactly one shared codec pipeline. Column-mode field pipelines are
  // preserved in state and reactivate on switching back (SET_INTERLEAVING
  // touches no pipeline state).
  const rawDtypes = variables.map((v) => v.typeAssignment.storageDtype);
  const mixedDtypes = new Set(rawDtypes).size > 1;
  const inputDtype: DtypeKey = foldUniformDtype(rawDtypes);

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
        Row mode: variables are interleaved per element, then one shared codec
        pipeline applies to the combined stream. Per-variable pipelines apply
        in column mode only — yours are kept and restored on switching back.
      </div>
      {mixedDtypes && (
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
          The interleaved stream mixes dtypes — codecs like Byte Shuffle and
          Delta that assume uniform element size will produce garbled output.
        </div>
      )}
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
