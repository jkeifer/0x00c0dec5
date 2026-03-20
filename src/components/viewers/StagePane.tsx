import { colors, fontSizes, spacing } from '../../theme.ts';
import { Radio } from '../shared/Radio.tsx';
import type { PipelineStage } from '../../types/pipeline.ts';

const VALUES_VIEW_MODES = [
  { value: 'table', label: 'Table' },
  { value: 'grid', label: 'Grid' },
  { value: 'hex', label: 'Hex' },
  { value: 'flat', label: 'Flat' },
];

const DEFAULT_VIEW_MODES = [
  { value: 'hex', label: 'Hex' },
  { value: 'flat', label: 'Flat' },
];

interface StagePaneProps {
  paneId: 'left' | 'right';
  stages: PipelineStage[];
  selectedStage: number;
  viewMode: string;
  onStageChange: (stage: number) => void;
  onViewChange: (view: string) => void;
  accentColor: string;
}

function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function StagePane({
  paneId,
  stages,
  selectedStage,
  viewMode,
  onStageChange,
  onViewChange,
  accentColor,
}: StagePaneProps) {
  // Resolve -1 to last stage
  const resolvedIndex = selectedStage < 0 ? stages.length - 1 : selectedStage;
  const stage = stages[resolvedIndex];
  const isValuesStage = resolvedIndex === 0;
  const viewModes = isValuesStage ? VALUES_VIEW_MODES : DEFAULT_VIEW_MODES;

  // Auto-fallback: if current view mode isn't available for this stage, use first available
  const effectiveView = viewModes.some((m) => m.value === viewMode)
    ? viewMode
    : viewModes[0].value;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        borderTop: `2px solid ${accentColor}`,
      }}
    >
      {/* Controls bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: spacing.sm,
          padding: `${spacing.xs}px ${spacing.sm}px`,
          flexShrink: 0,
          borderBottom: `1px solid ${colors.borderSubtle}`,
        }}
      >
        <select
          value={selectedStage}
          onChange={(e) => onStageChange(Number(e.target.value))}
          style={{
            background: colors.surfaceInput,
            color: colors.textPrimary,
            border: `1px solid ${colors.border}`,
            borderRadius: 3,
            padding: `${spacing.xs - 1}px ${spacing.xs}px`,
            fontSize: fontSizes.sm,
            fontFamily: 'inherit',
            cursor: 'pointer',
            outline: 'none',
          }}
        >
          {stages.map((s, i) => (
            <option key={i} value={i}>
              {s.name}
            </option>
          ))}
          <option value={-1}>Write (final)</option>
        </select>
        <Radio
          options={viewModes}
          value={effectiveView}
          onChange={(v) => onViewChange(v)}
          size="sm"
        />
        <span
          style={{
            marginLeft: 'auto',
            fontSize: fontSizes.xs,
            color: colors.textTertiary,
          }}
        >
          {paneId}
        </span>
      </div>

      {/* Content area (placeholder) */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          gap: spacing.xs,
          color: colors.textTertiary,
          fontSize: fontSizes.md,
          overflow: 'auto',
        }}
      >
        {stage ? (
          <>
            <div>{stage.name}</div>
            <div style={{ fontSize: fontSizes.xs }}>
              {formatByteCount(stage.stats.byteCount)} &middot;{' '}
              {stage.stats.entropy.toFixed(2)} b/B
            </div>
            <div style={{ fontSize: fontSizes.xs }}>View: {effectiveView}</div>
          </>
        ) : (
          <div>No stage selected</div>
        )}
      </div>
    </div>
  );
}
