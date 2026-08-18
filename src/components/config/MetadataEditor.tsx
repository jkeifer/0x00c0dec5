import { useMemo, useState } from 'react';
import type { AppState } from '../../types/state.ts';
import type { MetadataIncludeConfig } from '../../types/state.ts';
import { collectMetadata, serializeMetadata, type ChunkIndexEntry } from '../../engine/metadata.ts';
import { computeChunkGrid, enumerateChunkCoords } from '../../engine/chunk.ts';
import { pipelineCapError } from '../../engine/pipelineCompute.ts';
import { Radio } from '../shared/Radio.tsx';
import { colors, fontSizes, spacing } from '../../theme.ts';
import { inputStyle } from '../shared/controlStyles.ts';

interface MetadataEditorProps {
  metadata: AppState['metadata'];
  state: AppState;
  onSerializationChange: (serialization: 'json' | 'binary') => void;
  onAddEntry: () => void;
  onRemoveEntry: (index: number) => void;
  onUpdateEntry: (index: number, key?: string, value?: string) => void;
  onIncludeChange: (key: keyof MetadataIncludeConfig, value: boolean) => void;
  onEnabledChange: (enabled: boolean) => void;
}

// Task 5 (read plan) / Task 8 (metadata redesign): one row per
// metadata.include group (Task 1), label + Radio only — the per-group
// consequence hints were spoilers and are deleted (brief: "labels only —
// no spoilers"). Driven as a map, not six copy-pasted blocks.
const INCLUDE_GROUPS: { key: keyof MetadataIncludeConfig; testid: string; label: string }[] = [
  { key: 'schema', testid: 'include-schema-toggle', label: 'Include Schema' },
  { key: 'layout', testid: 'include-layout-toggle', label: 'Include Layout' },
  { key: 'codecs', testid: 'include-codecs-toggle', label: 'Include Codecs' },
  { key: 'chunkIndex', testid: 'include-chunk-index-toggle', label: 'Include Chunk Index' },
  { key: 'descriptive', testid: 'include-descriptive-toggle', label: 'Include Descriptive' },
  { key: 'endianness', testid: 'include-endianness-toggle', label: 'Include Endianness' },
];

/**
 * Build placeholder chunk_index entries for the sidebar preview only — real
 * offsets aren't known here (that requires the actual encoded chunk bytes,
 * which live in the pipeline, not the raw config state this editor sees).
 * Placeholder offsets/sizes are large enough (same digit-width ballpark as
 * real ones tend to be) that the serialized *size* estimate stays close, and
 * the caller labels the total with "≈" since it's an estimate, not the exact
 * count Write will embed.
 */
function buildPlaceholderChunkIndex(state: AppState): ChunkIndexEntry[] {
  // Same hard cap as the compute entries: this preview materializes one entry
  // per chunk ON THE MAIN THREAD, so a refused-by-the-worker state (e.g. a
  // committed 2-billion-element shape) must not enumerate millions of coords
  // here either — that froze the tab before the worker even saw the state.
  if (pipelineCapError(state) !== null) return [];
  const chunkGrid = computeChunkGrid(state.shape, state.chunkShape);
  const coordsList = enumerateChunkCoords(chunkGrid);
  const variableNames = state.interleaving === 'column' ? state.variables.map((v) => v.name) : [undefined];

  const entries: ChunkIndexEntry[] = [];
  let offset = 0;
  for (const variableName of variableNames) {
    for (const coords of coordsList) {
      entries.push({
        coords,
        offset,
        size: 1024, // placeholder — real size depends on encoded chunk bytes
        ...(variableName ? { variableName } : {}),
      });
      offset += 1024;
    }
  }
  return entries;
}

