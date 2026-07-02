// @vitest-environment jsdom
//
// SW-9 (remediation-plan.md task 4.7): the 500ms debounced localStorage save
// in AppStateProvider loses edits made in the final 500ms before the tab
// closes — the debounce timer is still pending when the page goes away.
// This exercises the `pagehide` flush listener added to fix that: it should
// save synchronously (without waiting out the debounce) and clear the
// pending timer so no redundant/stale save follows.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { AppStateProvider, useAppState } from '../../state/useAppState.ts';

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

const TABULAR_KEY = '0x00c0dec5-state-tabular';

beforeEach(() => {
  globalThis.localStorage = new MockStorage() as unknown as Storage;
});

function renderApp() {
  return renderHook(() => useAppState(), { wrapper: AppStateProvider });
}

describe('pagehide flush (SW-9)', () => {
  it('saves the latest state immediately on pagehide, before the 500ms debounce would fire', () => {
    const { result } = renderApp();

    act(() => {
      result.current.dispatch({ type: 'SET_SHAPE', shape: [42] });
    });

    // Nothing persisted yet — the debounce timer hasn't fired.
    expect(localStorage.getItem(TABULAR_KEY)).toBeNull();

    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });

    const saved = localStorage.getItem(TABULAR_KEY);
    expect(saved).not.toBeNull();
    expect(JSON.parse(saved!).shape).toEqual([42]);
  });

  it('does not double-save or throw when the debounce timer already fired before pagehide', async () => {
    vi.useFakeTimers();
    const { result } = renderApp();

    act(() => {
      result.current.dispatch({ type: 'SET_SHAPE', shape: [7] });
    });

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(JSON.parse(localStorage.getItem(TABULAR_KEY)!).shape).toEqual([7]);

    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(JSON.parse(localStorage.getItem(TABULAR_KEY)!).shape).toEqual([7]);

    vi.useRealTimers();
  });

  it('flushes the very latest state even across multiple rapid edits within the debounce window', () => {
    const { result } = renderApp();

    act(() => {
      result.current.dispatch({ type: 'SET_SHAPE', shape: [1] });
    });
    act(() => {
      result.current.dispatch({ type: 'SET_SHAPE', shape: [2] });
    });
    act(() => {
      result.current.dispatch({ type: 'SET_SHAPE', shape: [3] });
    });

    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });

    expect(JSON.parse(localStorage.getItem(TABULAR_KEY)!).shape).toEqual([3]);
  });

  it('removes its pagehide listener on unmount', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    const { unmount } = renderApp();
    expect(addSpy).toHaveBeenCalledWith('pagehide', expect.any(Function));

    unmount();
    expect(removeSpy).toHaveBeenCalledWith('pagehide', expect.any(Function));

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});
