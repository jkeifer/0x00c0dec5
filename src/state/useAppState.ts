import {
  createContext,
  useContext,
  useReducer,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  type ReactNode,
  createElement,
} from 'react';
import { produce } from 'immer';
import { DEFAULT_STATE, makeEmptyState, reconcileChunkShape, isDatasetVariable, type AppState, type Variable } from '../types/state.ts';
import type { CodecStep } from '../types/codecs.ts';
import { loadState, saveState, loadActiveModel, saveActiveModel } from './persistence.ts';
import { type PresetKey, resolvePreset, saveCustomPreset, loadCustomPreset } from './presets.ts';
import { consumeShareHash, loadCheckpoint } from './share.ts';
import { datasetById, loadManifest } from '../datasets/registry.ts';
import { buildDatasetApplication, removeUnmodifiedSeeded, type DatasetApplication } from '../datasets/apply.ts';

export type AppAction =
  // SET_DATA_MODEL only sets `state.dataModel` — it is intentionally pure
  // (SW-4). The storage I/O that used to live inside this case (save the
  // outgoing model, load/default the incoming one) now lives in the
  // `switchDataModel` wrapper exposed by `useAppState()`, which dispatches
  // REPLACE_STATE with the fully-resolved state instead. Nothing should
  // dispatch SET_DATA_MODEL directly except that wrapper.
  | { type: 'SET_DATA_MODEL'; model: AppState['dataModel'] }
  // REPLACE_STATE swaps in a full AppState wholesale — the one remaining
  // "replace everything" escape hatch now that LOAD_STATE (never dispatched)
  // is deleted (SW-8). Dispatched only by the AppStateProvider wrappers that
  // resolve a full state out-of-band: switchDataModel, loadPreset,
  // restoreCheckpoint, and clearConfig.
  | { type: 'REPLACE_STATE'; state: AppState }
  // Schema
  | { type: 'SET_SHAPE'; shape: number[] }
  | { type: 'ADD_VARIABLE'; variable: Variable }
  | { type: 'REMOVE_VARIABLE'; id: string }
  | { type: 'UPDATE_VARIABLE'; id: string; changes: Partial<Pick<Variable, 'name' | 'logicalType' | 'typeAssignment' | 'color'>> }
  // Chunk
  | { type: 'SET_CHUNK_SHAPE'; chunkShape: number[] }
  // Interleave
  | { type: 'SET_INTERLEAVING'; interleaving: 'row' | 'column' }
  // Linearization order (cl-6)
  | { type: 'SET_LINEARIZATION'; linearization: AppState['linearization'] }
  // Byte order (cl-8)
  | { type: 'SET_BYTE_ORDER'; byteOrder: AppState['byteOrder'] }
  // Codecs
  | { type: 'SET_FIELD_PIPELINE'; variableId: string; steps: CodecStep[] }
  | { type: 'SET_CHUNK_PIPELINE'; steps: CodecStep[] }
  // Metadata (customEntries CRUD keeps its index-based shape; everything else
  // in AppState['metadata'] is a patch action, per task 3.7)
  | { type: 'ADD_METADATA_ENTRY' }
  | { type: 'REMOVE_METADATA_ENTRY'; index: number }
  | { type: 'UPDATE_METADATA_ENTRY'; index: number; key?: string; value?: string }
  | { type: 'UPDATE_METADATA_CONFIG'; changes: Partial<Pick<AppState['metadata'], 'serialization' | 'include'>> }
  // Write — one patch action replaces the six SET_WRITE_* setters
  | { type: 'UPDATE_WRITE'; changes: Partial<AppState['write']> }
  // UI — one patch action replaces the pane stage/view setters and SET_SHOW_DIFF
  | { type: 'UPDATE_UI'; changes: Partial<AppState['ui']> }
  // Dataset presets (real data): apply a prebuilt application (manifest was
  // fetched in the applyDataset wrapper; reducer stays pure), or return to
  // generated values keeping the schema as a starting point.
  | { type: 'APPLY_DATASET'; application: DatasetApplication }
  | { type: 'SET_DATASET_CUSTOM' };

