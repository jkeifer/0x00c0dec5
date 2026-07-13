import type { AppState, LogicalTypeConfig } from '../types/state.ts';
import type { DatasetId, DatasetManifest, NumericBinDtype } from './types.ts';
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

/**
 * A single curated variable, statically copied from a dataset's manifest.
 * Static (not fetched) because the per-row source dropdown and the reducer
 * need name/logicalType/dtype synchronously; manifests are async. The
 * manifest stays the source of truth for the actual VALUES — this catalog is
 * pinned against the fixture manifests by tests/unit/datasets/catalog.test.ts
 * so it cannot drift silently. Keep this list in sync with
 * tests/fixtures/datasets/{id}/manifest.json (and the real data-branch
 * manifests, which the fixtures mirror) by hand.
 */
export interface CuratedVariable {
  datasetId: DatasetId;
  name: string;              // manifest variable name
  label: string;             // dropdown label, e.g. 'GHCN Daily › tmax'
  dataModel: AppState['dataModel'];
  kind: 'number' | 'string';
  dtype?: NumericBinDtype;   // numeric only — natural storage dtype
  logicalType: LogicalTypeConfig; // static copy of the manifest's
  attribution: string;       // short dataset-level attribution line for the row hint
}

function curated(
  datasetId: DatasetId,
  name: string,
  kind: 'number' | 'string',
  logicalType: LogicalTypeConfig,
  attribution: string,
  dtype?: NumericBinDtype,
): CuratedVariable {
  const dataset = datasetById(datasetId)!;
  return {
    datasetId, name, kind, logicalType, attribution, dtype,
    label: `${dataset.label} › ${name}`,
    dataModel: dataset.dataModel,
  };
}

export const CURATED_VARIABLES: CuratedVariable[] = [
  curated(
    'etopo-dem', 'elevation', 'number',
    { type: 'integer', min: 97, max: 178, generation: 'smooth' },
    'NOAA NCEI ETOPO Global Relief (via ERDDAP)',
    'int16',
  ),
  curated(
    'sst-field', 'sst', 'number',
    { type: 'continuous', min: 18, max: 22, significantFigures: 6, generation: 'smooth' },
    'JPL MUR SST v4.1 (via NOAA CoastWatch ERDDAP)',
    'float32',
  ),
  curated(
    'ghcn-daily', 'date', 'number',
    { type: 'integer', min: 20200101, max: 20200148, generation: 'sorted' },
    'NOAA NCEI GHCN-Daily (4 US stations)',
    'int32',
  ),
  curated(
    'ghcn-daily', 'tmax', 'number',
    { type: 'integer', min: 120, max: 180, generation: 'smooth' },
    'NOAA NCEI GHCN-Daily (4 US stations)',
    'int16',
  ),
  curated(
    'ghcn-daily', 'tmin', 'number',
    { type: 'integer', min: 20, max: 80, generation: 'smooth' },
    'NOAA NCEI GHCN-Daily (4 US stations)',
    'int16',
  ),
  curated(
    'ghcn-daily', 'prcp', 'number',
    { type: 'integer', min: 0, max: 25, generation: 'stepped' },
    'NOAA NCEI GHCN-Daily (4 US stations)',
    'int16',
  ),
  curated(
    'ghcn-daily', 'station', 'string',
    { type: 'text', min: 0, max: 0, wordSet: 'stations', generation: 'stepped' },
    'NOAA NCEI GHCN-Daily (4 US stations)',
  ),
];

/** Resolve a Variable.source ref to its catalog entry, or undefined if it
 * doesn't (or no longer) name a curated variable. */
export function curatedVariable(ref: { datasetId: DatasetId; variableName: string }): CuratedVariable | undefined {
  return CURATED_VARIABLES.find((c) => c.datasetId === ref.datasetId && c.name === ref.variableName);
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
