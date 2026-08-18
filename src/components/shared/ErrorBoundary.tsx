import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { colors, fonts, fontSizes, radii, spacing } from '../../theme.ts';
import { STORAGE_KEYS } from '../../state/persistence.ts';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

const RESET_STORAGE_KEYS = Object.values(STORAGE_KEYS);

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an error', error, errorInfo);
  }

  handleReset = () => {
    for (const key of RESET_STORAGE_KEYS) {
      localStorage.removeItem(key);
    }
    location.reload();
  };

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            width: '100%',
            padding: spacing.xl,
            background: colors.bg,
            color: colors.textPrimary,
            fontFamily: fonts.sans,
            textAlign: 'center',
            gap: spacing.md,
          }}
        >
          <h1 style={{ fontSize: fontSizes.lg, margin: 0 }}>Something went wrong</h1>
          <div
            style={{
              fontFamily: fonts.mono,
              fontSize: fontSizes.sm,
              color: colors.textSecondary,
              maxWidth: 600,
              wordBreak: 'break-word',
            }}
          >
            {this.state.error.message}
          </div>
          <button
            onClick={this.handleReset}
            style={{
              marginTop: spacing.md,
              padding: `${spacing.sm}px ${spacing.lg}px`,
              fontSize: fontSizes.md,
              fontFamily: 'inherit',
              color: colors.textPrimary,
              background: colors.surface,
              border: `1px solid ${colors.border}`,
              borderRadius: radii.md,
              cursor: 'pointer',
            }}
          >
            Reset saved state
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
