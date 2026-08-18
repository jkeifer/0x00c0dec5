import { useMemo } from 'react';
import { colors, fontSizes, spacing, collapseButtonStyle } from '../../theme.ts';
import { Radio } from '../shared/Radio.tsx';
import type { StageName } from '../../types/pipeline.ts';
import { STAGE_ORDER } from '../../types/pipeline.ts';
import type { Variable } from '../../types/state.ts';
import type { LogicalValue } from '../../types/dtypes.ts';
import { usePipelineContext } from '../../state/PipelineContext.tsx';
import { HexView, type HexSection } from './HexView.tsx';
import { FlatView } from './FlatView.tsx';
import { TableView } from './TableView.tsx';
import { GridView } from './GridView.tsx';
import { ReadProcessView } from './ReadProcessView.tsx';
import { MetadataEntriesView } from './MetadataEntriesView.tsx';

// Task 4.4 (remediation-plan.md, Phase 4; fixes UI-6): per spec, every
// non-Values stage offers Hex AND Flat; Values/Typed/Read additionally offer
// Table/Grid (the value-shaped views). Write and Metadata etc. are Hex+Flat
// only — there is no value-shaped view of raw bytes/metadata.
const VALUES_VIEW_MODES = [
  { value: 'table', label: 'Table' },
  { value: 'grid', label: 'Grid' },
  { value: 'hex', label: 'Hex' },
  { value: 'flat', label: 'Flat' },
];

const TYPED_VIEW_MODES = [
  { value: 'table', label: 'Table' },
  { value: 'grid', label: 'Grid' },
  { value: 'hex', label: 'Hex' },
  { value: 'flat', label: 'Flat' },
];

// Task 4 (read plan): Read additionally offers 'process' — the narrated
// 8-step read log (ReadProcessView) — available only on this stage, per
// spec. No other stage has a process log to show.
const READ_VIEW_MODES = [
  { value: 'table', label: 'Table' },
  { value: 'grid', label: 'Grid' },
  { value: 'hex', label: 'Hex' },
  { value: 'flat', label: 'Flat' },
  { value: 'process', label: 'Process' },
];

const DEFAULT_VIEW_MODES = [
  { value: 'hex', label: 'Hex' },
  { value: 'flat', label: 'Flat' },
];

// Task 9 (metadata redesign): Metadata additionally offers 'entries' — the
// parsed-from-bytes key/value table — and it's the default (first = default
// via StagePane's existing view-mode fallback below).
const METADATA_VIEW_MODES = [
  { value: 'entries', label: 'Entries' },
  { value: 'hex', label: 'Hex' },
  { value: 'flat', label: 'Flat' },
];

/** Display label per stage name, in `STAGE_ORDER`'s fixed order — used to
 * populate the pane dropdown's `<option>`s. Kept alongside STAGE_ORDER's
 * definition intent: capitalized, matching each PipelineStage.name exactly
 * (see usePipeline.ts's makeStage calls). */
const STAGE_LABELS: Record<StageName, string> = {
  values: 'Values',
  typed: 'Typed',
  linearized: 'Linearized',
  encoded: 'Encoded',
  metadata: 'Metadata',
  write: 'Write',
  read: 'Read',
};

interface StagePaneProps {
  paneId: 'left' | 'right';
  selectedStage: StageName;
  viewMode: string;
  onStageChange: (stage: StageName) => void;
  onViewChange: (view: string) => void;
  accentColor: string;
  variables: Variable[];
  shape: number[];
  chunkShape: number[];
  interleaving: 'row' | 'column';
  collapsed: boolean;
  onToggleCollapse: () => void;
}