/**
 * Actions fully blocked while a dataset is active: the schema lock. The
 * dataset owns SHAPE (from its manifest), so SET_SHAPE is a no-op until the
 * user deselects. ADD_VARIABLE/REMOVE_VARIABLE are NO LONGER locked (Task 5):
 * users compose custom, generated variables alongside the dataset's real ones,
 * and may remove any variable (re-applying the dataset restores its full set).
 * UPDATE_VARIABLE is also not here — it has a per-field lock (name/logicalType
 * frozen only on dataset-backed rows, via isDatasetVariable), enforced in its
 * own case below. Consulted once, at the top of the reducer.
 */
const DATASET_LOCKED_ACTIONS = new Set<AppAction['type']>([
  'SET_SHAPE',
]);

export function reducer(state: AppState, action: AppAction): AppState {
  if (state.dataset && DATASET_LOCKED_ACTIONS.has(action.type)) return state;
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
    // (SET_SHAPE is dataset-locked at the top of the reducer via
    // DATASET_LOCKED_ACTIONS; ADD/REMOVE_VARIABLE stay editable while a
    // dataset is active — Task 5.)
    case 'SET_SHAPE': {
      const newShape = action.shape;
      if (newShape.length === 0 || newShape.some(d => d <= 0)) {
        return state;
      }
      return produce(state, (draft) => {
        draft.chunkShape = reconcileChunkShape(draft.chunkShape, newShape);
        draft.shape = newShape;
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
        // Schema lock is per-variable (Task 5): a dataset-backed variable's
        // name/logicalType come from the manifest and stay fixed;
        // custom variables the user added alongside the dataset are fully
        // editable. typeAssignment (storage/precision) is always a free knob.
        const locked = isDatasetVariable(draft.dataset?.id, v);
        if (action.changes.name !== undefined && !locked) v.name = action.changes.name;
        if (action.changes.logicalType !== undefined && !locked) v.logicalType = action.changes.logicalType;
        if (action.changes.typeAssignment !== undefined) v.typeAssignment = action.changes.typeAssignment;
        // color is display-only, not part of the manifest-defined schema — applies
        // unconditionally, even while a dataset locks name/logicalType.
        if (action.changes.color !== undefined) v.color = action.changes.color;
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

    case 'SET_LINEARIZATION':
      return produce(state, (draft) => {
        draft.linearization = action.linearization;
      });

    case 'SET_BYTE_ORDER':
      return produce(state, (draft) => {
        draft.byteOrder = action.byteOrder;
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

    // ─── Dataset presets ────────────────────────────────────────────
    // APPLY_DATASET sets SCHEMA + METADATA ONLY: shape, variables (new ids,
    // typeAssignment defaulted from the data's natural storage dtype), empty
    // fieldPipelines for the new ids, and appended provenance metadata. It
    // deliberately does NOT touch interleaving/linearization/byteOrder/
    // chunkPipeline/write — those belong to the top-level format presets.
    case 'APPLY_DATASET': {
      const a = action.application;
      return produce(state, (draft) => {
        // Re-applying while a dataset is active: strip the OUTGOING dataset's
        // still-unmodified seeded entries first, so provenance doesn't pile up.
        if (draft.dataset) {
          draft.metadata.customEntries = removeUnmodifiedSeeded(
            draft.metadata.customEntries,
            draft.dataset.seededEntries,
          );
        }
        draft.dataset = {
          id: a.datasetId,
          attribution: a.attribution,
          seededEntries: a.seededEntries,
        };
        draft.chunkShape = reconcileChunkShape(draft.chunkShape, a.shape);
        draft.shape = a.shape;
        draft.variables = a.variables;
        // Fresh empty pipelines for exactly the new variable ids (no stale keys).
        draft.fieldPipelines = {};
        for (const v of a.variables) draft.fieldPipelines[v.id] = [];
        // Append seeded provenance, preserving the user's own entries.
        draft.metadata.customEntries.push(...a.seededEntries);
      });
    }

    case 'SET_DATASET_CUSTOM':
      if (state.dataset === null) return state;
      return produce(state, (draft) => {
        // Remove only the seeded entries the user hasn't modified; entries
        // they edited (matched key but changed value) stay.
        draft.metadata.customEntries = removeUnmodifiedSeeded(
          draft.metadata.customEntries,
          draft.dataset!.seededEntries,
        );
        draft.dataset = null;
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
   * dispatch a single REPLACE_STATE with the fully-resolved state.
   */
  switchDataModel: (model: AppState['dataModel']) => void;
  /**
   * D10 (remediation-plan.md, Phase 6.2): load a built-in preset (or the
   * 'custom' restore slot) wholesale, per the Header dropdown. Mirrors
   * `switchDataModel`'s shape — resolve a full `AppState` out-of-band, force
   * the resolved `dataModel`, dispatch a single `REPLACE_STATE` — but with
   * its own snapshot step: loading any built-in preset first saves the
   * CURRENT state to its model's custom slot, so 'Custom (restore)' always
   * gets back to "what I had right before I loaded a preset" for the active
   * model. Presets and custom slots are model-scoped: the Header only offers
   * presets matching the active model, so loading one never switches models.
   * Loading 'custom' does NOT re-snapshot (that would overwrite the very
   * thing being restored). Per D10, this never touches the
   * `0x00c0dec5-state-{tabular,array}` keys (those are only written via the
   * debounced autosave / `switchDataModel`).
   */
  loadPreset: (key: PresetKey | 'custom') => void;
  /**
   * Task 6.4 (remediation-plan.md, Phase 6): restore the single checkpoint
   * slot. Mirrors `loadPreset('custom')`'s shape — resolve a full `AppState`
   * out-of-band via `loadCheckpoint` (already routed through
   * `validateExternalState`), force/record the resolved `dataModel` exactly
   * like switching data models does, then dispatch one `REPLACE_STATE`.
   * Unlike the preset custom slot, restoring does NOT clear or re-snapshot
   * the checkpoint — it's meant to be restored repeatedly during a live
   * talk. A no-op (does not dispatch) if no checkpoint exists or it fails
   * validation.
   */
  restoreCheckpoint: () => void;
  /**
   * Clear the ACTIVE data model's configuration to a *blank* state (zero
   * variables — `makeEmptyState`, not DEFAULT_STATE's starter variables).
   * Mirrors `restoreCheckpoint`'s shape: resolve a full `AppState`
   * out-of-band, persist it immediately via `saveState` (so the clear isn't
   * lost if the debounced autosave hasn't fired before a reload), then
   * dispatch one `REPLACE_STATE`. Scoped strictly to the active model: only
   * `0x00c0dec5-state-{activeModel}` is written; the other model's state,
   * the checkpoint, and the custom-preset slots are untouched.
   */
  clearConfig: () => void;
  /**
   * Fetch a dataset preset's manifest and apply it as the active schema.
   * Mirrors `loadPreset`'s snapshot step: the current state is saved to the
   * active model's custom slot FIRST (so 'Custom (restore)' can get back to
   * "what I had right before I applied a dataset"), then a single
   * `APPLY_DATASET` is dispatched with the prebuilt `DatasetApplication` (the
   * reducer itself stays pure — the fetch happens here). Returns `false`
   * without dispatching if the id is unknown, its data model doesn't match
   * the active model, or the manifest fetch fails.
   */
  applyDataset: (id: string) => Promise<boolean>;
  /**
   * Return to generated values (Custom), keeping the current schema/pipelines
   * as a starting point rather than restoring anything — see `SET_DATASET_CUSTOM`.
   */
  selectCustomDataset: () => void;
}

const AppStateContext = createContext<AppStateContextValue | null>(null);

function getInitialState(): AppState {
  // Task 6.5 (remediation-plan.md, Phase 6): a `#s=` share-state hash in the
  // URL wins over everything else, including localStorage — it's the
  // presenter's explicit "load exactly this" link. `consumeShareHash`
  // strips the hash unconditionally (success or failure) so a later reload
  // falls through to the normal load instead of resurrecting stale shared
  // state from the address bar.
  const shared = consumeShareHash();
  if (shared) {
    saveActiveModel(shared.dataModel);
    return shared;
  }

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
  // Mirror after commit (a render-time ref write violates rules-of-react /
  // the react compiler lint). useLayoutEffect, not useEffect: it runs
  // synchronously in the commit task, so the SW-9 pagehide flush (below,
  // reads stateRef) can never observe a committed state the mirror hasn't
  // caught up with — passive effects could be deferred past a pagehide.
  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);

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

  const loadPreset = useCallback(
    (key: PresetKey | 'custom') => {
      const currentState = stateRef.current;

      if (key === 'custom') {
        // Restore the ACTIVE model's snapshot taken before its most recent
        // preset load (custom slots are per-model now that presets are
        // model-scoped). Deliberately does NOT re-snapshot currentState —
        // that would overwrite the very thing being restored.
        const restored = loadCustomPreset(currentState.dataModel);
        if (!restored) {
          // Part C: the user actively picked 'Custom (restore)'; a silent
          // no-op is confusing. Name why nothing happened.
          console.error(`loadPreset('custom'): no valid custom snapshot for model '${currentState.dataModel}' — nothing to restore`);
          return;
        }
        dispatch({ type: 'REPLACE_STATE', state: restored });
        return;
      }

      const preset = resolvePreset(key);
      if (!preset) {
        // Part C: surface the owner-reported "preset just doesn't load"
        // silent-failure path — resolvePreset returned null (validation
        // failed on the checked-in JSON, a preset-file bug).
        console.error(`loadPreset('${key}'): resolvePreset returned null — the preset's checked-in JSON failed validation`);
        return;
      }

      // D10: snapshot current state to its model's custom slot FIRST,
      // before replacing it. This never writes to the
      // `0x00c0dec5-state-{model}` keys, only to the custom-preset key, so
      // the model's own saved state (from the normal debounced autosave) is
      // left untouched. The Header only offers presets matching the active
      // model, so `preset.dataModel === currentState.dataModel` by
      // construction; `saveActiveModel` stays as a belt-and-suspenders for
      // any direct `loadPreset` caller.
      saveCustomPreset(currentState);

      saveActiveModel(preset.dataModel);
      dispatch({ type: 'REPLACE_STATE', state: preset });
    },
    [],
  );

  const restoreCheckpoint = useCallback(() => {
    // Task 6.4: handle a checkpoint saved from the OTHER dataModel exactly
    // like loadPreset('custom') handles a cross-model custom snapshot —
    // force the resolved state's dataModel to win and record it as active
    // (SW-5) so a fresh page load restores the same model, then persist
    // under that model's own key (mirrors switchDataModel's "save the
    // resolved state" behavior) so the restore isn't lost if the debounced
    // autosave hasn't fired yet before e.g. a demo reload.
    const restored = loadCheckpoint();
    if (!restored) {
      // Part C: the user clicked Restore; say why nothing happened.
      console.error('restoreCheckpoint: no valid checkpoint to restore (none saved, or it failed validation)');
      return;
    }
    saveActiveModel(restored.dataModel);
    saveState(restored);
    dispatch({ type: 'REPLACE_STATE', state: restored });
  }, []);

  const clearConfig = useCallback(() => {
    // See the AppStateContextValue doc comment: blank state for the ACTIVE
    // model only, saved immediately (mirrors restoreCheckpoint) so the clear
    // survives an immediate reload.
    const empty = makeEmptyState(stateRef.current.dataModel);
    saveState(empty);
    dispatch({ type: 'REPLACE_STATE', state: empty });
  }, []);

  const applyDataset = useCallback(async (id: string): Promise<boolean> => {
    const entry = datasetById(id);
    if (!entry || entry.dataModel !== stateRef.current.dataModel) return false;
    try {
      const manifest = await loadManifest(entry.id);
      // Same snapshot contract as loadPreset: the pre-apply state is
      // recoverable via 'Custom (restore)'.
      saveCustomPreset(stateRef.current);
      dispatch({ type: 'APPLY_DATASET', application: buildDatasetApplication(manifest) });
      return true;
    } catch {
      return false;
    }
  }, []);

  const selectCustomDataset = useCallback(() => {
    dispatch({ type: 'SET_DATASET_CUSTOM' });
  }, []);

  return createElement(
    AppStateContext.Provider,
    // eslint-disable-next-line react-hooks/refs -- conservative compiler heuristic: the callbacks close over stateRef (useEvent-style stable identity) but only ever read it in event handlers, never during render
    { value: { state, dispatch, switchDataModel, loadPreset, restoreCheckpoint, clearConfig, applyDataset, selectCustomDataset } },
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
