import type { AppState, Variable, LogicalTypeConfig, TypeAssignment } from '../types/state.ts';
import type { DtypeKey } from '../types/dtypes.ts';
import { getDtype } from '../types/dtypes.ts';

const STORAGE_KEYS: Record<AppState['dataModel'], string> = {
  tabular: '0x00c0dec5-state-tabular',
  array: '0x00c0dec5-state-array',
};

/** Migrate old state format (v1: Variable with dtype) to new format (v2: logicalType + typeAssignment). */
function migrateState(raw: Record<string, unknown>): AppState | null {
  try {
    const state = raw as unknown as AppState;

    // Check if migration is needed: look for old-format variables with `dtype` and no `logicalType`
    if (state.variables && state.variables.length > 0) {
      const firstVar = state.variables[0] as unknown as Record<string, unknown>;
      if ('dtype' in firstVar && !('logicalType' in firstVar)) {
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

export function loadState(model: AppState['dataModel']): AppState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS[model]);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return migrateState(parsed);
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
