import { useState } from 'react';
import type { RuntimeState } from '../../worker/client.ts';
import { colors, fonts, fontSizes, spacing } from '../../theme.ts';

/** Project 4: narrated Pyodide load progress, rendered as a slim strip under
 *  the Header. Gone once ready; on failure it becomes a dismissible error
 *  ("everything else works" — educational codecs are unaffected). */
export function RuntimeBanner({ runtime }: { runtime: RuntimeState }) {
  const [dismissed, setDismissed] = useState(false);
  if (runtime.status === 'ready' || dismissed) return null;

  const base: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.md,
    padding: `${spacing.xs}px ${spacing.md}px`,
    fontFamily: fonts.mono,
    fontSize: fontSizes.xs,
    borderBottom: `1px solid ${colors.border}`,
  };

  if (runtime.status === 'error') {
    return (
      <div data-testid="runtime-banner" style={{ ...base, color: colors.error, background: colors.surfaceInput }}>
        <span style={{ flex: 1 }}>
          Real codecs unavailable: {runtime.error}. Everything else works — educational codecs are unaffected.
        </span>
        <button
          data-testid="runtime-banner-dismiss"
          onClick={() => setDismissed(true)}
          style={{ background: 'transparent', border: 'none', color: colors.textTertiary, cursor: 'pointer', fontSize: fontSizes.xs }}
        >
          dismiss
        </button>
      </div>
    );
  }

  return (
    <div data-testid="runtime-banner" style={{ ...base, color: colors.textSecondary, background: colors.surfaceInput }}>
      <span>Loading real codecs:</span>
      {runtime.steps.map((s) => (
        <span key={s.id} data-testid={`runtime-banner-step-${s.id}`} style={{ color: s.done ? colors.success : colors.textPrimary }}>
          {s.done ? '✓ ' : '… '}{s.label}
        </span>
      ))}
    </div>
  );
}
