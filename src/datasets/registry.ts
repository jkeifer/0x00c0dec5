import type { AppState, TypeAssignment } from '../types/state.ts';
import type { CodecStep } from '../types/codecs.ts';
import type { DatasetId, DatasetManifest } from './types.ts';
import { validateManifest } from './assets.ts';

/**
 * Curated pipeline defaults applied on dataset selection. Keyed by variable
 * NAME (ids are minted at apply time). These reference app registry keys
 * (codec ids, dtype keys) and so live HERE on main, version-locked to the
 * app — never in the remote manifest (spec: a codec rename must not strand
 * remote config). Names that match no manifest variable are ignored, so a
 * data-branch schema revision degrades to defaults rather than breaking apply.
 */
export interface CuratedDefaults {
  chunkShape: number[];
  interleaving?: AppState['interleaving'];
  linearization?: AppState['linearization'];
  typeAssignments: Record<string, TypeAssignment>;
  fieldPipelines: Record<string, CodecStep[]>;
  chunkPipeline?: CodecStep[];
}

export interface DatasetRegistryEntry {
  id: DatasetId;
  label: string;
  dataModel: AppState['dataModel'];
  curated: CuratedDefaults;
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
  {
    id: 'etopo-dem',
    label: 'Terrain elevation (ETOPO)',
    dataModel: 'array',
    curated: {
      chunkShape: [256, 256],
      linearization: 'c',
      typeAssignments: { elevation: { storageDtype: 'int16' } },
      fieldPipelines: {
        elevation: [
          { codec: 'delta', params: {} },
          { codec: 'zigzag', params: {} },
          { codec: 'deflate', params: {} },
        ],
      },
    },
  },
  {
    id: 'sst-field',
    label: 'Sea-surface temperature (MUR)',
    dataModel: 'array',
    curated: {
      chunkShape: [256, 256],
      linearization: 'c',
      typeAssignments: { sst: { storageDtype: 'float32', keepBits: 8 } },
      fieldPipelines: {
        sst: [
          { codec: 'byte-shuffle', params: {} },
          { codec: 'zstd', params: {} },
        ],
      },
    },
  },
  {
    id: 'ghcn-daily',
    label: 'Weather station daily (GHCN)',
    dataModel: 'tabular',
    curated: {
      chunkShape: [65536],
      interleaving: 'column',
      typeAssignments: {
        date: { storageDtype: 'int32' },
        tmax: { storageDtype: 'int16' },
        tmin: { storageDtype: 'int16' },
        prcp: { storageDtype: 'int16' },
        station: { storageDtype: 'char16' },
      },
      fieldPipelines: {
        date: [{ codec: 'delta', params: {} }, { codec: 'deflate', params: {} }],
        tmax: [{ codec: 'delta', params: {} }, { codec: 'zigzag', params: {} }, { codec: 'deflate', params: {} }],
        tmin: [{ codec: 'delta', params: {} }, { codec: 'zigzag', params: {} }, { codec: 'deflate', params: {} }],
        prcp: [{ codec: 'rle', params: {} }, { codec: 'deflate', params: {} }],
        station: [{ codec: 'dictionary', params: {} }, { codec: 'rle', params: {} }],
      },
    },
  },
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
      return validateManifest(await res.json());
    })();
    p.catch(() => manifestCache.delete(id));
    manifestCache.set(id, p);
  }
  return p;
}
