import type { Variable } from '../types/state.ts';
import type { DatasetManifest } from './types.ts';
import { colors } from '../theme.ts';

type SeededEntry = { key: string; value: string };

/**
 * Everything APPLY_DATASET needs, prebuilt outside the reducer (the manifest
 * fetch is async; the reducer stays pure — loadPreset pattern). SCHEMA +
 * METADATA ONLY: applying a dataset sets shape/variables/typeAssignments
 * (from the data's own natural storage dtype) and seeds provenance metadata.
 * It does NOT set interleaving, linearization, byteOrder, codecs, or write
 * config — those are the top-level format presets' job (which carry a
 * `dataset` ref of their own). `chunkShape` is reconciled to the new shape by
 * the reducer (it needs the current chunkShape).
 */
export interface DatasetApplication {
  datasetId: string;
  attribution: string;
  seededEntries: SeededEntry[];
  shape: number[];
  variables: Variable[];
}

/**
 * Remove from `customEntries` exactly the seeded entries the user hasn't
 * modified — matched on key AND value. An entry the user edited (or a
 * user-authored entry that coincidentally shares a seeded key) survives.
 * Only the first match per seeded entry is removed, so duplicate user entries
 * aren't over-culled.
 */
export function removeUnmodifiedSeeded(
  customEntries: SeededEntry[],
  seeded: SeededEntry[],
): SeededEntry[] {
  const remaining = [...customEntries];
  for (const s of seeded) {
    const i = remaining.findIndex((e) => e.key === s.key && e.value === s.value);
    if (i !== -1) remaining.splice(i, 1);
  }
  return remaining;
}

export function buildDatasetApplication(manifest: DatasetManifest): DatasetApplication {
  const variables: Variable[] = manifest.variables.map((mv, i) => ({
    // New id per apply so a re-apply never aliases a prior dataset's pipelines.
    id: `${manifest.id}-${mv.name}`,
    name: mv.name,
    logicalType: mv.logicalType,
    // The data's natural storage default — NOT curated tuning. Numbers keep
    // their extracted width; strings store as char16.
    typeAssignment: mv.kind === 'number'
      ? { storageDtype: mv.dtype }
      : { storageDtype: 'char16' },
    color: colors.palette[i % colors.palette.length],
  }));

  const att = manifest.attribution;
  const seededEntries: SeededEntry[] = [
    { key: 'source', value: att.source },
    { key: 'source_url', value: att.source_url },
    { key: 'retrieved', value: att.retrieved },
    { key: 'license', value: att.license },
  ];

  return {
    datasetId: manifest.id,
    attribution: `${att.source} · ${att.license}`,
    seededEntries,
    shape: [...manifest.shape],
    variables,
  };
}
