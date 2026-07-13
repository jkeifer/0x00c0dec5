import type { Variable, AppState } from '../types/state.ts';
import type { CodecStep } from '../types/codecs.ts';
import type { DatasetManifest } from './types.ts';
import type { DatasetRegistryEntry } from './registry.ts';
import { colors } from '../theme.ts';

/** Everything APPLY_DATASET writes into state, prebuilt outside the reducer
 * (the manifest fetch is async; the reducer stays pure — loadPreset pattern). */
export interface DatasetApplication {
  dataset: { id: string; attribution: string };
  shape: number[];
  chunkShape: number[];
  interleaving?: AppState['interleaving'];
  linearization?: AppState['linearization'];
  variables: Variable[];
  fieldPipelines: Record<string, CodecStep[]>;
  chunkPipeline: CodecStep[];
  customEntries: { key: string; value: string }[];
}

export function buildDatasetApplication(
  entry: DatasetRegistryEntry,
  manifest: DatasetManifest,
): DatasetApplication {
  const variables: Variable[] = manifest.variables.map((mv, i) => ({
    id: `${manifest.id}-${mv.name}`,
    name: mv.name,
    logicalType: mv.logicalType,
    typeAssignment: entry.curated.typeAssignments[mv.name]
      ?? (mv.kind === 'number' ? { storageDtype: mv.dtype } : { storageDtype: 'char16' }),
    color: colors.palette[i % colors.palette.length],
  }));

  const fieldPipelines: Record<string, CodecStep[]> = {};
  for (const v of variables) {
    fieldPipelines[v.id] = entry.curated.fieldPipelines[v.name] ?? [];
  }

  const att = manifest.attribution;
  return {
    dataset: { id: manifest.id, attribution: `${att.source} · ${att.license}` },
    shape: [...manifest.shape],
    chunkShape: entry.curated.chunkShape.map((c, d) => Math.min(c, manifest.shape[d] ?? c)),
    interleaving: entry.curated.interleaving,
    linearization: entry.curated.linearization,
    variables,
    fieldPipelines,
    chunkPipeline: entry.curated.chunkPipeline ?? [],
    customEntries: [
      { key: 'source', value: att.source },
      { key: 'source_url', value: att.source_url },
      { key: 'retrieved', value: att.retrieved },
      { key: 'license', value: att.license },
    ],
  };
}
