import {
  createContext,
  useContext,
  useReducer,
  useEffect,
  useRef,
  type ReactNode,
  createElement,
} from 'react';
import { produce } from 'immer';
import { DEFAULT_STATE, type AppState, type Variable } from '../types/state.ts';
import type { CodecStep } from '../types/codecs.ts';
import { loadState, saveState } from './persistence.ts';

export type AppAction =
  | { type: 'SET_DATA_MODEL'; model: AppState['dataModel'] }
  | { type: 'SET_LEFT_PANE_STAGE'; stage: number }
  | { type: 'SET_RIGHT_PANE_STAGE'; stage: number }
  | { type: 'SET_LEFT_PANE_VIEW'; view: string }
  | { type: 'SET_RIGHT_PANE_VIEW'; view: string }
  | { type: 'LOAD_STATE'; state: AppState }
  // Schema
  | { type: 'SET_SHAPE'; shape: number[] }
  | { type: 'ADD_VARIABLE'; variable: Variable }
  | { type: 'REMOVE_VARIABLE'; id: string }
  | { type: 'UPDATE_VARIABLE'; id: string; changes: Partial<Pick<Variable, 'name' | 'dtype'>> }
  // Chunk
  | { type: 'SET_CHUNK_SHAPE'; chunkShape: number[] }
  // Interleave
  | { type: 'SET_INTERLEAVING'; interleaving: 'row' | 'column' }
  // Codecs
  | { type: 'SET_FIELD_PIPELINE'; variableName: string; steps: CodecStep[] }
  | { type: 'SET_CHUNK_PIPELINE'; steps: CodecStep[] }
  // Metadata
  | { type: 'SET_METADATA_SERIALIZATION'; serialization: 'json' | 'binary' }
  | { type: 'ADD_METADATA_ENTRY' }
  | { type: 'REMOVE_METADATA_ENTRY'; index: number }
  | { type: 'UPDATE_METADATA_ENTRY'; index: number; key?: string; value?: string }
  // Write
  | { type: 'SET_WRITE_MAGIC'; magicNumber: string }
  | { type: 'SET_WRITE_PARTITIONING'; partitioning: 'single' | 'per-chunk' }
  | { type: 'SET_WRITE_METADATA_PLACEMENT'; metadataPlacement: 'header' | 'footer' | 'sidecar' }
  | { type: 'SET_WRITE_CHUNK_ORDER'; chunkOrder: 'row-major' | 'column-major' };

export function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_DATA_MODEL': {
      if (action.model === state.dataModel) return state;
      // Save current state before switching
      saveState(state);
      // Load the other model's state, or fall back to default
      const loaded = loadState(action.model);
      if (loaded) return loaded;
      return { ...DEFAULT_STATE, dataModel: action.model };
    }

    case 'SET_LEFT_PANE_STAGE':
      return produce(state, (draft) => {
        draft.ui.leftPaneStage = action.stage;
      });

    case 'SET_RIGHT_PANE_STAGE':
      return produce(state, (draft) => {
        draft.ui.rightPaneStage = action.stage;
      });

    case 'SET_LEFT_PANE_VIEW':
      return produce(state, (draft) => {
        draft.ui.leftPaneView = action.view;
      });

    case 'SET_RIGHT_PANE_VIEW':
      return produce(state, (draft) => {
        draft.ui.rightPaneView = action.view;
      });

    case 'LOAD_STATE':
      return action.state;

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
        draft.fieldPipelines[action.variable.name] = [];
      });

    case 'REMOVE_VARIABLE':
      return produce(state, (draft) => {
        const idx = draft.variables.findIndex((v) => v.id === action.id);
        if (idx === -1) return;
        const name = draft.variables[idx].name;
        draft.variables.splice(idx, 1);
        delete draft.fieldPipelines[name];
      });

    case 'UPDATE_VARIABLE':
      return produce(state, (draft) => {
        const v = draft.variables.find((v) => v.id === action.id);
        if (!v) return;
        const oldName = v.name;
        if (action.changes.name !== undefined) v.name = action.changes.name;
        if (action.changes.dtype !== undefined) v.dtype = action.changes.dtype;
        // Re-key fieldPipelines if name changed
        if (action.changes.name !== undefined && action.changes.name !== oldName) {
          const pipeline = draft.fieldPipelines[oldName] ?? [];
          delete draft.fieldPipelines[oldName];
          draft.fieldPipelines[action.changes.name] = pipeline;
        }
      });

    // ─── Chunk ───────────────────────────────────────────────────────
    case 'SET_CHUNK_SHAPE':
      return produce(state, (draft) => {
        draft.chunkShape = action.chunkShape;
      });

    // ─── Interleave ──────────────────────────────────────────────────
    case 'SET_INTERLEAVING':
      return produce(state, (draft) => {
        draft.interleaving = action.interleaving;
      });

    // ─── Codecs ──────────────────────────────────────────────────────
    case 'SET_FIELD_PIPELINE':
      return produce(state, (draft) => {
        draft.fieldPipelines[action.variableName] = action.steps;
      });

    case 'SET_CHUNK_PIPELINE':
      return produce(state, (draft) => {
        draft.chunkPipeline = action.steps;
      });

    // ─── Metadata ────────────────────────────────────────────────────
    case 'SET_METADATA_SERIALIZATION':
      return produce(state, (draft) => {
        draft.metadata.serialization = action.serialization;
      });

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

    // ─── Write ───────────────────────────────────────────────────────
    case 'SET_WRITE_MAGIC':
      return produce(state, (draft) => {
        draft.write.magicNumber = action.magicNumber;
      });

    case 'SET_WRITE_PARTITIONING':
      return produce(state, (draft) => {
        draft.write.partitioning = action.partitioning;
      });

    case 'SET_WRITE_METADATA_PLACEMENT':
      return produce(state, (draft) => {
        draft.write.metadataPlacement = action.metadataPlacement;
      });

    case 'SET_WRITE_CHUNK_ORDER':
      return produce(state, (draft) => {
        draft.write.chunkOrder = action.chunkOrder;
      });

    default:
      return state;
  }
}

interface AppStateContextValue {
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
}

const AppStateContext = createContext<AppStateContextValue | null>(null);

function getInitialState(): AppState {
  const loaded = loadState(DEFAULT_STATE.dataModel);
  return loaded ?? DEFAULT_STATE;
}

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, getInitialState);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  return createElement(
    AppStateContext.Provider,
    { value: { state, dispatch } },
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
