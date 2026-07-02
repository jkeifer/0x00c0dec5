import {
  createContext,
  useContext,
  useReducer,
  useEffect,
  useRef,
  useCallback,
  type ReactNode,
  createElement,
} from 'react';
import { produce } from 'immer';
import { DEFAULT_STATE, type AppState, type Variable } from '../types/state.ts';
import type { CodecStep } from '../types/codecs.ts';
import { loadState, saveState, loadActiveModel, saveActiveModel } from './persistence.ts';

export type AppAction =
  // SET_DATA_MODEL only sets `state.dataModel` — it is intentionally pure
  // (SW-4). The storage I/O that used to live inside this case (save the
  // outgoing model, load/default the incoming one) now lives in the
  // `switchDataModel` wrapper exposed by `useAppState()`, which dispatches
  // REPLACE_STATE with the fully-resolved state instead. Nothing should
  // dispatch SET_DATA_MODEL directly except that wrapper.
  | { type: 'SET_DATA_MODEL'; model: AppState['dataModel'] }
  // REPLACE_STATE swaps in a full AppState wholesale. Used ONLY by
  // switchDataModel's wrapper (the one remaining "replace everything" escape
  // hatch now that LOAD_STATE — never dispatched — is deleted, SW-8).
  | { type: 'REPLACE_STATE'; state: AppState }
  // Schema
  | { type: 'SET_SHAPE'; shape: number[] }
  | { type: 'ADD_VARIABLE'; variable: Variable }
  | { type: 'REMOVE_VARIABLE'; id: string }
  | { type: 'UPDATE_VARIABLE'; id: string; changes: Partial<Pick<Variable, 'name' | 'logicalType' | 'typeAssignment'>> }
  // Chunk
  | { type: 'SET_CHUNK_SHAPE'; chunkShape: number[] }
  // Interleave
  | { type: 'SET_INTERLEAVING'; interleaving: 'row' | 'column' }
  // Codecs
  | { type: 'SET_FIELD_PIPELINE'; variableId: string; steps: CodecStep[] }
  | { type: 'SET_CHUNK_PIPELINE'; steps: CodecStep[] }
  // Metadata (customEntries CRUD keeps its index-based shape; everything else
  // in AppState['metadata'] is a patch action, per task 3.7)
  | { type: 'ADD_METADATA_ENTRY' }
  | { type: 'REMOVE_METADATA_ENTRY'; index: number }
  | { type: 'UPDATE_METADATA_ENTRY'; index: number; key?: string; value?: string }
  | { type: 'UPDATE_METADATA_CONFIG'; changes: Partial<Pick<AppState['metadata'], 'serialization' | 'includeChunkIndex'>> }
  // Write — one patch action replaces the six SET_WRITE_* setters
  | { type: 'UPDATE_WRITE'; changes: Partial<AppState['write']> }
  // UI — one patch action replaces the pane stage/view setters and SET_SHOW_DIFF
  | { type: 'UPDATE_UI'; changes: Partial<AppState['ui']> };

export function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_DATA_MODEL': {
      // Pure: just sets dataModel. No storage I/O here (SW-4) — see
      // `switchDataModel` in AppStateProvider for the save/load/restore
      // sequence, which dispatches REPLACE_STATE instead of this action.
      if (action.model === state.dataModel) return state;
      return produce(state, (draft) => {
        draft.dataModel = action.model;
      });
    }

    case 'REPLACE_STATE':
      return action.state;

    case 'UPDATE_UI':
      return produce(state, (draft) => {
        Object.assign(draft.ui, action.changes);
      });

    // ─── Schema ──────────────────────────────────────────────────────
    case 'SET_SHAPE': {
      const newShape = action.shape;
      if (newShape.length === 0 || newShape.some(d => d <= 0)) {
        return state;
      }
      return produce(state, (draft) => {
        const oldLen = draft.shape.length;
        const newLen = newShape.length;
        const newChunkShape: number[] = [];
        for (let d = 0; d < newLen; d++) {
          if (d < oldLen) {
            // Clamp existing chunk dim to new shape dim
            newChunkShape.push(Math.min(draft.chunkShape[d], newShape[d]));
          } else {
            // New dim: default chunk size = shape size
            newChunkShape.push(newShape[d]);
          }
        }
        draft.shape = newShape;
        draft.chunkShape = newChunkShape;
      });
    }

    case 'ADD_VARIABLE':
      return produce(state, (draft) => {
        draft.variables.push(action.variable);
        draft.fieldPipelines[action.variable.id] = [];
      });

    case 'REMOVE_VARIABLE':
      return produce(state, (draft) => {
        const idx = draft.variables.findIndex((v) => v.id === action.id);
        if (idx === -1) return;
        draft.variables.splice(idx, 1);
        delete draft.fieldPipelines[action.id];
      });

    case 'UPDATE_VARIABLE':
      return produce(state, (draft) => {
        const v = draft.variables.find((v) => v.id === action.id);
        if (!v) return;
        if (action.changes.name !== undefined) v.name = action.changes.name;
        if (action.changes.logicalType !== undefined) v.logicalType = action.changes.logicalType;
        if (action.changes.typeAssignment !== undefined) v.typeAssignment = action.changes.typeAssignment;
        // fieldPipelines is keyed by Variable.id (D5), which never changes here —
        // no re-keying needed on rename. (Fixes SW-1.)
      });

    // ─── Chunk ───────────────────────────────────────────────────────
    case 'SET_CHUNK_SHAPE': {
      const newChunkShape = action.chunkShape;
      if (
        newChunkShape.length === 0 ||
        newChunkShape.length !== state.shape.length ||
        newChunkShape.some((d) => d <= 0 || !Number.isInteger(d))
      ) {
        return state;
      }
      return produce(state, (draft) => {
        draft.chunkShape = newChunkShape.map((d, i) => Math.min(d, draft.shape[i]));
      });
    }

    // ─── Interleave ──────────────────────────────────────────────────
    case 'SET_INTERLEAVING':
      return produce(state, (draft) => {
        draft.interleaving = action.interleaving;
      });

    // ─── Codecs ──────────────────────────────────────────────────────
    case 'SET_FIELD_PIPELINE':
      return produce(state, (draft) => {
        draft.fieldPipelines[action.variableId] = action.steps;
      });

    case 'SET_CHUNK_PIPELINE':
      return produce(state, (draft) => {
        draft.chunkPipeline = action.steps;
      });

    // ─── Metadata ────────────────────────────────────────────────────
    case 'ADD_METADATA_ENTRY':
      return produce(state, (draft) => {
        draft.metadata.customEntries.push({ key: '', value: '' });
      });

    case 'REMOVE_METADATA_ENTRY':
      return produce(state, (draft) => {
        draft.metadata.customEntries.splice(action.index, 1);
      });

    case 'UPDATE_METADATA_ENTRY':
      return produce(state, (draft) => {
        const entry = draft.metadata.customEntries[action.index];
        if (!entry) return;
        if (action.key !== undefined) entry.key = action.key;
        if (action.value !== undefined) entry.value = action.value;
      });

    case 'UPDATE_METADATA_CONFIG':
      return produce(state, (draft) => {
        Object.assign(draft.metadata, action.changes);
      });

    // ─── Write ───────────────────────────────────────────────────────
    case 'UPDATE_WRITE':
      return produce(state, (draft) => {
        Object.assign(draft.write, action.changes);
      });

    default:
      return state;
  }
}

