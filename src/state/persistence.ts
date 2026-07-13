import type { AppState, Variable, LogicalTypeConfig, TypeAssignment } from '../types/state.ts';
import { DEFAULT_STATE } from '../types/state.ts';
import type { DtypeKey } from '../types/dtypes.ts';
import { getDtype, DTYPE_KEYS, isCharDtype } from '../types/dtypes.ts';
import type { CodecStep } from '../types/codecs.ts';
import type { StageName } from '../types/pipeline.ts';
import { STAGE_ORDER } from '../types/pipeline.ts';
import { datasetById } from '../datasets/registry.ts';

const STORAGE_KEYS: Record<AppState['dataModel'], string> = {
  tabular: '0x00c0dec5-state-tabular',
  array: '0x00c0dec5-state-array',
};

/**
 * Third storage key (SW-5, Phase 3.7): records which data model was last
 * active, independent of either model's own per-model state key, so a fresh
 * page load can restore the model the user was actually looking at rather
 * than always defaulting to `DEFAULT_STATE.dataModel` (tabular).
 */
const ACTIVE_MODEL_KEY = '0x00c0dec5-active-model';

/** Read the last-active data model, or `null` if none is recorded / the
 * stored value isn't a recognized model. */
export function loadActiveModel(): AppState['dataModel'] | null {
  try {
    const raw = localStorage.getItem(ACTIVE_MODEL_KEY);
    if (raw === 'tabular' || raw === 'array') return raw;
    return null;
  } catch {
    return null;
  }
}

/** Record the currently-active data model. */
export function saveActiveModel(model: AppState['dataModel']): void {
  try {
    localStorage.setItem(ACTIVE_MODEL_KEY, model);
  } catch {
    // silently fail on storage errors
  }
}

/**
 * Migrate a persisted pane-stage value to a `StageName` (D5, Phase 3.8).
 * Old saves stored a numeric index into the (fixed, but previously
 * index-identified) stage list; the old `-1` sentinel meant "default to
 * Write" (the original intent behind SW-2's now-removed workaround).
 * Anything else invalid/out-of-range/unrecognized falls back to `fallback`.
 */
function migratePaneStage(value: unknown, fallback: StageName): StageName {
  if (typeof value === 'string' && (STAGE_ORDER as string[]).includes(value)) {
    return value as StageName;
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    if (value === -1) return 'write';
    if (value >= 0 && value < STAGE_ORDER.length) return STAGE_ORDER[value];
  }
  return fallback;
}

