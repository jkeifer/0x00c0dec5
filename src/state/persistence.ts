import type { AppState, Variable, LogicalTypeConfig, TypeAssignment } from '../types/state.ts';
import { DEFAULT_STATE } from '../types/state.ts';
import type { DtypeKey } from '../types/dtypes.ts';
import { getDtype, DTYPE_KEYS } from '../types/dtypes.ts';
import type { CodecStep } from '../types/codecs.ts';

const STORAGE_KEYS: Record<AppState['dataModel'], string> = {
  tabular: '0x00c0dec5-state-tabular',
  array: '0x00c0dec5-state-array',
};

/** Number of stages in the pipeline strip; valid pane-stage indices are 0..STAGE_COUNT-1. */
const STAGE_COUNT = 7;

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
            ? { type: 'decimal', min: -50, max: 50, decimalPlaces: 1 }
            : { type: 'integer', min: dtypeInfo.min, max: dtypeInfo.max };
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

/**
 * Validate structural invariants on an already-merged state, dropping/clamping/resetting
 * anything malformed. Mutates and returns `state` in place.
 */
function validateState(state: AppState): AppState {
  // variables: drop invalid entries
  if (!Array.isArray(state.variables)) {
    state.variables = DEFAULT_STATE.variables;
  } else {
    state.variables = state.variables.filter(isValidVariable);
  }

  // shape: must be an array of positive integers, else fall back to defaults entirely
  if (!isPositiveIntArray(state.shape)) {
    return { ...DEFAULT_STATE, dataModel: state.dataModel };
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

  // ui.leftPaneStage / ui.rightPaneStage: integers within stage range; rightPaneStage also
  // allows the -1 sentinel.
  if (
    typeof state.ui.leftPaneStage !== 'number' ||
    !Number.isInteger(state.ui.leftPaneStage) ||
    state.ui.leftPaneStage < 0 ||
    state.ui.leftPaneStage >= STAGE_COUNT
  ) {
    state.ui.leftPaneStage = DEFAULT_STATE.ui.leftPaneStage;
  }
  if (
    typeof state.ui.rightPaneStage !== 'number' ||
    !Number.isInteger(state.ui.rightPaneStage) ||
    (state.ui.rightPaneStage !== -1 &&
      (state.ui.rightPaneStage < 0 || state.ui.rightPaneStage >= STAGE_COUNT))
  ) {
    state.ui.rightPaneStage = DEFAULT_STATE.ui.rightPaneStage;
  }

  // fieldPipelines: object of arrays
  if (!isPlainObject(state.fieldPipelines)) {
    state.fieldPipelines = {};
  } else {
    const cleaned: Record<string, CodecStep[]> = {};
    for (const [key, val] of Object.entries(state.fieldPipelines)) {
      cleaned[key] = Array.isArray(val) ? val : [];
    }
    state.fieldPipelines = cleaned;
  }

  // chunkPipeline: array
  if (!Array.isArray(state.chunkPipeline)) {
    state.chunkPipeline = [];
  }

  return state;
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

    if (!isPlainObject(parsed)) return null;

    const migrated = migrateState(parsed);
    if (migrated === null) return null;
    if (!isPlainObject(migrated)) return null;

    const merged = deepMergeDefaults(DEFAULT_STATE, migrated, TOP_LEVEL_DICT_KEYS);
    const validated = validateState(merged);

    // The requested model always wins, regardless of what was persisted.
    validated.dataModel = model;

    return validated;
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