interface AppStateContextValue {
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
  /**
   * Switches the active data model. Unlike dispatching SET_DATA_MODEL
   * directly (which is now a pure, storage-free reducer case — SW-4), this
   * wrapper performs the actual model-switch sequence: save the OUTGOING
   * model's current state, load the INCOMING model's persisted state (or its
   * default), force `dataModel` to the incoming model on whichever state was
   * resolved, record the incoming model as the active one (SW-5), then
   * dispatch a single REPLACE_STATE with the fully-resolved state. This is
   * the only caller that should ever dispatch REPLACE_STATE.
   */
  switchDataModel: (model: AppState['dataModel']) => void;
}

const AppStateContext = createContext<AppStateContextValue | null>(null);

function getInitialState(): AppState {
  // SW-5: restore whichever model was last active, not always the default
  // model's slot.
  const activeModel = loadActiveModel() ?? DEFAULT_STATE.dataModel;
  const loaded = loadState(activeModel);
  if (loaded) return loaded;
  return activeModel === DEFAULT_STATE.dataModel
    ? DEFAULT_STATE
    : { ...DEFAULT_STATE, dataModel: activeModel };
}

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, getInitialState);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // switchDataModel needs the CURRENT state (to save the outgoing model's
  // data) without itself being recreated on every state change, so its
  // identity stays stable for consumers — a ref mirrors the latest state.
  const stateRef = useRef(state);
  stateRef.current = state;

  // Debounced save to localStorage
  useEffect(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      saveState(state);
    }, 500);
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    };
  }, [state]);

  // SW-9: the 500ms debounce above loses edits made in the final 500ms
  // before the tab closes (the timer is still pending when the page goes
  // away). Flush synchronously on `pagehide` — preferred over `beforeunload`
  // because it also reliably fires for bfcache navigations/backgrounding on
  // mobile Safari, where `beforeunload` is unreliable — and cancel the
  // pending debounce timer so we don't do a redundant/stale save afterward.
  // `stateRef` (already kept current for `switchDataModel`, above) gives the
  // listener the latest state without needing to be re-attached on every
  // state change.
  useEffect(() => {
    const flush = () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      saveState(stateRef.current);
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
    };
  }, []);

  const switchDataModel = useCallback(
    (model: AppState['dataModel']) => {
      const currentState = stateRef.current;
      if (model === currentState.dataModel) return;
      // Save the OUTGOING model's state before switching away from it.
      saveState(currentState);
      // Load the INCOMING model's persisted state, or fall back to defaults.
      const loaded = loadState(model);
      const nextState: AppState = loaded ?? { ...DEFAULT_STATE, dataModel: model };
      // The requested model always wins, regardless of what was persisted.
      nextState.dataModel = model;
      // SW-5: record the newly-active model so a fresh page load restores it.
      saveActiveModel(model);
      dispatch({ type: 'REPLACE_STATE', state: nextState });
    },
    [],
  );

  return createElement(
    AppStateContext.Provider,
    { value: { state, dispatch, switchDataModel } },
    children,
  );
}

export function useAppState(): AppStateContextValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) {
    throw new Error('useAppState must be used within an AppStateProvider');
  }
  return ctx;
}
