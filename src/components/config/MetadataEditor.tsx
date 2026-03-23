import { useState } from 'react';
import type { AppState } from '../../types/state.ts';
import { collectMetadata, serializeMetadata } from '../../engine/metadata.ts';
import { Radio } from '../shared/Radio.tsx';
import { colors, fontSizes, radii, spacing } from '../../theme.ts';

interface MetadataEditorProps {
  metadata: AppState['metadata'];
  state: AppState;
  onSerializationChange: (serialization: 'json' | 'binary') => void;
  onAddEntry: () => void;
  onRemoveEntry: (index: number) => void;
  onUpdateEntry: (index: number, key?: string, value?: string) => void;
}

const inputStyle: React.CSSProperties = {
  background: colors.surfaceInput,
  border: `1px solid ${colors.border}`,
  borderRadius: radii.sm,
  fontSize: fontSizes.sm,
  color: colors.textPrimary,
  padding: `${spacing.xs}px ${spacing.sm}px`,
  outline: 'none',
  fontFamily: 'inherit',
};

export function MetadataEditor({
  metadata,
  state,
  onSerializationChange,
  onAddEntry,
  onRemoveEntry,
  onUpdateEntry,
}: MetadataEditorProps) {
  const [autoExpanded, setAutoExpanded] = useState(false);

  const autoEntries = collectMetadata(state, []);
  const allEntries = [
    ...autoEntries,
    ...metadata.customEntries.filter((e) => e.key),
  ];
  const serializedSize = serializeMetadata(allEntries, metadata.serialization).length;

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
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: spacing.xs }}>
            <input
              type="text"
              value={entry.key}
              placeholder="key"
              onChange={(e) => onUpdateEntry(i, e.target.value, undefined)}
              style={{
                ...inputStyle,
                flex: 1,
                minWidth: 0,
                borderColor: !entry.key ? colors.paneAccentRight : colors.border,
              }}
            />
            <input
              type="text"
              value={entry.value}
              placeholder="value"
              onChange={(e) => onUpdateEntry(i, undefined, e.target.value)}
              style={{ ...inputStyle, flex: 1, minWidth: 0 }}
            />
            <button
              onClick={() => onRemoveEntry(i)}
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
        ))}
      </div>

      <button
        onClick={onAddEntry}
        style={{
          ...inputStyle,
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

      <div style={{ fontSize: fontSizes.xs, color: colors.textSecondary }}>
        Serialized: {serializedSize} bytes
      </div>
    </div>
  );
}
