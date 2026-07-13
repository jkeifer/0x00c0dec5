import type { AppState } from '../types/state.ts';
import type { DatasetId, DatasetManifest } from './types.ts';
import { validateManifest } from './assets.ts';

/**
 * A dataset preset now supplies only its identity, label, and data model.
 * Applying one sets SCHEMA + METADATA only (see `buildDatasetApplication`);
 * the curated pipeline/chunking/interleaving configs that used to live here
 * moved into the top-level format presets (src/presets/*.json), which carry a
 * `dataset` ref of their own.
 */
export interface DatasetRegistryEntry {
  id: DatasetId;
  label: string;
  dataModel: AppState['dataModel'];
}

/** Asset base. Dev: the vite middleware serving data-branch-work/ with a
 * tests/fixtures fallback (see vite.config.ts). Prod: the orphan `data`
 * branch via raw.githubusercontent (CORS `*`), pushed by hand. */
export const DATASET_BASE = import.meta.env.DEV
  ? `${import.meta.env.BASE_URL}data-dev/`
  : 'https://raw.githubusercontent.com/jkeifer/0x00c0dec5/data/';

export function datasetUrl(id: DatasetId, file: string): string {
  return `${DATASET_BASE}datasets/${id}/${file}`;
}

export const DATASETS: DatasetRegistryEntry[] = [
  { id: 'etopo-dem', label: 'Terrain elevation (ETOPO)', dataModel: 'array' },
  { id: 'sst-field', label: 'Sea-surface temperature (MUR)', dataModel: 'array' },
  { id: 'ghcn-daily', label: 'Weather station daily (GHCN)', dataModel: 'tabular' },
];

export function datasetById(id: string): DatasetRegistryEntry | undefined {
  return DATASETS.find((d) => d.id === id);
}

/** Promise-cached manifest loader, shared by the main thread (apply) and the
 * worker (values). Failed loads evict so a transient network error is
 * retryable. */
const manifestCache = new Map<DatasetId, Promise<DatasetManifest>>();
export function loadManifest(id: DatasetId, fetchFn: typeof fetch = fetch): Promise<DatasetManifest> {
  let p = manifestCache.get(id);
  if (!p) {
    p = (async () => {
      const res = await fetchFn(datasetUrl(id, 'manifest.json'));
      if (!res.ok) throw new Error(`dataset manifest fetch failed (${res.status}) — ${datasetUrl(id, 'manifest.json')}`);
      return validateManifest(await res.json(), DATASETS.map((d) => d.id));
    })();
    p.catch(() => manifestCache.delete(id));
    manifestCache.set(id, p);
  }
  return p;
}
