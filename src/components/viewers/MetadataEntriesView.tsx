import { colors, fonts, fontSizes, radii, spacing } from '../../theme.ts';
import type { MetadataDisplayEntry } from '../../engine/pipelineCompute.ts';
import { TYPE_STRING, TYPE_U32_ARRAY, TYPE_ENUM, TYPE_CHUNK_INDEX, TYPE_SCHEMA } from '../../engine/metadataBinary.ts';

/**
 * The Metadata stage's default view — a monospace key/value table of the
 * entries actually assembled, parsed from the stage's own serialized bytes in
 * binary mode (see computeMetadataStage's `entries`, not `collectMetadata`'s
 * pre-serialize output) so this shows what the bytes say.
 */
interface MetadataEntriesViewProps {
  entries: MetadataDisplayEntry[];
  enabled: boolean;
}

/** Type code -> short name for the "tag N · name" badge. Binary mode only —
 * JSON entries carry null tag/type and render no badge. */
const TYPE_NAMES: Record<number, string> = {
  [TYPE_STRING]: 'string',
  [TYPE_U32_ARRAY]: 'u32[]',
  [TYPE_ENUM]: 'enum',
  [TYPE_CHUNK_INDEX]: 'chunk-index',
  [TYPE_SCHEMA]: 'schema',
};

/** Pretty-print a value that's JSON (most registered keys serialize arrays/
 * objects as JSON strings); fall back to the raw string for plain scalars
 * (e.g. 'little', 'row-major') that aren't valid JSON on their own... those
 * still parse fine as JSON strings would need quotes, so this only upgrades
 * genuine JSON blobs and leaves everything else untouched. */
function prettyValue(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 1);
  } catch {
    return value;
  }
}

export function MetadataEntriesView({ entries, enabled }: MetadataEntriesViewProps) {
  if (!enabled) {
    return (
      <div
        data-testid="metadata-entries-view"
        style={{
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: colors.textTertiary,
          fontSize: fontSizes.md,
        }}
      >
        metadata is disabled — nothing is assembled
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div
        data-testid="metadata-entries-view"
        style={{
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: colors.textTertiary,
          fontSize: fontSizes.md,
        }}
      >
        no entries
      </div>
    );
  }

  return (
    <div
      data-testid="metadata-entries-view"
      style={{
        height: '100%',
        boxSizing: 'border-box',
        overflowY: 'auto',
        padding: spacing.md,
      }}
    >
      <div
        style={{
          border: `1px solid ${colors.borderSubtle}`,
          borderRadius: radii.sm,
        }}
      >
        {entries.map((entry, i) => (
          <div
            key={entry.key}
            data-testid={`metadata-entry-${entry.key}`}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: spacing.xs - 2,
              padding: spacing.sm,
              borderTop: i === 0 ? undefined : `1px solid ${colors.borderSubtle}`,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: spacing.sm }}>
              <span style={{ fontFamily: fonts.mono, fontSize: fontSizes.sm, fontWeight: 600, color: colors.textPrimary }}>
                {entry.key}
              </span>
              {entry.tag !== null && (
                <span style={{ fontFamily: fonts.mono, fontSize: fontSizes.xs, color: colors.textTertiary }}>
                  tag {entry.tag} · {TYPE_NAMES[entry.type ?? -1] ?? `type ${entry.type}`}
                </span>
              )}
            </div>
            <pre
              style={{
                margin: 0,
                fontFamily: fonts.mono,
                fontSize: fontSizes.xs,
                color: colors.textSecondary,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {prettyValue(entry.value)}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}
