import type { Variable } from '../../types/state.ts';
import type { CodecStep } from '../../types/codecs.ts';
import type { DtypeKey } from '../../types/dtypes.ts';
import { DTYPE_REGISTRY } from '../../types/dtypes.ts';
import type { CodecStepStats } from '../../engine/codecs.ts';
import { splitStructuredPrefix, pipelineOutputDtype } from '../../engine/codecs.ts';
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
  const dtypes = variables.map((v) => v.typeAssignment.storageDtype);
  const mixedDtypes = new Set(dtypes).size > 1;

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
          <div key={v.id} style={{ display: 'flex', flexDirection: 'column', gap: spacing.xs }}>
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
              <span style={{ fontSize: fontSizes.sm, color: colors.textPrimary }}>
                {v.name || '(unnamed)'}
              </span>
              <span style={{ fontSize: fontSizes.xs, color: colors.textTertiary }}>
                {DTYPE_REGISTRY[v.typeAssignment.storageDtype]?.label ?? v.typeAssignment.storageDtype}
              </span>
            </div>
            <CodecPipelineEditor
              steps={fieldPipelines[v.id] ?? []}
              inputDtype={v.typeAssignment.storageDtype}
              onChange={(steps) => onFieldPipelineChange(v.id, steps)}
              variableSlot={v.name}
              runtimeStatus={runtimeStatus}
              stepStats={codecStats?.[v.id]}
            />
          </div>
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
  const inputDtype: DtypeKey = mixedPostPrefixDtypes
    ? 'uint8'
    : postPrefixDtypes.length > 0
      ? postPrefixDtypes[0]
      : 'uint8';

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
      {mixedDtypes && (
        <div
          style={{
            background: colors.warningDim,
            borderLeft: `2px solid ${colors.warning}`,
            borderRadius: radii.sm,
            padding: spacing.xs,
            fontSize: fontSizes.xs,
            color: colors.textSecondary,
          }}
        >
          Mixed dtypes are interleaved — codecs like Byte Shuffle and Delta that assume uniform
          element size will produce garbled output.
        </div>
      )}
      {variables.map((v) => {
        const steps = fieldPipelines[v.id] ?? [];
        const inactiveFrom = steps.length - splitStructuredPrefix(steps).remainder.length;
        return (
          <div key={v.id} style={{ display: 'flex', flexDirection: 'column', gap: spacing.xs }}>
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
              <span style={{ fontSize: fontSizes.sm, color: colors.textPrimary }}>
                {v.name || '(unnamed)'}
              </span>
              <span style={{ fontSize: fontSizes.xs, color: colors.textTertiary }}>
                {DTYPE_REGISTRY[v.typeAssignment.storageDtype]?.label ?? v.typeAssignment.storageDtype}
              </span>
            </div>
            <CodecPipelineEditor
              steps={steps}
              inputDtype={v.typeAssignment.storageDtype}
              onChange={(newSteps) => onFieldPipelineChange(v.id, newSteps)}
              variableSlot={v.name}
              runtimeStatus={runtimeStatus}
              stepStats={codecStats?.[v.id]}
              inactiveFrom={inactiveFrom}
            />
          </div>
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
