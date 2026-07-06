import { colors, fontSizes, fonts, radii, spacing } from '../../theme.ts';
import { useGuide } from '../../state/GuideContext.tsx';
import { STEPS } from './steps.ts';

/** Small icon-button style shared by the panel's chrome buttons. */
const iconButtonStyle: React.CSSProperties = {
  background: 'transparent',
  color: colors.textSecondary,
  border: `1px solid ${colors.border}`,
  borderRadius: radii.sm,
  padding: `1px ${spacing.xs}px`,
  fontSize: fontSizes.sm,
  fontFamily: 'inherit',
  cursor: 'pointer',
  lineHeight: 1.4,
};

const navButtonStyle: React.CSSProperties = {
  background: colors.surfaceInput,
  color: colors.textPrimary,
  border: `1px solid ${colors.border}`,
  borderRadius: radii.sm,
  padding: `${spacing.xs - 1}px ${spacing.sm}px`,
  fontSize: fontSizes.sm,
  fontFamily: 'inherit',
  cursor: 'pointer',
};

const headingStyle: React.CSSProperties = {
  fontSize: fontSizes.xs,
  color: colors.textTertiary,
  textTransform: 'uppercase',
  letterSpacing: '0.8px',
  fontWeight: 600,
  margin: `0 0 ${spacing.xs}px`,
};

/**
 * Guide panel (plan Phase 5): a fixed-width flex sibling of MainLayout —
 * deliberately NOT a third resizable panel, so the persisted 'main-layout'
 * panel-group is untouched. 320px expanded, 48px collapsed rail (= presenter
 * mode), unmounted entirely when closed.
 */
// ponytail: fixed 320px steals width from the panes on <~1100px viewports;
// make it an overlay only if a scenario shows real breakage at target sizes.
export function GuidePanel() {
  const { open, collapsed, stepIndex, next, back, goTo, setCollapsed, toggleOpen } = useGuide();

  if (!open) return null;

  const step = STEPS[stepIndex];
  const atStart = stepIndex === 0;
  const atEnd = stepIndex === STEPS.length - 1;
  const counter = `${stepIndex + 1}/${STEPS.length}`;

  if (collapsed) {
    // Presenter rail: just enough to drive the flow with zero help text.
    return (
      <aside
        aria-label="Guide"
        data-testid="guide-panel"
        style={{
          width: 48,
          flexShrink: 0,
          background: colors.surface,
          borderLeft: `1px solid ${colors.border}`,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: spacing.sm,
          padding: `${spacing.sm}px 0`,
        }}
      >
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          data-testid="guide-expand"
          aria-label="Expand guide"
          style={iconButtonStyle}
        >
          ◀
        </button>
        <span
          style={{
            fontFamily: fonts.mono,
            fontSize: fontSizes.sm,
            color: colors.textPrimary,
            fontWeight: 600,
          }}
        >
          {counter}
        </span>
        <button
          type="button"
          onClick={back}
          disabled={atStart}
          data-testid="guide-back"
          aria-label="Previous guide step"
          style={{ ...iconButtonStyle, opacity: atStart ? 0.4 : 1, cursor: atStart ? 'default' : 'pointer' }}
        >
          ▲
        </button>
        <button
          type="button"
          onClick={next}
          disabled={atEnd}
          data-testid="guide-next"
          aria-label="Next guide step"
          style={{ ...iconButtonStyle, opacity: atEnd ? 0.4 : 1, cursor: atEnd ? 'default' : 'pointer' }}
        >
          ▼
        </button>
      </aside>
    );
  }

  return (
    <aside
      aria-label="Guide"
      data-testid="guide-panel"
      style={{
        width: 320,
        flexShrink: 0,
        background: colors.surface,
        borderLeft: `1px solid ${colors.border}`,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Header row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: spacing.xs,
          padding: spacing.sm,
          borderBottom: `1px solid ${colors.borderSubtle}`,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontFamily: fonts.mono,
            fontSize: fontSizes.sm,
            color: colors.textTertiary,
            flexShrink: 0,
          }}
        >
          {counter}
        </span>
        <span
          style={{
            fontSize: fontSizes.md,
            color: colors.textPrimary,
            fontWeight: 600,
            flex: 1,
            minWidth: 0,
          }}
        >
          {step.title}
        </span>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          data-testid="guide-collapse"
          aria-label="Collapse guide to rail (presenter mode)"
          style={iconButtonStyle}
        >
          ▶
        </button>
        <button
          type="button"
          onClick={toggleOpen}
          data-testid="guide-close"
          aria-label="Close guide"
          style={iconButtonStyle}
        >
          ✕
        </button>
      </div>

      {/* Scrollable body */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: spacing.md,
          display: 'flex',
          flexDirection: 'column',
          gap: spacing.md,
          fontSize: fontSizes.sm,
          color: colors.textSecondary,
          lineHeight: 1.55,
        }}
      >
        <p style={{ margin: 0, color: colors.textPrimary }}>{step.decision}</p>

        {step.options.length > 0 && (
          <div>
            <h3 style={headingStyle}>Options</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm }}>
              {step.options.map((opt) => (
                <div key={opt.label}>
                  <div style={{ color: colors.textPrimary, fontWeight: 600 }}>{opt.label}</div>
                  <div style={{ display: 'flex', gap: spacing.xs }}>
                    <span style={{ color: colors.success, flexShrink: 0 }}>+</span>
                    <span>{opt.pros}</span>
                  </div>
                  <div style={{ display: 'flex', gap: spacing.xs }}>
                    <span style={{ color: colors.warning, flexShrink: 0 }}>−</span>
                    <span>{opt.cons}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <p style={{ margin: 0 }}>{step.body}</p>

        <div
          style={{
            background: colors.accentDim,
            borderLeft: `2px solid ${colors.accent}`,
            borderRadius: radii.sm,
            padding: spacing.sm,
          }}
        >
          <h3 style={headingStyle}>Try it</h3>
          <span>{step.tryIt}</span>
        </div>
      </div>

      {/* Footer: nav + step dots */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: spacing.sm,
          padding: spacing.sm,
          borderTop: `1px solid ${colors.borderSubtle}`,
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          onClick={back}
          disabled={atStart}
          data-testid="guide-back"
          style={{ ...navButtonStyle, opacity: atStart ? 0.4 : 1, cursor: atStart ? 'default' : 'pointer' }}
        >
          Back
        </button>
        <div style={{ flex: 1, display: 'flex', justifyContent: 'center', gap: spacing.xs }}>
          {STEPS.map((s, i) => (
            <button
              key={s.id}
              type="button"
              onClick={() => goTo(i)}
              data-testid={`guide-step-${i}`}
              aria-label={`Go to step ${i + 1}: ${s.title}`}
              style={{
                width: 8,
                height: 8,
                padding: 0,
                borderRadius: radii.pill,
                border: 'none',
                background: i === stepIndex ? colors.accent : colors.border,
                cursor: 'pointer',
              }}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={next}
          disabled={atEnd}
          data-testid="guide-next"
          style={{ ...navButtonStyle, opacity: atEnd ? 0.4 : 1, cursor: atEnd ? 'default' : 'pointer' }}
        >
          Next
        </button>
      </div>
    </aside>
  );
}
