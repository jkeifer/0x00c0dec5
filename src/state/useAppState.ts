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
import { DEFAULT_STATE, type AppState } from '../types/state.ts';
import { loadState, saveState } from './persistence.ts';

export type AppAction =
  | { type: 'SET_DATA_MODEL'; model: AppState['dataModel'] }
  | { type: 'SET_LEFT_PANE_STAGE'; stage: number }
  | { type: 'SET_RIGHT_PANE_STAGE'; stage: number }
  | { type: 'SET_LEFT_PANE_VIEW'; view: string }
  | { type: 'SET_RIGHT_PANE_VIEW'; view: string }
  | { type: 'LOAD_STATE'; state: AppState };

function reducer(state: AppState, action: AppAction): AppState {
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
