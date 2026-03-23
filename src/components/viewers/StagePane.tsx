import { colors, fontSizes, spacing } from '../../theme.ts';
import { Radio } from '../shared/Radio.tsx';
import type { PipelineStage } from '../../types/pipeline.ts';
import type { VirtualFile } from '../../types/pipeline.ts';
import type { Variable } from '../../types/state.ts';
import { HexView } from './HexView.tsx';
import { FlatView } from './FlatView.tsx';
import { TableView } from './TableView.tsx';
import { GridView } from './GridView.tsx';
import { WriteView } from './WriteView.tsx';

const VALUES_VIEW_MODES = [
  { value: 'table', label: 'Table' },
  { value: 'grid', label: 'Grid' },
  { value: 'flat', label: 'Flat' },
];

const DEFAULT_VIEW_MODES = [
  { value: 'hex', label: 'Hex' },
];

const WRITE_VIEW_MODES = [
  { value: 'hex', label: 'Hex' },
];

interface StagePaneProps {
  paneId: 'left' | 'right';
  stages: PipelineStage[];
  selectedStage: number;
  viewMode: string;
  onStageChange: (stage: number) => void;
  onViewChange: (view: string) => void;
  accentColor: string;
  variables: Variable[];
  shape: number[];
  files?: VirtualFile[];
  chunkTraceMap: Map<string, Set<string>>;
  traceChunkMap: Map<string, string>;
}

export function StagePane({
  paneId,
  stages,
  selectedStage,
  viewMode,
  onStageChange,
  onViewChange,
  accentColor,
  variables,
  shape,
  files,
  chunkTraceMap,
  traceChunkMap,
}: StagePaneProps) {
  // Resolve -1 to last stage
  const resolvedIndex = selectedStage < 0 ? stages.length - 1 : selectedStage;
  const stage = stages[resolvedIndex];
  const isValuesStage = resolvedIndex === 0;
  const isWriteStage = resolvedIndex === stages.length - 1;
  const viewModes = isValuesStage ? VALUES_VIEW_MODES : isWriteStage ? WRITE_VIEW_MODES : DEFAULT_VIEW_MODES;

  // Auto-fallback: if current view mode isn't available for this stage, use first available
  const effectiveView = viewModes.some((m) => m.value === viewMode)
    ? viewMode
    : viewModes[0].value;

  function renderViewer() {
    if (!stage) {
      return (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: colors.textTertiary,
            fontSize: fontSizes.md,
          }}
        >
          No stage selected
        </div>
      );
    }

    switch (effectiveView) {
      case 'hex':
        if (isWriteStage && files && files.length >= 1) {
          return <WriteView files={files} paneId={paneId} chunkTraceMap={chunkTraceMap} traceChunkMap={traceChunkMap} />;
        }
        return <HexView stage={stage} paneId={paneId} chunkTraceMap={chunkTraceMap} traceChunkMap={traceChunkMap} />;
      case 'flat':
        return <FlatView stage={stage} paneId={paneId} chunkTraceMap={chunkTraceMap} traceChunkMap={traceChunkMap} />;
      case 'table':
        return <TableView stage={stage} variables={variables} shape={shape} paneId={paneId} chunkTraceMap={chunkTraceMap} traceChunkMap={traceChunkMap} />;
      case 'grid':
        return <GridView stage={stage} variables={variables} shape={shape} paneId={paneId} chunkTraceMap={chunkTraceMap} traceChunkMap={traceChunkMap} />;
      default:
        return <HexView stage={stage} paneId={paneId} chunkTraceMap={chunkTraceMap} traceChunkMap={traceChunkMap} />;
    }
  }

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

      {/* Content area */}
      <div
        style={{
          flex: 1,
          overflow: 'hidden',
        }}
      >
        {renderViewer()}
      </div>
    </div>
  );
}
