// @vitest-environment jsdom
//
// Task 14 (perf plan): AboutModal renders build info + a collapsed-by-default
// Performance section fed by the worker diagnostics App threads through
// Header (Task 13). Wrapped in AppStateProvider because the component reads
// state.shape/variables via useAppState() for the element count.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AppStateProvider } from '../../../src/state/useAppState.ts';
import { AboutModal } from '../../../src/components/layout/AboutModal.tsx';
import { INITIAL_RUNTIME_STATE, type WorkerDiagnostics } from '../../../src/worker/client.ts';

class MockStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

beforeEach(() => {
  globalThis.localStorage = new MockStorage() as unknown as Storage;
});

const FAKE_DIAGNOSTICS: WorkerDiagnostics = {
  status: 'idle',
  respawnCount: 2,
  lastTimings: { values: 3.1, typed: 1.2, encoded: 5.6 },
  lastTotalMs: 12.4,
  lastError: null,
  runtime: INITIAL_RUNTIME_STATE,
};

function renderModal(diagnostics: WorkerDiagnostics = FAKE_DIAGNOSTICS) {
  return render(
    <AppStateProvider>
      <AboutModal onClose={() => {}} diagnostics={diagnostics} />
    </AppStateProvider>,
  );
}

describe('AboutModal', () => {
  it('renders the modal with commit text visible', () => {
    renderModal();
    expect(screen.getByTestId('about-modal')).toBeTruthy();
    expect(screen.getByText(/Commit:/)).toBeTruthy();
  });

  it('does not show performance content until the toggle is clicked', () => {
    renderModal();
    expect(screen.queryByText(/Worker status:/)).toBeNull();
    expect(screen.queryByText('values')).toBeNull();

    fireEvent.click(screen.getByTestId('about-performance-toggle'));

    expect(screen.getByText(/Worker status:/)).toBeTruthy();
    expect(screen.getByText('values')).toBeTruthy();
    expect(screen.getByText('typed')).toBeTruthy();
    expect(screen.getByText('encoded')).toBeTruthy();
  });
});