/** Migrate old state format (v1: Variable with dtype) to new format (v2: logicalType + typeAssignment). */
function migrateState(raw: Record<string, unknown>): AppState | null {
  try {
    const state = raw as unknown as AppState;

    // Check if migration is needed: look for old-format variables with `dtype` and no `logicalType`
    if (Array.isArray(state.variables) && state.variables.length > 0) {
      const firstVar = state.variables[0] as unknown as Record<string, unknown>;
      if (isPlainObject(firstVar) && 'dtype' in firstVar && !('logicalType' in firstVar)) {
        // Old format: migrate
        state.variables = (state.variables as unknown as Array<Record<string, unknown>>).map((oldVar) => {
          const dtype = (oldVar.dtype ?? 'float32') as DtypeKey;
          const dtypeInfo = getDtype(dtype);
          const logicalType: LogicalTypeConfig = dtypeInfo.float
            ? { type: 'decimal', min: -50, max: 50, decimalPlaces: 1, generation: 'random' }
            : { type: 'integer', min: dtypeInfo.min, max: dtypeInfo.max, generation: 'random' };
          const typeAssignment: TypeAssignment = { storageDtype: dtype };

          return {
            id: oldVar.id as string,
            name: oldVar.name as string,
            color: oldVar.color as string,
            logicalType,
            typeAssignment,
          } as Variable;
        });

        // Strip scale-offset and bitround from field pipelines
        if (state.fieldPipelines) {
          for (const key of Object.keys(state.fieldPipelines)) {
            state.fieldPipelines[key] = (state.fieldPipelines[key] ?? []).filter(
              (step) => step.codec !== 'scale-offset' && step.codec !== 'bitround',
            );
          }
        }

        // Strip from chunk pipeline
        if (state.chunkPipeline) {
          state.chunkPipeline = state.chunkPipeline.filter(
            (step) => step.codec !== 'scale-offset' && step.codec !== 'bitround',
          );
        }
      }
    }

    // Read plan Task 1: legacy `metadata.includeChunkIndex` -> `metadata.include`.
    // A save with `metadata` but no `include` yet is pre-migration: synthesize
    // `include` with every group defaulting true, honoring a legacy
    // `includeChunkIndex: false` for the `chunkIndex` key specifically, then
    // drop the legacy field. (Any group still missing after this — e.g. a
    // save with `metadata` omitted entirely — is filled by the default-merge
    // pass that runs after migrateState.)
    if (isPlainObject(state.metadata) && !('include' in state.metadata)) {
      const legacyMeta = state.metadata as unknown as Record<string, unknown>;
      const legacyChunkIndex = legacyMeta.includeChunkIndex;
      (state.metadata as unknown as Record<string, unknown>).include = {
        schema: true,
        layout: true,
        codecs: true,
        chunkIndex: legacyChunkIndex === false ? false : true,
        descriptive: true,
      };
      delete legacyMeta.includeChunkIndex;
    }

    return state;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively merge `source` over `defaults`: any field missing (or `undefined`) in `source`
 * at any level falls back to the corresponding value in `defaults`. Arrays and primitives in
 * `source` win outright (not merged element-wise) when present. `dictKeys` names fields at this
 * level that are open-ended string-keyed records (e.g. `fieldPipelines`) rather than fixed
 * shapes — for those, all of the source's own keys are kept (not just the ones present in
 * defaults), since defaults typically only seeds a handful of starter keys.
 */
function deepMergeDefaults<T>(defaults: T, source: unknown, dictKeys: readonly string[] = []): T {
  if (!isPlainObject(defaults)) {
    // Primitive/array default: use source if present, else default.
    return (source === undefined ? defaults : (source as T));
  }
  if (!isPlainObject(source)) {
    return defaults;
  }
  const result: Record<string, unknown> = { ...defaults };
  for (const key of Object.keys(defaults)) {
    const defaultVal = (defaults as Record<string, unknown>)[key];
    const sourceVal = source[key];
    if (dictKeys.includes(key)) {
      // Open-ended record: keep the source's own keys verbatim when the key is present at
      // all (even if malformed) so validateState can decide how to clean it up; only fall
      // back to the default when the key is missing entirely.
      result[key] = sourceVal === undefined ? defaultVal : sourceVal;
    } else if (Array.isArray(defaultVal)) {
      result[key] = sourceVal === undefined ? defaultVal : sourceVal;
    } else if (isPlainObject(defaultVal)) {
      result[key] = deepMergeDefaults(defaultVal, sourceVal);
    } else {
      result[key] = sourceVal === undefined ? defaultVal : sourceVal;
    }
  }
  return result as T;
}

/** Top-level AppState fields that are open-ended string-keyed dictionaries. */
const TOP_LEVEL_DICT_KEYS = ['fieldPipelines'] as const;

function isPositiveIntArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((d) => typeof d === 'number' && Number.isInteger(d) && d > 0)
  );
}

function isValidVariable(v: unknown): v is Variable {
  if (!isPlainObject(v)) return false;
  if (typeof v.id !== 'string' || typeof v.name !== 'string' || typeof v.color !== 'string') {
    return false;
  }
  if (!isPlainObject(v.logicalType)) return false;
  if (!isPlainObject(v.typeAssignment)) return false;
  const storageDtype = v.typeAssignment.storageDtype;
  if (typeof storageDtype !== 'string' || !DTYPE_KEYS.includes(storageDtype as DtypeKey)) {
    return false;
  }
  return true;
}