export function MetadataEditor({
  metadata,
  state,
  onSerializationChange,
  onAddEntry,
  onRemoveEntry,
  onUpdateEntry,
  onIncludeChange,
  onEnabledChange,
}: MetadataEditorProps) {
  const [autoExpanded, setAutoExpanded] = useState(false);

  // Task 2.11 (UI-7): memoize the collect+serialize call — it re-serializes
  // the entire metadata payload, which should only happen when the metadata-
  // relevant slices of state actually change, not on every sidebar render.
  // `state` with `customEntries` cleared gives exactly the auto-only entries
  // (the "Auto-collected" display), without a second bespoke collection path
  // that could drift from what `collectMetadata` actually does.
  const metadataDisabled = !state.metadata.enabled;

  const autoEntries = useMemo(
    () =>
      metadataDisabled
        ? []
        : collectMetadata(
            { ...state, metadata: { ...state.metadata, customEntries: [] } },
            [],
            undefined,
            state.metadata.include.chunkIndex ? buildPlaceholderChunkIndex(state) : undefined,
          ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      metadataDisabled,
      state.variables,
      state.shape,
      state.chunkShape,
      state.interleaving,
      state.fieldPipelines,
      state.chunkPipeline,
      state.write.chunkOrder,
      state.write.partitioning,
      state.metadata.serialization,
      state.metadata.include,
    ],
  );

  // Override-wins (spec §2): a custom entry whose key matches an auto-collected
  // key replaces that entry's value in place rather than being renamed away, so
  // the row's note here is just "does this key match one collectMetadata already
  // emitted".
  const customKeyInfo = useMemo(() => {
    return metadata.customEntries.map((entry) => {
      if (!entry.key) return { overrides: false };
      return { overrides: autoEntries.some((a) => a.key === entry.key) };
    });
  }, [autoEntries, metadata.customEntries]);

  // Task 2.11 (UI-7): the full entry set Write will actually embed — auto
  // entries plus `collectMetadata`'s own override-applied custom entries. Do
  // NOT append `metadata.customEntries` again here (that was the double-count
  // bug): `collectMetadata` already includes them.
  const allEntries = useMemo(
    () =>
      metadataDisabled
        ? []
        : collectMetadata(
            state,
            [],
            undefined,
            state.metadata.include.chunkIndex ? buildPlaceholderChunkIndex(state) : undefined,
          ),
    [metadataDisabled, state],
  );
  const serializedSize = useMemo(
    () => (metadataDisabled ? 0 : serializeMetadata(allEntries, metadata.serialization).length),
    [metadataDisabled, allEntries, metadata.serialization],
  );
  const chunkIndexIsEstimate = !metadataDisabled && state.metadata.include.chunkIndex;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm }}>
      {/* Enable metadata — master switch, section owns it now (Task 8) */}
      <div data-testid="metadata-enabled-toggle" style={{ display: 'flex', flexDirection: 'column', gap: spacing.xs }}>
        <span style={{ fontSize: fontSizes.xs, color: colors.textSecondary }}>Enable Metadata</span>
        <Radio
          options={[
            { value: 'yes', label: 'Yes' },
            { value: 'no', label: 'No' },
          ]}
          value={metadata.enabled ? 'yes' : 'no'}
          onChange={(v) => onEnabledChange(v === 'yes')}
          size="sm"
          testIdPrefix="metadata-enabled-toggle-opt"
        />
      </div>

      {/* Metadata include-group toggles (Task 5, read plan) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm }}>
        {INCLUDE_GROUPS.map(({ key, testid, label }) => (
          <div key={key} data-testid={testid} style={{ display: 'flex', flexDirection: 'column', gap: spacing.xs }}>
            <span style={{ fontSize: fontSizes.xs, color: colors.textSecondary }}>{label}</span>
            <Radio
              options={[
                { value: 'yes', label: 'Yes' },
                { value: 'no', label: 'No' },
              ]}
              value={state.metadata.include[key] ? 'yes' : 'no'}
              onChange={(v) => onIncludeChange(key, v === 'yes')}
              size="sm"
              disabled={metadataDisabled}
              testIdPrefix={`${testid}-opt`}
            />
          </div>
        ))}
      </div>

      {/* Auto-collected entries */}
      <div style={{ opacity: metadataDisabled ? 0.5 : 1 }}>
        <button
          onClick={() => setAutoExpanded(!autoExpanded)}
          style={{
            background: 'transparent',
            border: 'none',
            color: colors.textSecondary,
            cursor: 'pointer',
            fontSize: fontSizes.xs,
            padding: 0,
            fontFamily: 'inherit',
          }}
        >
          {autoExpanded ? '- ' : '+ '}Auto-collected ({autoEntries.length})
        </button>
        {autoExpanded && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              marginTop: spacing.xs,
            }}
          >
            {autoEntries.map((entry, i) => (
              <div key={i} style={{ display: 'flex', gap: spacing.xs, alignItems: 'baseline' }}>
                <span style={{ fontSize: fontSizes.xs, color: colors.textSecondary, flexShrink: 0 }}>
                  {entry.key}:
                </span>
                <span
                  style={{
                    fontSize: fontSizes.xs,
                    color: colors.textTertiary,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {entry.value.length > 60 ? entry.value.slice(0, 60) + '...' : entry.value}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Custom entries — "+ Entry" precedes the rows it adds to (Task 8) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.xs }}>
        <button
          onClick={onAddEntry}
          disabled={metadataDisabled}
          style={{
            ...inputStyle(),
            cursor: metadataDisabled ? 'default' : 'pointer',
            color: colors.accent,
            background: 'transparent',
            textAlign: 'center',
            fontSize: fontSizes.xs,
            opacity: metadataDisabled ? 0.5 : 1,
          }}
        >
          + Entry
        </button>
        {metadata.customEntries.map((entry, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: spacing.xs }}>
              <input
                type="text"
                value={entry.key}
                placeholder="key"
                disabled={metadataDisabled}
                onChange={(e) => onUpdateEntry(i, e.target.value, undefined)}
                data-testid={`metadata-custom-key-${i}`}
                style={{
                  ...inputStyle(),
                  flex: 1,
                  minWidth: 0,
                  borderColor: !entry.key ? colors.warning : colors.border,
                  opacity: metadataDisabled ? 0.5 : 1,
                }}
              />
              <input
                type="text"
                value={entry.value}
                placeholder="value"
                disabled={metadataDisabled}
                onChange={(e) => onUpdateEntry(i, undefined, e.target.value)}
                style={{ ...inputStyle(), flex: 1, minWidth: 0, opacity: metadataDisabled ? 0.5 : 1 }}
              />
              <button
                onClick={() => onRemoveEntry(i)}
                disabled={metadataDisabled}
                aria-label={entry.key ? `Remove metadata entry ${entry.key}` : 'Remove metadata entry'}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: colors.textTertiary,
                  cursor: metadataDisabled ? 'default' : 'pointer',
                  fontSize: fontSizes.sm,
                  padding: `0 ${spacing.xs}px`,
                  lineHeight: 1,
                  opacity: metadataDisabled ? 0.5 : 1,
                }}
              >
                x
              </button>
            </div>
            {customKeyInfo[i]?.overrides && (
              <span data-testid={`metadata-key-override-note-${i}`} style={{ fontSize: fontSizes.xs, color: colors.textTertiary }}>
                overrides auto-collected {entry.key}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Serialization toggle */}
      <Radio
        options={[
          { value: 'json', label: 'JSON' },
          { value: 'binary', label: 'Binary' },
        ]}
        value={metadata.serialization}
        onChange={(v) => onSerializationChange(v as 'json' | 'binary')}
        size="sm"
        disabled={metadataDisabled}
      />

      <div data-testid="metadata-serialized-size" style={{ fontSize: fontSizes.xs, color: colors.textSecondary }}>
        Serialized: {chunkIndexIsEstimate ? '≈ ' : ''}{serializedSize} bytes
        {chunkIndexIsEstimate && (
          <span style={{ color: colors.textTertiary }}> (includes chunk index, offsets estimated here)</span>
        )}
      </div>
    </div>
  );
}