export function StagePane({
  paneId,
  selectedStage,
  viewMode,
  onStageChange,
  onViewChange,
  accentColor,
  variables,
  shape,
  chunkShape,
  interleaving,
  collapsed,
  onToggleCollapse,
}: StagePaneProps) {
  // Task 3.9 (remediation-plan.md, Phase 3): everything pipeline-derived
  // comes from PipelineContext now — paneId/selectedStage/viewMode/
  // onStageChange/onViewChange/accentColor/variables/shape/chunkShape/
  // interleaving are the only genuinely per-pane (or state-sourced,
  // non-pipeline) values left as props. chunkShape/interleaving (Task 9,
  // perf plan) feed the layout-based chunk-membership lookups
  // (chunkIdForElement/elementInChunk) that replaced chunkTraceMap/
  // traceChunkMap in every viewer.
  const {
    stages,
    files,
    readResult,
    showDiff,
    originalValues,
    logicalValues,
    typedValues,
    stageSources,
    metadataEntries,
  } = usePipelineContext();

  // Task 3.8 (D5, fixes SW-2/SW-6/SW-10): stage identity is a name; resolve
  // to an index only internally, where the stages array actually needs one.
  // STAGE_ORDER is the fixed order the pipeline always produces stages in
  // (see usePipeline.ts), so indexOf is a direct, unambiguous lookup — no
  // fallback/sentinel resolution needed the way the old -1 index required.
  const resolvedIndex = STAGE_ORDER.indexOf(selectedStage);
  const stage = stages[resolvedIndex];
  const isValuesStage = selectedStage === 'values';
  const isTypedStage = selectedStage === 'typed';
  const isReadStage = selectedStage === 'read';
  const isWriteStage = selectedStage === 'write';
  const isMetadataStage = selectedStage === 'metadata';
  // Table/Grid views only ever render Values/Typed/Read stages (see
  // viewModes below — every other stage is Hex/Flat-only), so exactly one of
  // these is relevant whenever 'table'/'grid' is reachable (D6, fixes UI-9).
  const tableGridValues = isValuesStage
    ? logicalValues
    : isTypedStage
      ? typedValues
      : isReadStage && readResult.success
        ? readResult.reconstructedValues
        : new Map<string, LogicalValue[]>();
  // Task 4.4 (fixes UI-6): all non-Values/Typed/Read stages (Linearized,
  // Encoded, Metadata, Write) get the same Hex+Flat mode set.
  const viewModes = isValuesStage
    ? VALUES_VIEW_MODES
    : isTypedStage
      ? TYPED_VIEW_MODES
      : isReadStage
        ? READ_VIEW_MODES
        : isMetadataStage
          ? METADATA_VIEW_MODES
          : DEFAULT_VIEW_MODES;

  // Auto-fallback: if current view mode isn't available for this stage, use first available
  const effectiveView = viewModes.some((m) => m.value === viewMode)
    ? viewMode
    : viewModes[0].value;

  // Compute diff values when viewing Read stage with diff enabled
  const diffValues = (isReadStage && showDiff && readResult.success && originalValues)
    ? originalValues
    : undefined;

  // Task 3.5: HexView takes `sections` uniformly. The Write stage maps its
  // (possibly multiple, per-chunk) output files to one section each, keyed by
  // file NAME (not index — UI-18: index keys made sticky headers stack across
  // re-renders where file order could shift). Every other stage is a single
  // section wrapping that stage's own bytes/traces, keyed by stage name.
  const hexSections: HexSection[] = useMemo(() => {
    if (isWriteStage && files && files.length >= 1) {
      // Per-file layouts (VirtualFile.layout, task 5) each describe their own
      // file's bytes; sources are shared (buildStageSources maps 'write' ->
      // the typed-stage source arrays, same as the combined Write stage).
      const writeSources = stageSources.get('write');
      if (!writeSources) return [];
      return files.map((f) => ({
        key: f.name,
        header: { name: f.name, size: f.bytes.length },
        bytes: f.bytes,
        layout: f.layout,
        sources: writeSources,
      }));
    }
    if (!stage) return [];
    const sources = stageSources.get(selectedStage);
    if (!sources) return [];
    return [{ key: stage.name, bytes: stage.bytes, layout: stage.layout, sources }];
  }, [isWriteStage, files, stage, stageSources, selectedStage]);

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

    // Read stage: a failed read always shows the process checklist (Task 4,
    // read plan) regardless of the selected view mode — the checklist IS the
    // failure explanation now, so there's no separate plain-message path.
    // Success + 'process' mode shows the same checklist for the successful
    // read. Neither case falls through to the value/hex/flat viewers below.
    if (isReadStage && (!readResult.success || effectiveView === 'process')) {
      return <ReadProcessView steps={readResult.steps} />;
    }

    // Metadata stage: the Entries view is a value-shaped view of the
    // assembled metadata (Task 9), not the raw bytes — same "default view
    // that isn't Hex" pattern as Table/Grid for Values/Typed/Read. `enabled`
    // is derived from the stage's own bytes: computeMetadataStage's
    // documented invariant is truly-zero-length bytes exactly when
    // `metadata.enabled` is off (never for an enabled-but-empty document —
    // the envelope key `metadata_format` is always emitted when enabled).
    if (isMetadataStage && effectiveView === 'entries') {
      return <MetadataEntriesView entries={metadataEntries} enabled={!!stage && stage.bytes.length > 0} />;
    }

    switch (effectiveView) {
      case 'hex':
        return <HexView sections={hexSections} paneId={paneId} chunkShape={chunkShape} interleaving={interleaving} />;
      case 'flat': {
        const sources = stageSources.get(selectedStage);
        if (!sources) return null;
        return <FlatView stage={stage} sources={sources} paneId={paneId} chunkShape={chunkShape} interleaving={interleaving} />;
      }
      case 'table':
        return <TableView variables={variables} shape={shape} paneId={paneId} values={tableGridValues} chunkShape={chunkShape} interleaving={interleaving} diffValues={diffValues} showDiff={!!diffValues} isLogicalValues={isValuesStage || isReadStage} />;
      case 'grid':
        return <GridView variables={variables} shape={shape} paneId={paneId} values={tableGridValues} chunkShape={chunkShape} interleaving={interleaving} diffValues={diffValues} showDiff={!!diffValues} />;
      default:
        return <HexView sections={hexSections} paneId={paneId} chunkShape={chunkShape} interleaving={interleaving} />;
    }
  }

  if (collapsed) {
    // Collapsed rail (GuidePanel.tsx precedent): just the expand button.
    // Left pane collapses toward the left (▶ points into it, expand pulls
    // right); right pane collapses toward the right (mirrored).
    return (
      <div
        data-testid={`pane-${paneId}`}
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          height: '100%',
          borderTop: `2px solid ${accentColor}`,
          padding: `${spacing.sm}px 0`,
        }}
      >
        <button
          type="button"
          onClick={onToggleCollapse}
          data-testid={`pane-collapse-${paneId}`}
          aria-label={`Expand ${paneId} pane`}
          style={collapseButtonStyle}
        >
          {paneId === 'left' ? '▶' : '◀'}
        </button>
      </div>
    );
  }

  return (
    <div
      data-testid={`pane-${paneId}`}
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
          onChange={(e) => onStageChange(e.target.value as StageName)}
          data-testid={`pane-dropdown-${paneId}`}
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
          {/* Task 3.8 (D5): option values are stage NAMES — the dropdown's
              value binds directly to selectedStage (a StageName), so there is
              no resolvedIndex hack and the browser can never show a label
              that doesn't match what's rendered (fixes SW-2). */}
          {STAGE_ORDER.map((name) => (
            <option key={name} value={name}>
              {STAGE_LABELS[name]}
            </option>
          ))}
        </select>
        <Radio
          options={viewModes}
          value={effectiveView}
          onChange={(v) => onViewChange(v)}
          size="sm"
          testIdPrefix="view-mode"
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
        <button
          type="button"
          onClick={onToggleCollapse}
          data-testid={`pane-collapse-${paneId}`}
          aria-label={`Collapse ${paneId} pane`}
          style={collapseButtonStyle}
        >
          {paneId === 'left' ? '◀' : '▶'}
        </button>
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
