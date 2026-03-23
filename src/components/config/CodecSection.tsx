import type { Variable } from '../../types/state.ts';
import type { CodecStep } from '../../types/codecs.ts';
import type { DtypeKey } from '../../types/dtypes.ts';
import { DTYPE_REGISTRY } from '../../types/dtypes.ts';
import { CodecPipelineEditor } from './CodecPipelineEditor.tsx';
import { colors, fontSizes, radii, spacing } from '../../theme.ts';

interface CodecSectionProps {
  interleaving: 'row' | 'column';
  variables: Variable[];
  fieldPipelines: Record<string, CodecStep[]>;
  chunkPipeline: CodecStep[];
  onFieldPipelineChange: (variableName: string, steps: CodecStep[]) => void;
  onChunkPipelineChange: (steps: CodecStep[]) => void;
}

export function CodecSection({
  interleaving,
  variables,
  fieldPipelines,
  chunkPipeline,
  onFieldPipelineChange,
  onChunkPipelineChange,
}: CodecSectionProps) {
  const mixedDtypes = new Set(variables.map((v) => v.dtype)).size > 1;

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
                {DTYPE_REGISTRY[v.dtype]?.label ?? v.dtype}
              </span>
            </div>
            <CodecPipelineEditor
              steps={fieldPipelines[v.name] ?? []}
              inputDtype={v.dtype}
              onChange={(steps) => onFieldPipelineChange(v.name, steps)}
            />
          </div>
        ))}
      </div>
    );
  }

  // Row mode
  const inputDtype: DtypeKey = mixedDtypes
    ? 'uint8'
    : variables.length > 0
      ? variables[0].dtype
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
        Row mode: a single codec pipeline is applied to all interleaved data.
      </div>
      {mixedDtypes && (
        <div style={{ fontSize: fontSizes.xs, color: colors.paneAccentRight }}>
          Mixed dtypes are interleaved — codecs like Byte Shuffle and Delta that assume uniform
          element size will produce garbled output.
        </div>
      )}
      <CodecPipelineEditor
        steps={chunkPipeline}
        inputDtype={inputDtype}
        onChange={onChunkPipelineChange}
      />
    </div>
  );
}
