import { useMemo, useState } from 'react';
import type { AppState } from '../../types/state.ts';
import type { MetadataIncludeConfig } from '../../types/state.ts';
import { collectMetadata, serializeMetadata, dedupeCustomKey, type ChunkIndexEntry } from '../../engine/metadata.ts';
import { computeChunkGrid, enumerateChunkCoords } from '../../engine/chunk.ts';
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
}

// Task 5 (read plan): one row per metadata.include group (Task 1), each with
// a testid and a one-line consequence hint naming the read step the reader
// stops at without it. Driven as a map, not five copy-pasted blocks.
const INCLUDE_GROUPS: { key: keyof MetadataIncludeConfig; testid: string; label: string; hint: string }[] = [
  { key: 'schema', testid: 'include-schema-toggle', label: 'Include Schema', hint: 'without this, the reader stops at: read schema' },
  { key: 'layout', testid: 'include-layout-toggle', label: 'Include Layout', hint: 'without this, the reader stops at: read layout' },
  { key: 'codecs', testid: 'include-codecs-toggle', label: 'Include Codecs', hint: 'without this, the reader stops at: decode chunks (or reads garbage)' },
  { key: 'chunkIndex', testid: 'include-chunk-index-toggle', label: 'Include Chunk Index', hint: 'without this, the reader stops at: locate chunks (single-file entropy configs)' },
  { key: 'descriptive', testid: 'include-descriptive-toggle', label: 'Include Descriptive', hint: 'without this, the reader loses: nothing — the reader doesn\'t need it' },
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
}: MetadataEditorProps) {
  const [autoExpanded, setAutoExpanded] = useState(false);

  // Task 2.11 (UI-7): memoize the collect+serialize call — it re-serializes
  // the entire metadata payload, which should only happen when the metadata-
  // relevant slices of state actually change, not on every sidebar render.
  // `state` with `customEntries` cleared gives exactly the auto-only entries
  // (the "Auto-collected" display), without a second bespoke collection path
  // that could drift from what `collectMetadata` actually does.
  const autoEntries = useMemo(
    () =>
      collectMetadata(
        { ...state, metadata: { ...state.metadata, customEntries: [] } },
        [],
        undefined,
        state.metadata.include.chunkIndex ? buildPlaceholderChunkIndex(state) : undefined,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
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

  // DC-5: collect the auto keys once so custom-entry rows can show the same
  // collision warning that `collectMetadata`'s serialization-time renaming
  // will actually apply — computed the same way (claimed-keys accumulate as
  // we walk the custom entries in order, so a later entry can also collide
  // with an earlier renamed one).
  const customKeyInfo = useMemo(() => {
    const claimed = new Set(autoEntries.map((e) => e.key));
    return metadata.customEntries.map((entry) => {
      if (!entry.key) return { collides: false, finalKey: entry.key };
      const before = claimed.has(entry.key);
      const finalKey = dedupeCustomKey(entry.key, claimed);
      return { collides: before, finalKey };
    });
  }, [autoEntries, metadata.customEntries]);

  // Task 2.11 (UI-7): the full entry set Write will actually embed — auto
  // entries plus `collectMetadata`'s own DC-5-renamed custom entries. Do NOT
  // append `metadata.customEntries` again here (that was the double-count
  // bug): `collectMetadata` already includes them.
  const allEntries = useMemo(
    () => collectMetadata(
      state,
      [],
      undefined,
      state.metadata.include.chunkIndex ? buildPlaceholderChunkIndex(state) : undefined,
    ),
    [state],
  );
  const serializedSize = useMemo(
    () => serializeMetadata(allEntries, metadata.serialization).length,
    [allEntries, metadata.serialization],
  );
  const chunkIndexIsEstimate = state.metadata.include.chunkIndex;
  const metadataDisabled = !state.write.includeMetadata;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm }}>
      {/* Auto-collected entries */}
      <div>
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

      {/* Custom entries */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.xs }}>
        {metadata.customEntries.map((entry, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: spacing.xs }}>
              <input
                type="text"
                value={entry.key}
                placeholder="key"
                onChange={(e) => onUpdateEntry(i, e.target.value, undefined)}
                data-testid={`metadata-custom-key-${i}`}
                style={{
                  ...inputStyle(),
                  flex: 1,
                  minWidth: 0,
                  borderColor: !entry.key
                    ? colors.warning
                    : customKeyInfo[i]?.collides
                      ? colors.warning
                      : colors.border,
                }}
              />
              <input
                type="text"
                value={entry.value}
                placeholder="value"
                onChange={(e) => onUpdateEntry(i, undefined, e.target.value)}
                style={{ ...inputStyle(), flex: 1, minWidth: 0 }}
              />
              <button
                onClick={() => onRemoveEntry(i)}
                aria-label={entry.key ? `Remove metadata entry ${entry.key}` : 'Remove metadata entry'}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: colors.textTertiary,
                  cursor: 'pointer',
                  fontSize: fontSizes.sm,
                  padding: `0 ${spacing.xs}px`,
                  lineHeight: 1,
                }}
              >
                x
              </button>
            </div>
            {customKeyInfo[i]?.collides && (
              <span data-testid={`metadata-key-collision-warning-${i}`} style={{ fontSize: fontSizes.xs, color: colors.warning }}>
                key collides with auto metadata; will be written as {customKeyInfo[i].finalKey}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Metadata include-group toggles (Task 5, read plan) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm }}>
        {metadataDisabled && (
          <span style={{ fontSize: fontSizes.xs, color: colors.warning }}>
            metadata is not being written — enable "Include Metadata" in Write to change these
          </span>
        )}
        {INCLUDE_GROUPS.map(({ key, testid, label, hint }) => (
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
            />
            <span style={{ fontSize: fontSizes.xs, color: colors.textTertiary }}>{hint}</span>
          </div>
        ))}
      </div>

      <button
        onClick={onAddEntry}
        style={{
          ...inputStyle(),
          cursor: 'pointer',
          color: colors.accent,
          background: 'transparent',
          textAlign: 'center',
          fontSize: fontSizes.xs,
        }}
      >
        + Entry
      </button>

      {/* Serialization toggle */}
      <Radio
        options={[
          { value: 'json', label: 'JSON' },
          { value: 'binary', label: 'Binary' },
        ]}
        value={metadata.serialization}
        onChange={(v) => onSerializationChange(v as 'json' | 'binary')}
        size="sm"
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
