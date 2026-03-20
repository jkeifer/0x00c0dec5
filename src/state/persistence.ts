import type { AppState } from '../types/state.ts';

const STORAGE_KEYS: Record<AppState['dataModel'], string> = {
  tabular: '0x00c0dec5-state-tabular',
  array: '0x00c0dec5-state-array',
};

export function loadState(model: AppState['dataModel']): AppState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS[model]);
    if (!raw) return null;
    return JSON.parse(raw) as AppState;
  } catch {
    return null;
  }
}

export function saveState(state: AppState): void {
  try {
    localStorage.setItem(STORAGE_KEYS[state.dataModel], JSON.stringify(state));
  } catch {
    // silently fail on storage errors
  }
}