const GENERATION_MODES = new Set(['random', 'smooth', 'sorted', 'stepped']);

/**
 * D9 (remediation-plan.md, Phase 6.1) migration: persisted variables from
 * before generation modes existed have no `logicalType.generation` field
 * (and a corrupt/hand-edited save could have an invalid one). Rather than
 * rejecting the whole variable (isValidVariable intentionally doesn't check
 * this field), default it to `'random'` — the pre-D9 behavior — in place.
 */
function normalizeGeneration(variables: Variable[]): Variable[] {
  return variables.map((v) => {
    const generation = (v.logicalType as unknown as Record<string, unknown>).generation;
    if (typeof generation === 'string' && GENERATION_MODES.has(generation)) {
      return v;
    }
    return { ...v, logicalType: { ...v.logicalType, generation: 'random' as const } };
  });
}

const WORD_SET_KEYS = new Set(['names', 'cities', 'countries', 'stations']);

/**
 * Text-variable normalization (additive, no migration): a text variable from
 * a hand-edited or partial save gets `wordSet` defaulted to 'names', and a
 * non-char `storageDtype` coerced to 'char8' (the engine's text branches key
 * on `isCharDtype(storageDtype)`, so a text variable with numeric storage
 * would silently stringify numbers). Non-text variables pass through.
 */
function normalizeText(variables: Variable[]): Variable[] {
  return variables.map((v) => {
    if (v.logicalType.type !== 'text') return v;
    let out = v;
    const wordSet = (v.logicalType as unknown as Record<string, unknown>).wordSet;
    if (typeof wordSet !== 'string' || !WORD_SET_KEYS.has(wordSet)) {
      out = { ...out, logicalType: { ...out.logicalType, wordSet: 'names' as const } };
    }
    if (!isCharDtype(out.typeAssignment.storageDtype)) {
      out = { ...out, typeAssignment: { ...out.typeAssignment, storageDtype: 'char8' as const } };
    }
    return out;
  });
}

/**
 * Validate structural invariants on an already-merged state, dropping/clamping/resetting
 * anything malformed. Mutates and returns `state` in place.
 */
