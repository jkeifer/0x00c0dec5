import type { AppState, LogicalTypeConfig } from '../types/state.ts';
import type { DatasetId, DatasetManifest, NumericBinDtype } from './types.ts';
import { validateManifest } from './assets.ts';

/**
 * A dataset is now just a catalog of curated variables (see CURATED_VARIABLES).
 * Its registry entry supplies only identity, label, and data model. Variables
 * bind to it per-row via `Variable.source`; presets (src/presets/*.json) do the
 * composing.
 */
export interface DatasetRegistryEntry {
  id: DatasetId;
  label: string;
  dataModel: AppState['dataModel'];
  /** The real data-branch manifest's shape — informational only (the fill
   * tiles/crops to whatever shape the schema has). Shown in the source hint
   * so "what size should I use?" has an answer. Mirrors data-branch-work/
   * datasets/{id}/manifest.json by hand (the test fixtures are deliberately
   * tiny and do NOT match). */
  naturalShape: number[];
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
  { id: 'etopo-dem', label: 'Terrain elevation (ETOPO)', dataModel: 'array', naturalShape: [1024, 1024] },
  { id: 'sst-field', label: 'Sea-surface temperature (MUR)', dataModel: 'array', naturalShape: [1024, 1024] },
  { id: 'ghcn-daily', label: 'Weather station daily (GHCN)', dataModel: 'tabular', naturalShape: [144769] },
  { id: 'copernicus-dem', label: 'Terrain elevation (Copernicus GLO-30)', dataModel: 'array', naturalShape: [1024, 1024] },
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
  /** Numeric only — the storage dtype a fresh drop-in gets. For a source whose
   * manifest declares a `scale` (GHCN's tenths) this is the *unscaled* float
   * dtype, not the bin's: the values the app sees are °C, and squeezing them
   * back into an int via scale/offset is the user's move to make, not a
   * pre-baked one. So it can differ from the manifest dtype. */
  dtype?: NumericBinDtype;
  logicalType: LogicalTypeConfig; // static copy of the manifest's
  attribution: string;       // short dataset-level attribution line for the row hint
  naturalShape: number[];    // the dataset's real shape (DatasetRegistryEntry.naturalShape)
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
    naturalShape: dataset.naturalShape,
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
    { type: 'integer', min: 18262, max: 18309, generation: 'sorted' },
    'NOAA NCEI GHCN-Daily (4 US stations)',
    'int32',
  ),
  curated(
    'ghcn-daily', 'tmax', 'number',
    { type: 'decimal', min: 12, max: 18, decimalPlaces: 1, generation: 'smooth' },
    'NOAA NCEI GHCN-Daily (4 US stations)',
    'float32',
  ),
  curated(
    'ghcn-daily', 'tmin', 'number',
    { type: 'decimal', min: 2, max: 8, decimalPlaces: 1, generation: 'smooth' },
    'NOAA NCEI GHCN-Daily (4 US stations)',
    'float32',
  ),
  curated(
    'ghcn-daily', 'prcp', 'number',
    { type: 'decimal', min: 0, max: 2.5, decimalPlaces: 1, generation: 'stepped' },
    'NOAA NCEI GHCN-Daily (4 US stations)',
    'float32',
  ),
  curated(
    'ghcn-daily', 'station', 'string',
    { type: 'text', min: 0, max: 0, wordSet: 'stations', generation: 'stepped' },
    'NOAA NCEI GHCN-Daily (4 US stations)',
  ),
  // Copernicus is a FLOAT elevation source (unscaled float32 drop-in), unlike
  // ETOPO's integer metres — its decimal precision is the vehicle for the
  // quantise → scale/offset lesson (the COG-esque preset ships that arc).
  curated(
    'copernicus-dem', 'elevation', 'number',
    { type: 'decimal', min: 100, max: 176.5, decimalPlaces: 1, generation: 'smooth' },
    'Copernicus DEM GLO-30 (via Earth Search / AWS)',
    'float32',
  ),
];

/**
 * Per-dataset metadata.customEntries seeds (provenance + spatial/units facts).
 * Values are copied VERBATIM from the matching top-level format preset's
 * customEntries (geotiffesque.json for etopo-dem, zarrish.json for sst-field,
 * parquet-adjacent.json for ghcn-daily) so a seed and a preset can never
 * disagree — pinned by tests/unit/datasets/catalog.test.ts. Spatial values
 * (crs/bbox/transform) mirror the manifest `spatial` block, computed from
 * each extraction script's own LAT0/LON0/STEP/SIZE constants
 * (scripts/datasets/etopo-dem.ts, scripts/datasets/sst-field.ts).
 */
export const DATASET_SEED_ENTRIES: Record<DatasetId, { key: string; value: string }[]> = {
  'etopo-dem': [
    { key: 'source', value: 'NOAA NCEI ETOPO Global Relief (via ERDDAP)' },
    { key: 'source_url', value: 'https://www.ncei.noaa.gov/products/etopo-global-relief-model' },
    { key: 'retrieved', value: '2026-07-13' },
    { key: 'license', value: 'U.S. Government work — public domain' },
    { key: 'crs', value: 'EPSG:4326' },
    { key: 'bbox', value: '[75, 20, 92.05, 37.05]' },
    { key: 'transform', value: '[75, 0.0166667, 0, 37.05, 0, -0.0166667]' },
  ],
  'sst-field': [
    { key: 'source', value: 'JPL MUR SST v4.1 (via NOAA CoastWatch ERDDAP)' },
    { key: 'source_url', value: 'https://podaac.jpl.nasa.gov/dataset/MUR-JPL-L4-GLOB-v4.1' },
    { key: 'retrieved', value: '2026-07-13' },
    { key: 'license', value: 'Open data — NASA JPL PO.DAAC' },
    { key: 'crs', value: 'EPSG:4326' },
    { key: 'bbox', value: '[-150, -5, -139.77, 5.23]' },
    { key: 'transform', value: '[-150, 0.01, 0, 5.23, 0, -0.01]' },
  ],
  'ghcn-daily': [
    { key: 'source', value: 'NOAA NCEI GHCN-Daily (4 US stations)' },
    { key: 'source_url', value: 'https://www.ncei.noaa.gov/products/land-based-station/global-historical-climatology-network-daily' },
    { key: 'retrieved', value: '2026-07-13' },
    { key: 'license', value: 'U.S. Government work — public domain' },
    { key: 'date_units', value: 'days since 1970-01-01' },
    { key: 'temperature_units', value: 'degC' },
    { key: 'precipitation_units', value: 'mm' },
  ],
  'copernicus-dem': [
    { key: 'source', value: 'Copernicus DEM GLO-30 (via Earth Search / AWS)' },
    { key: 'source_url', value: 'https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM' },
    { key: 'retrieved', value: '2026-08-19' },
    { key: 'license', value: 'Copernicus DEM — free and open (ESA), attribution required' },
    { key: 'crs', value: 'EPSG:4326' },
    { key: 'bbox', value: '[8.2, 61.5, 8.5, 61.8]' },
    { key: 'transform', value: '[8.2, 0.0002778, 0, 61.8, 0, -0.0002778]' },
  ],
};

/** Resolve a Variable.source ref to its catalog entry, or undefined if it
 * doesn't (or no longer) name a curated variable. */
export function curatedVariable(ref: { datasetId: DatasetId; variableName: string }): CuratedVariable | undefined {
  return CURATED_VARIABLES.find((c) => c.datasetId === ref.datasetId && c.name === ref.variableName);
}

/** Promise-cached manifest loader, called from the worker (values). Failed
 * loads evict so a transient network error is retryable. */
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
