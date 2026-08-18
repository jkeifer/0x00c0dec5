import type { LogicalTypeConfig } from '../types/state.ts';

/** The shipped dataset presets. Adding one: extraction script (scripts/
 * datasets/), registry entry (registry.ts), fixture (tests/fixtures/). */
export type DatasetId = 'etopo-dem' | 'sst-field' | 'ghcn-daily';

/** Provenance facts recorded by the extraction script; surfaced in the UI
 * attribution line and seeded into metadata.customEntries on apply. */
export interface DatasetAttribution {
  source: string;      // e.g. "NOAA NCEI ETOPO 2022 (via ERDDAP)"
  source_url: string;
  retrieved: string;   // ISO date the extraction ran
  license: string;     // e.g. "U.S. Government work — public domain"
}

/** Dtypes a numeric bin may use. Narrower than DtypeKey: bins store the
 * native extracted width, and these four cover the shipped datasets. */
export type NumericBinDtype = 'int16' | 'int32' | 'float32' | 'float64';

export interface ManifestNumericVariable {
  name: string;
  kind: 'number';
  dtype: NumericBinDtype;
  file: string;        // relative to the dataset's directory on the data branch
  /** The bin is a fixed-precision integer encoding: logical = stored / scale
   * (GHCN stores tenths of a degree → scale 10 → 15.6 °C). Same direction as
   * TypeAssignment.scale, so the bin holds exactly what assignType would have
   * written. Absent means 1 — the bin holds logical values directly.
   * ponytail: no `offset` until a dataset needs one. */
  scale?: number;
  min: number;         // observed at extraction, in LOGICAL units (post-scale)
  max: number;
  logicalType: LogicalTypeConfig;
}

export interface ManifestStringVariable {
  name: string;
  kind: 'string';
  dictFile: string;    // JSON array of unique strings
  codesFile: string;   // bin of dictionary indices
  codesDtype: 'uint8' | 'uint16';
  logicalType: LogicalTypeConfig; // type: 'text'
}

export type ManifestVariable = ManifestNumericVariable | ManifestStringVariable;

/** manifest.json on the data branch — pure data description (spec: data
 * facts live with the data; app-coupled curated config lives in registry.ts). */
export interface DatasetManifest {
  id: DatasetId;
  shape: number[];
  attribution: DatasetAttribution;
  variables: ManifestVariable[];
}
