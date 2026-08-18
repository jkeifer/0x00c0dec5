import { useState } from 'react';
import { colors, fonts, fontSizes, spacing } from '../../theme.ts';
import type { WorkerDiagnostics } from '../../worker/client.ts';

/** overhaul-plan.md F4: mid-session `ok:false` computes used to be invisible
 *  outside the About modal (two clicks deep, nobody opens it mid-talk) once
 *  `result` was non-null — the boot-time-only gate in App.tsx never re-fired
 *  for a later failure, and the spinner clears identically for success and
 *  failure, so the pane silently froze on last-good data. This renders any
 *  non-null `lastError` as a small dismissible banner, mirroring
 *  RuntimeBanner's style/testid conventions. `lastError` is already cleared
 *  to null on the next successful compute (client.ts), so dismissal state is
 *  reset whenever a *new* error string arrives.
 *
 *  F19: after a respawn, `handleCrash` immediately reposts the stuck state
 *  (client.ts), which pays a full recompute (the evict-on-send cache is
 *  empty post-respawn — pipelineCompute.ts's transfer discipline). That
 *  repost's `status` goes back to 'computing' while `lastError` still holds
 *  the crash message, so this window already renders the banner — but with
 *  no signal that the freeze is a bounded recompute rather than a repeat
 *  crash. While recomputing post-respawn, swap in a lower-key "recovering"
 *  message (last known compute duration as an ETA hint) instead of the raw
 *  crash text, no new client.ts state needed. */
export function ComputeErrorBanner({ diagnostics }: { diagnostics: WorkerDiagnostics }) {
  const { lastError: error, status, respawnCount, lastTotalMs } = diagnostics;
  // Dismissal is per-message: dismissing hides THIS error string, and a fresh
  // error (any different message) shows again with no effect/reset dance.
  const [dismissedError, setDismissedError] = useState<string | null>(null);

  if (error === null || error === dismissedError) return null;

  const recovering = status === 'computing' && respawnCount > 0;
  const message = recovering
    ? `Recovering after a worker crash (respawn ${respawnCount}): recomputing from scratch${
        lastTotalMs !== null ? ` (last took ~${Math.round(lastTotalMs)}ms)` : ''
      }.`
    : `Compute failed: ${error}. Showing the last successful result.`;

  return (
    <div
      data-testid="compute-error-banner"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: spacing.md,
        padding: `${spacing.xs}px ${spacing.md}px`,
        fontFamily: fonts.mono,
        fontSize: fontSizes.xs,
        borderBottom: `1px solid ${colors.border}`,
        color: recovering ? colors.textSecondary : colors.error,
        background: colors.surfaceInput,
      }}
    >
      <span style={{ flex: 1 }}>{message}</span>
      <button
        data-testid="compute-error-banner-dismiss"
        onClick={() => setDismissedError(error)}
        style={{ background: 'transparent', border: 'none', color: colors.textTertiary, cursor: 'pointer', fontSize: fontSizes.xs }}
      >
        dismiss
      </button>
    </div>
  );
}
