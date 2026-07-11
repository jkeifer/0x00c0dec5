import { colors, fontSizes, spacing, radii } from '../../theme.ts';
import type { PipelineStage, ReadFileResult, VariableStats } from '../../types/pipeline.ts';
import type { Variable } from '../../types/state.ts';
import type { CodecStep } from '../../types/codecs.ts';
import type { DtypeKey } from '../../types/dtypes.ts';
import { formatByteCount } from '../../engine/bytes.ts';
import { stepWarnings } from '../../engine/codecs.ts';

function formatEntropy(entropy: number): string {
  return `${entropy.toFixed(2)} b/B`;
}

interface PipelineStripProps {
  stages: PipelineStage[];
  readResult: ReadFileResult;
  variableStats: Map<string, VariableStats>;
  /**
   * Task 4.3 (UI-4): codec pipeline config, needed to compute the Encoded
   * stage's warning icon via `stepWarnings` (the same helper
   * `CodecPipelineEditor` uses for its per-step ⚠). All four are optional so
   * existing callers/tests that only care about stage stats keep working —
   * the warning icon simply doesn't render without them.
   */
  variables?: Variable[];
  fieldPipelines?: Record<string, CodecStep[]>;
  chunkPipeline?: CodecStep[];
  interleaving?: 'row' | 'column';
  /** Task 13 (perf plan): true while the worker is computing a newer state.
   *  Optional so existing callers/tests that don't care about the indicator
   *  keep working — it simply doesn't render without it. */
  computing?: boolean;
}

/**
 * Mirrors `CodecSection`'s per-mode dtype/pipeline resolution (the same rules
 * that decide which editor a variable sees) to collect every warning that
 * would show a ⚠ somewhere in the codec section, for the Encoded stage's
 * strip-level icon (design.md: "The same warning icon appears on the
 * corresponding node in the pipeline strip").
 */
function collectEncodedWarnings(
  variables: Variable[],
  fieldPipelines: Record<string, CodecStep[]>,
  chunkPipeline: CodecStep[],
  interleaving: 'row' | 'column',
): string[] {
  if (interleaving === 'column') {
    return variables.flatMap((v) =>
      stepWarnings(fieldPipelines[v.id] ?? [], v.typeAssignment.storageDtype),
    );
  }

  const dtypes = variables.map((v) => v.typeAssignment.storageDtype);
  const mixedDtypes = new Set(dtypes).size > 1;
  const inputDtype: DtypeKey = mixedDtypes
    ? 'uint8'
    : variables.length > 0
      ? variables[0].typeAssignment.storageDtype
      : 'uint8';
  return stepWarnings(chunkPipeline, inputDtype);
}

export function PipelineStrip({
  stages,
  readResult,
  variableStats,
  variables,
  fieldPipelines,
  chunkPipeline,
  interleaving,
  computing,
}: PipelineStripProps) {
  // Check if any variable has lossy type assignment
  const hasLossyTyping = Array.from(variableStats.values()).some((s) => s.isLossy);

  const codecWarnings =
    variables && fieldPipelines && chunkPipeline && interleaving
      ? collectEncodedWarnings(variables, fieldPipelines, chunkPipeline, interleaving)
      : [];

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: spacing.sm,
        padding: `${spacing.xs}px ${spacing.md}px`,
        background: colors.surface,
        borderTop: `1px solid ${colors.border}`,
        borderBottom: `1px solid ${colors.border}`,
        overflowX: 'auto',
        flexShrink: 0,
      }}
    >
      {stages.map((stage, i) => {
        const prevStage = i > 0 ? stages[i - 1] : null;
        const sizeIncreased = prevStage !== null && stage.stats.byteCount > prevStage.stats.byteCount;
        const isTypedStage = stage.name === 'Typed';
        const isEncodedStage = stage.name === 'Encoded';

        return (
          <div key={stage.name} style={{ display: 'flex', alignItems: 'center', gap: spacing.sm }}>
            {i > 0 && (
              <span
                style={{
                  color: colors.textTertiary,
                  fontSize: fontSizes.md,
                  lineHeight: 1,
                }}
              >
                {'\u2192'}
              </span>
            )}
            <div
              data-testid={`pipeline-stage-${i}`}
              style={{
                background: colors.surfaceInput,
                border: `1px solid ${colors.borderSubtle}`,
                borderRadius: radii.sm,
                padding: `${spacing.xs}px ${spacing.sm + 2}px`,
                whiteSpace: 'nowrap',
              }}
            >
              <div
                style={{
                  fontSize: fontSizes.md,
                  color: colors.textPrimary,
                  marginBottom: 2,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                {stage.name}
                {stage.name === 'Read' && (
                  <span style={{
                    color: readResult.success ? colors.success : colors.error,
                    fontWeight: 700,
                    fontSize: fontSizes.md,
                  }}>
                    {readResult.success ? '\u2713' : '\u2717'}
                  </span>
                )}
                {isTypedStage && hasLossyTyping && (
                  <span
                    style={{
                      color: colors.warning,
                      fontWeight: 700,
                      fontSize: fontSizes.sm,
                    }}
                    title="Some variables lose precision during type assignment"
                  >
                    !
                  </span>
                )}
                {isEncodedStage && codecWarnings.length > 0 && (
                  <span
                    data-testid="pipeline-stage-encoded-warning"
                    style={{
                      color: colors.warning,
                      fontWeight: 700,
                      fontSize: fontSizes.sm,
                      cursor: 'help',
                    }}
                    title={codecWarnings.join('\n')}
                  >
                    ⚠
                  </span>
                )}
              </div>
              <div
                style={{
                  fontSize: fontSizes.xs,
                  color: colors.textSecondary,
                  display: 'flex',
                  gap: spacing.sm,
                }}
              >
                <span style={{ color: sizeIncreased ? colors.warning : undefined }}>
                  {formatByteCount(stage.stats.byteCount)}
                </span>
                <span>{formatEntropy(stage.stats.entropy)}</span>
              </div>
            </div>
          </div>
        );
      })}
      {/* Task 13 (perf plan): recompute indicator. Always mounted (space
          reserved) so appearing/disappearing never shifts layout — only its
          visibility toggles. */}
      <div
        data-testid="pipeline-computing-indicator"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: spacing.xs,
          marginLeft: 'auto',
          paddingLeft: spacing.sm,
          color: colors.textSecondary,
          fontSize: fontSizes.xs,
          visibility: computing ? 'visible' : 'hidden',
          flexShrink: 0,
        }}
      >
        <span
          className="pipeline-computing-dot"
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: colors.accent,
            flexShrink: 0,
          }}
        />
        recomputing
      </div>
    </div>
  );
}
