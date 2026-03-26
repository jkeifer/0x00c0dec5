import { colors, fontSizes, spacing } from '../../theme.ts';
import { Radio } from '../shared/Radio.tsx';
import type { PipelineStage, ReadFileResult } from '../../types/pipeline.ts';
import type { VirtualFile } from '../../types/pipeline.ts';
import type { Variable } from '../../types/state.ts';
import { HexView } from './HexView.tsx';
import { WriteHexView } from './WriteHexView.tsx';
import { FlatView } from './FlatView.tsx';
import { TableView } from './TableView.tsx';
import { GridView } from './GridView.tsx';

const VALUES_VIEW_MODES = [
  { value: 'table', label: 'Table' },
  { value: 'grid', label: 'Grid' },
  { value: 'flat', label: 'Flat' },
];

const TYPED_VIEW_MODES = [
  { value: 'table', label: 'Table' },
  { value: 'grid', label: 'Grid' },
  { value: 'flat', label: 'Flat' },
  { value: 'hex', label: 'Hex' },
];

const READ_VIEW_MODES = [
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
  readResult: ReadFileResult;
  showDiff: boolean;
  originalValues?: Map<string, number[]>;
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
  readResult,
  showDiff,
  originalValues,
}: StagePaneProps) {
  // Resolve -1 to last stage
  const resolvedIndex = selectedStage < 0 ? stages.length - 1 : selectedStage;
  const stage = stages[resolvedIndex];
  const isValuesStage = resolvedIndex === 0;
  const isTypedStage = resolvedIndex === 1;
  const isReadStage = stage?.name === 'Read';
  const isWriteStage = stage?.name === 'Write';
  const viewModes = isValuesStage
    ? VALUES_VIEW_MODES
    : isTypedStage
      ? TYPED_VIEW_MODES
      : isReadStage
        ? READ_VIEW_MODES
        : isWriteStage
          ? WRITE_VIEW_MODES
          : DEFAULT_VIEW_MODES;

  // Auto-fallback: if current view mode isn't available for this stage, use first available
  const effectiveView = viewModes.some((m) => m.value === viewMode)
    ? viewMode
    : viewModes[0].value;

  // Compute diff values when viewing Read stage with diff enabled
  const diffValues = (isReadStage && showDiff && readResult.success && originalValues)
    ? originalValues
    : undefined;

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

    // Read stage: show failure message or route to value viewers
    if (isReadStage && !readResult.success) {
      return (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: spacing.xl,
            textAlign: 'center',
          }}
        >
          <div style={{ maxWidth: 400 }}>
            <div style={{ color: '#e06c75', fontSize: fontSizes.lg, fontWeight: 700, marginBottom: spacing.sm }}>
              Cannot read file
            </div>
            <div style={{ color: colors.textSecondary, fontSize: fontSizes.sm, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
              {readResult.errorMessage}
            </div>
          </div>
        </div>
      );
    }

    switch (effectiveView) {
      case 'hex':
        if (isWriteStage && files && files.length >= 1) {
          return <WriteHexView files={files} paneId={paneId} chunkTraceMap={chunkTraceMap} traceChunkMap={traceChunkMap} />;
        }
        return <HexView stage={stage} paneId={paneId} chunkTraceMap={chunkTraceMap} traceChunkMap={traceChunkMap} />;
      case 'flat':
        return <FlatView stage={stage} paneId={paneId} chunkTraceMap={chunkTraceMap} traceChunkMap={traceChunkMap} />;
      case 'table':
        return <TableView stage={stage} variables={variables} shape={shape} paneId={paneId} chunkTraceMap={chunkTraceMap} traceChunkMap={traceChunkMap} diffValues={diffValues} showDiff={!!diffValues} isLogicalValues={isValuesStage || isReadStage} />;
      case 'grid':
        return <GridView stage={stage} variables={variables} shape={shape} paneId={paneId} chunkTraceMap={chunkTraceMap} traceChunkMap={traceChunkMap} diffValues={diffValues} showDiff={!!diffValues} isLogicalValues={isValuesStage || isReadStage} />;
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
