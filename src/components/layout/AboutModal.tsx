import { useEffect, useState } from 'react';
import { colors, fonts, fontSizes, radii, spacing } from '../../theme.ts';
import { useAppState } from '../../state/useAppState.ts';
import type { WorkerDiagnostics } from '../../worker/client.ts';
import { BUILD_INFO } from '../../build-info.js';
import { BLOG_POSTS } from '../guide/steps.ts';

const GITHUB_URL = 'https://github.com/jkeifer/0x00c0dec5';

export interface AboutModalProps {
  onClose: () => void;
  diagnostics?: WorkerDiagnostics;
}

/**
 * About modal (perf plan Task 14): app identity/build info plus a
 * collapsed-by-default "Performance" section surfacing the worker
 * diagnostics App already threads through Header. Fixed overlay + centered
 * panel — this is the only modal in the app so far, no shared Modal
 * abstraction exists yet (ponytail: add one if a second modal shows up).
 */
export function AboutModal({ onClose, diagnostics }: AboutModalProps) {
  const { state } = useAppState();
  const [perfOpen, setPerfOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const elementCount = state.shape.reduce((a, b) => a * b, 1) * state.variables.length;
  const dirty = BUILD_INFO.commit.endsWith('-dirty');

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        data-testid="about-modal"
        role="dialog"
        aria-modal="true"
        aria-label="About 0x00C0DEC5"
        style={{
          background: colors.surface,
          border: `1px solid ${colors.border}`,
          borderRadius: radii.lg,
          padding: spacing.lg,
          width: 360,
          maxWidth: '90vw',
          maxHeight: '80vh',
          overflowY: 'auto',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md }}>
          <span
            style={{
              fontFamily: fonts.mono,
              fontSize: fontSizes.lg,
              color: colors.textPrimary,
              fontWeight: 600,
              letterSpacing: '0.5px',
            }}
          >
            0x00C0DEC5
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'transparent',
              color: colors.textSecondary,
              border: `1px solid ${colors.border}`,
              borderRadius: radii.sm,
              padding: `1px ${spacing.xs}px`,
              fontSize: fontSizes.sm,
              cursor: 'pointer',
            }}
          >
            ✕
          </button>
        </div>

        <div style={{ fontSize: fontSizes.sm, color: colors.textSecondary, lineHeight: 1.6 }}>
          <div title={`Built ${BUILD_INFO.buildTime}`}>
            Commit: <span style={{ fontFamily: fonts.mono, color: colors.textPrimary }}>{BUILD_INFO.commit}</span>
            {dirty && <span style={{ color: colors.warning }}> (dirty)</span>}
          </div>
          <div>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" style={{ color: colors.accent }}>
              {GITHUB_URL}
            </a>
          </div>

          <div style={{ marginTop: spacing.md }}>
            <div style={{ color: colors.textTertiary, marginBottom: spacing.xs }}>Further reading</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.xs }}>
              {BLOG_POSTS.map((post, i) => (
                <a
                  key={post.url}
                  href={post.url}
                  target="_blank"
                  rel="noreferrer"
                  data-testid={`about-blog-link-${i}`}
                  style={{ color: colors.accent, wordBreak: 'break-word' }}
                >
                  {post.label}
                </a>
              ))}
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setPerfOpen((v) => !v)}
          data-testid="about-performance-toggle"
          aria-expanded={perfOpen}
          style={{
            marginTop: spacing.md,
            background: colors.surfaceInput,
            color: colors.textPrimary,
            border: `1px solid ${colors.border}`,
            borderRadius: radii.sm,
            padding: `${spacing.xs}px ${spacing.sm}px`,
            fontSize: fontSizes.sm,
            fontFamily: 'inherit',
            cursor: 'pointer',
            width: '100%',
            textAlign: 'left',
          }}
        >
          {perfOpen ? '▾' : '▸'} Performance
        </button>

        {perfOpen && (
          <div style={{ marginTop: spacing.sm, fontSize: fontSizes.sm, color: colors.textSecondary, lineHeight: 1.6 }}>
            <div>Worker status: {diagnostics?.status ?? 'unknown'}</div>
            <div>Respawns: {diagnostics?.respawnCount ?? 0}</div>
            <div>Last compute: {diagnostics?.lastTotalMs != null ? `${diagnostics.lastTotalMs.toFixed(1)} ms` : '—'}</div>
            <div>Elements: {elementCount.toLocaleString()}</div>
            {diagnostics?.lastError && (
              <div style={{ color: colors.error }}>Last error: {diagnostics.lastError}</div>
            )}

            {diagnostics?.lastTimings && Object.keys(diagnostics.lastTimings).length > 0 && (
              <table style={{ marginTop: spacing.xs, width: '100%', borderCollapse: 'collapse' }}>
                <tbody>
                  {Object.entries(diagnostics.lastTimings).map(([stage, ms]) => (
                    <tr key={stage}>
                      <td style={{ color: colors.textTertiary, padding: '1px 0' }}>{stage}</td>
                      <td style={{ textAlign: 'right', fontFamily: fonts.mono }}>{ms!.toFixed(1)} ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