function validateState(state: AppState): AppState {
  // variables: drop invalid entries
  if (!Array.isArray(state.variables)) {
    state.variables = structuredClone(DEFAULT_STATE.variables);
  } else {
    state.variables = normalizeText(normalizeGeneration(state.variables.filter(isValidVariable)));
  }

  // shape: must be an array of positive integers, else fall back to defaults entirely
  if (!isPositiveIntArray(state.shape)) {
    return { ...structuredClone(DEFAULT_STATE), dataModel: state.dataModel };
  }

  // chunkShape: clamp/pad to shape's length and per-dimension max, mirroring SET_SHAPE
  if (!isPositiveIntArray(state.chunkShape)) {
    state.chunkShape = [...state.shape];
  } else {
    const shape = state.shape;
    const oldChunk = state.chunkShape;
    const newChunkShape: number[] = [];
    for (let d = 0; d < shape.length; d++) {
      if (d < oldChunk.length) {
        newChunkShape.push(Math.min(oldChunk[d], shape[d]));
      } else {
        newChunkShape.push(shape[d]);
      }
    }
    state.chunkShape = newChunkShape;
  }

  // ui.leftPaneStage / ui.rightPaneStage (D5, Phase 3.8): StageName, not a
  // numeric index. Old numeric saves (including the -1 sentinel) migrate via
  // STAGE_ORDER; anything else invalid/unrecognized falls back to the
  // appropriate default ('values' for left, 'write' for right).
  state.ui.leftPaneStage = migratePaneStage(state.ui.leftPaneStage, DEFAULT_STATE.ui.leftPaneStage);
  state.ui.rightPaneStage = migratePaneStage(state.ui.rightPaneStage, DEFAULT_STATE.ui.rightPaneStage);

  // fieldPipelines: object of arrays, keyed by Variable.id (D5, Phase 3.1).
  // Migrate legacy name-keyed saves: a key matching a variable's NAME (but not
  // any variable's id) is re-keyed to that variable's id; keys matching
  // neither a name nor an id are dropped (stale/orphaned entries).
  if (!isPlainObject(state.fieldPipelines)) {
    state.fieldPipelines = {};
  } else {
    const idSet = new Set(state.variables.map((v) => v.id));
    const nameToId = new Map(state.variables.map((v) => [v.name, v.id]));
    const cleaned: Record<string, CodecStep[]> = {};
    for (const [key, val] of Object.entries(state.fieldPipelines)) {
      const steps = Array.isArray(val) ? val : [];
      if (idSet.has(key)) {
        cleaned[key] = steps;
      } else if (nameToId.has(key)) {
        // Legacy name-keyed entry: re-key to the matching variable's id,
        // unless that id already has a (presumably newer/id-keyed) entry.
        const id = nameToId.get(key)!;
        if (!(id in cleaned)) {
          cleaned[id] = steps;
        }
      }
      // else: key matches neither an id nor a name — drop it.
    }
    state.fieldPipelines = cleaned;
  }

  // chunkPipeline: array
  if (!Array.isArray(state.chunkPipeline)) {
    state.chunkPipeline = [];
  }

  // Dataset presets: a persisted dataset ref must name a known dataset whose
  // model matches this state, else it degrades to generated (null) — same
  // graceful-degrade as every other field. (Values are never persisted; the
  // worker refetches by id.)
  const ds = state.dataset as unknown;
  if (
    !isPlainObject(ds) ||
    typeof ds.id !== 'string' ||
    typeof ds.attribution !== 'string' ||
    datasetById(ds.id)?.dataModel !== state.dataModel
  ) {
    state.dataset = null;
  }

  return state;
}

/**
 * Shared core of `loadState`/`validateExternalState`: migrate -> default-merge
 * -> structurally validate a raw parsed object, forcing `dataModel` to
 * `model` on the result. Returns `null` on anything unrecoverable.
 */
function loadFromRaw(parsed: unknown, model: AppState['dataModel']): AppState | null {
  if (!isPlainObject(parsed)) return null;

  const migrated = migrateState(parsed);
  if (migrated === null) return null;
  if (!isPlainObject(migrated)) return null;

  // Clone the defaults so nothing default-derived in the returned state aliases
  // DEFAULT_STATE's own arrays/objects — callers may mutate the loaded state.
  const merged = deepMergeDefaults(structuredClone(DEFAULT_STATE), migrated, TOP_LEVEL_DICT_KEYS);
  const validated = validateState(merged);

  // The requested model always wins, regardless of what was persisted.
  validated.dataModel = model;

  return validated;
}

export function loadState(model: AppState['dataModel']): AppState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS[model]);
    if (!raw) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }

    return loadFromRaw(parsed, model);
  } catch {
    return null;
  }
}

/**
 * D10 (remediation-plan.md, Phase 6.2): validate a raw external state object
 * (a built-in preset's parsed JSON, or any other out-of-band source) through
 * the exact same migrate -> default-merge -> validate pipeline `loadState`
 * uses for localStorage, rather than trusting the shape or duplicating the
 * checks. `model` is forced onto the result exactly as `loadState` forces
 * the requested storage-key model — this is what lets a preset switch data
 * models on load (e.g. loading a 2-D "Basically GeoTIFF" preset while the
 * app is on the tabular model): the caller passes the preset's own
 * `dataModel` (or any other explicit target) and gets that model back.
 * Returns `null` if `raw` isn't even a plain object, or if migration fails.
 */
export function validateExternalState(raw: unknown, model: AppState['dataModel']): AppState | null {
  try {
    return loadFromRaw(raw, model);
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
