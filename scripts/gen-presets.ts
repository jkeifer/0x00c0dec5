/**
 * One-off generator for the built-in format presets. Not part of the app
 * bundle or the test suite — run manually with:
 *
 *   npx tsx scripts/gen-presets.ts
 *
 * Constructs each preset as a real, fully-typed `AppState` object (so the
 * shape can never drift from what the app actually reads/writes) and writes it
 * to `src/presets/*.json`. Re-run this any time `AppState`'s shape changes.
 *
 * Each preset now carries a `dataset` ref (so loading it fetches real data)
 * with its seeded provenance entries mirrored in `metadata.customEntries` (so
 * SET_DATASET_CUSTOM's "remove unmodified seeded entries" works after a load).
 * The variable schema (name/logicalType/typeAssignment) mirrors each dataset's
 * manifest exactly — at runtime the worker overrides values by name.
 *
 * NOTE (round-trip validation): deflate, gzip, and zstd are Pyodide-backed
 * codecs (`runPyodideCodec`) that throw synchronously when the runtime isn't
 * loaded — which node always is. All four format presets authentically use
 * one of these (that's the point — real GeoTIFF/Zarr/Parquet/Avro compress),
 * so `computePipelineStages` can't round-trip them here. `assertReads` skips
 * the pipeline check for presets whose pipelines touch a Pyodide codec and
 * only type-checks + writes them; the real in-browser round-trip is pinned by
 * tests/ui/scenario-dataset-presets.mjs. Presets with no Pyodide codec still
 * get the full read-back assertion.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { AppState, Variable } from '../src/types/state.ts';
import type { CodecStep } from '../src/types/codecs.ts';
import { computePipelineStages } from '../src/hooks/usePipeline.ts';
import { colors } from '../src/theme.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', 'src', 'presets');

const PYODIDE_CODECS = new Set(['deflate', 'gzip', 'zstd']);

function usesPyodideCodec(state: AppState): boolean {
  const all: CodecStep[] = [
    ...Object.values(state.fieldPipelines).flat(),
    ...state.chunkPipeline,
  ];
  return all.some((s) => PYODIDE_CODECS.has(s.codec));
}

function assertReads(name: string, state: AppState): void {
  if (usesPyodideCodec(state)) {
    console.log(`${name}: SKIP read-back (Pyodide-backed codec — validated in-browser by scenario-dataset-presets.mjs)`);
    return;
  }
  const result = computePipelineStages(state);
  if (!result.readResult.success) {
    const r = result.readResult;
    throw new Error(`Preset "${name}" failed to read back: ${r.reason} — ${r.message}`);
  }
  console.log(`${name}: read OK, ${result.files.length} file(s), reconstructed ${result.readResult.reconstructedValues.size} variable(s)`);
}

function write(name: string, state: AppState): void {
  assertReads(name, state);
  const file = path.join(outDir, `${name}.json`);
  writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  console.log(`wrote ${file}`);
}

// ─── Dataset refs (seeded provenance mirrors the data-branch manifests) ──────

const ETOPO_DATASET: NonNullable<AppState['dataset']> = {
  id: 'etopo-dem',
  attribution: 'NOAA NCEI ETOPO Global Relief (via ERDDAP) · U.S. Government work — public domain',
  seededEntries: [
    { key: 'source', value: 'NOAA NCEI ETOPO Global Relief (via ERDDAP)' },
    { key: 'source_url', value: 'https://www.ncei.noaa.gov/products/etopo-global-relief-model' },
    { key: 'retrieved', value: '2026-07-13' },
    { key: 'license', value: 'U.S. Government work — public domain' },
  ],
};

const SST_DATASET: NonNullable<AppState['dataset']> = {
  id: 'sst-field',
  attribution: 'JPL MUR SST v4.1 (via NOAA CoastWatch ERDDAP) · Open data — NASA JPL PO.DAAC',
  seededEntries: [
    { key: 'source', value: 'JPL MUR SST v4.1 (via NOAA CoastWatch ERDDAP)' },
    { key: 'source_url', value: 'https://podaac.jpl.nasa.gov/dataset/MUR-JPL-L4-GLOB-v4.1' },
    { key: 'retrieved', value: '2026-07-13' },
    { key: 'license', value: 'Open data — NASA JPL PO.DAAC' },
  ],
};

const GHCN_DATASET: NonNullable<AppState['dataset']> = {
  id: 'ghcn-daily',
  attribution: 'NOAA NCEI GHCN-Daily (4 US stations) · U.S. Government work — public domain',
  seededEntries: [
    { key: 'source', value: 'NOAA NCEI GHCN-Daily (4 US stations)' },
    { key: 'source_url', value: 'https://www.ncei.noaa.gov/products/land-based-station/global-historical-climatology-network-daily' },
    { key: 'retrieved', value: '2026-07-13' },
    { key: 'license', value: 'U.S. Government work — public domain' },
  ],
};

const DEFAULT_INCLUDE = { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true, endianness: true };

// ─── GeoTIFFesque (array, etopo-dem) ─────────────────────────────────────────
//
// COG: single file, TIFF header/IFD at the front (header placement, JSON),
// magic II*\0, 256×256 tiles, C order, little-endian, elevation stored int16,
// horizontal predictor (delta order 1) + DEFLATE. TIFF predictor output is
// two's-complement (NOT zigzag), so we drop zigzag from the old curated config.

const geotiffVariables: Variable[] = [
  {
    id: 'etopo-dem-elevation', name: 'elevation', color: colors.palette[0],
    logicalType: { type: 'integer', min: -1485, max: 8271, generation: 'smooth' },
    typeAssignment: { storageDtype: 'int16' },
  },
];

const geotiffesque: AppState = {
  dataModel: 'array',
  shape: [1024, 1024],
  chunkShape: [256, 256],
  interleaving: 'column',
  linearization: 'c',
  byteOrder: 'little',
  dataset: ETOPO_DATASET,
  variables: geotiffVariables,
  fieldPipelines: {
    'etopo-dem-elevation': [
      { codec: 'delta', params: { order: 1 } },
      { codec: 'deflate', params: {} },
    ],
  },
  chunkPipeline: [],
  metadata: {
    customEntries: [...ETOPO_DATASET.seededEntries],
    serialization: 'json',
    include: DEFAULT_INCLUDE,
  },
  write: {
    includeMetadata: true,
    magicNumber: '49492A00', // II*\0
    partitioning: 'single',
    metadataPlacement: 'header',
    chunkOrder: 'row-major',
    footerLocator: 'trailer',
  },
  ui: {
    leftPaneStage: 'values',
    rightPaneStage: 'write',
    leftPaneView: 'grid',
    rightPaneView: 'hex',
    showDiff: false,
  },
};

// ─── Zarrish (array, sst-field) ──────────────────────────────────────────────
//
// One file per chunk (per-chunk partitioning — zarr's defining trait), sidecar
// JSON metadata (.zmetadata/.zattrs), EMPTY magic (zarr chunk files have none —
// itself a lesson), 256×256 chunks, column interleaving, sst float32,
// byte-shuffle(4) + zstd (modern Zarr default compressor stack).

const zarrVariables: Variable[] = [
  {
    id: 'sst-field-sst', name: 'sst', color: colors.palette[0],
    logicalType: { type: 'continuous', min: 27.64, max: 30.54, significantFigures: 6, generation: 'smooth' },
    typeAssignment: { storageDtype: 'float32' },
  },
];

const zarrish: AppState = {
  dataModel: 'array',
  shape: [1024, 1024],
  chunkShape: [256, 256],
  interleaving: 'column',
  linearization: 'c',
  byteOrder: 'little',
  dataset: SST_DATASET,
  variables: zarrVariables,
  fieldPipelines: {
    'sst-field-sst': [
      { codec: 'byte-shuffle', params: { elementSize: 4 } },
      { codec: 'zstd', params: {} },
    ],
  },
  chunkPipeline: [],
  metadata: {
    customEntries: [...SST_DATASET.seededEntries],
    serialization: 'json',
    include: DEFAULT_INCLUDE,
  },
  write: {
    includeMetadata: true,
    magicNumber: '', // zarr chunk files have no magic
    partitioning: 'per-chunk',
    metadataPlacement: 'sidecar',
    chunkOrder: 'row-major',
    footerLocator: 'trailer',
  },
  ui: {
    leftPaneStage: 'values',
    rightPaneStage: 'write',
    leftPaneView: 'grid',
    rightPaneView: 'hex',
    showDiff: false,
  },
};

// ─── Parquet-adjacent (tabular, ghcn-daily) ──────────────────────────────────
//
// Column chunks (column interleaving), single file, footer metadata with the
// trailer locator ([footer][len]['PAR1']), magic PAR1, BINARY serialization
// (Parquet's footer is Thrift binary), 65536-row row-group chunk. Per-column
// encodings are authentic Parquet: delta for the sorted date, delta+zigzag for
// temperatures, RLE for the sparse prcp, dictionary+RLE for the station — all
// finished with DEFLATE (page compression), zigzag IS authentic here.

const parquetVariables: Variable[] = [
  {
    id: 'ghcn-daily-date', name: 'date', color: colors.palette[0],
    logicalType: { type: 'integer', min: 18690101, max: 20260709, generation: 'sorted' },
    typeAssignment: { storageDtype: 'int32' },
  },
  {
    id: 'ghcn-daily-tmax', name: 'tmax', color: colors.palette[1],
    logicalType: { type: 'integer', min: -167, max: 433, generation: 'smooth' },
    typeAssignment: { storageDtype: 'int16' },
  },
  {
    id: 'ghcn-daily-tmin', name: 'tmin', color: colors.palette[2],
    logicalType: { type: 'integer', min: -261, max: 289, generation: 'smooth' },
    typeAssignment: { storageDtype: 'int16' },
  },
  {
    id: 'ghcn-daily-prcp', name: 'prcp', color: colors.palette[3],
    logicalType: { type: 'integer', min: 0, max: 3772, generation: 'stepped' },
    typeAssignment: { storageDtype: 'int16' },
  },
  {
    id: 'ghcn-daily-station', name: 'station', color: colors.palette[4],
    logicalType: { type: 'text', min: 0, max: 0, wordSet: 'stations', generation: 'stepped' },
    typeAssignment: { storageDtype: 'char16' },
  },
];

const parquetAdjacent: AppState = {
  dataModel: 'tabular',
  shape: [144769],
  chunkShape: [65536],
  interleaving: 'column',
  linearization: 'c',
  byteOrder: 'little',
  dataset: GHCN_DATASET,
  variables: parquetVariables,
  fieldPipelines: {
    'ghcn-daily-date': [{ codec: 'delta', params: {} }, { codec: 'deflate', params: {} }],
    'ghcn-daily-tmax': [{ codec: 'delta', params: {} }, { codec: 'zigzag', params: {} }, { codec: 'deflate', params: {} }],
    'ghcn-daily-tmin': [{ codec: 'delta', params: {} }, { codec: 'zigzag', params: {} }, { codec: 'deflate', params: {} }],
    'ghcn-daily-prcp': [{ codec: 'rle', params: {} }, { codec: 'deflate', params: {} }],
    'ghcn-daily-station': [{ codec: 'dictionary', params: {} }, { codec: 'rle', params: {} }],
  },
  chunkPipeline: [],
  metadata: {
    customEntries: [...GHCN_DATASET.seededEntries],
    serialization: 'binary',
    include: DEFAULT_INCLUDE,
  },
  write: {
    includeMetadata: true,
    magicNumber: '50415231', // PAR1
    partitioning: 'single',
    metadataPlacement: 'footer',
    chunkOrder: 'row-major',
    footerLocator: 'trailer',
  },
  ui: {
    leftPaneStage: 'values',
    rightPaneStage: 'write',
    leftPaneView: 'table',
    rightPaneView: 'hex',
    showDiff: false,
  },
};

// ─── Avro-esque (tabular, ghcn-daily) ────────────────────────────────────────
//
// The row-oriented contrast: ROW interleaving (record storage), single file,
// header metadata + JSON serialization (Avro embeds its JSON schema in the file
// header — the pedagogical hook), magic Obj\1, ~4096-row Avro-block chunk, and
// a shared chunk-level DEFLATE (Avro's block codec; row mode uses the shared
// chunk pipeline, not per-field pipelines).

const avroVariables: Variable[] = parquetVariables.map((v) => ({ ...v }));

const avroesque: AppState = {
  dataModel: 'tabular',
  shape: [144769],
  chunkShape: [4096],
  interleaving: 'row',
  linearization: 'c',
  byteOrder: 'little',
  dataset: GHCN_DATASET,
  variables: avroVariables,
  // Row mode: per-field pipelines are inactive; the shared chunk pipeline runs.
  fieldPipelines: {
    'ghcn-daily-date': [],
    'ghcn-daily-tmax': [],
    'ghcn-daily-tmin': [],
    'ghcn-daily-prcp': [],
    'ghcn-daily-station': [],
  },
  chunkPipeline: [{ codec: 'deflate', params: {} }],
  metadata: {
    customEntries: [...GHCN_DATASET.seededEntries],
    serialization: 'json',
    include: DEFAULT_INCLUDE,
  },
  write: {
    includeMetadata: true,
    magicNumber: '4F626A01', // Obj\1
    partitioning: 'single',
    metadataPlacement: 'header',
    chunkOrder: 'row-major',
    footerLocator: 'trailer',
  },
  ui: {
    leftPaneStage: 'values',
    rightPaneStage: 'write',
    leftPaneView: 'table',
    rightPaneView: 'hex',
    showDiff: false,
  },
};

write('geotiffesque', geotiffesque);
write('zarrish', zarrish);
write('parquet-adjacent', parquetAdjacent);
write('avroesque', avroesque);
