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
 * Each preset bakes curated data sources into its variable entries via
 * `Variable.source = { datasetId, variableName }` (so loading it fetches real
 * data) and carries provenance as ordinary `metadata.customEntries`. The
 * variable schema (name/logicalType/typeAssignment) mirrors each dataset's
 * manifest exactly — at runtime the worker binds values by the source ref.
 *
 * NOTE (round-trip validation): deflate, gzip, and zstd are Pyodide-backed
 * codecs (`runPyodideCodec`) that throw synchronously when the runtime isn't
 * loaded — which node always is. All five format presets authentically use
 * one of these (that's the point — real GeoTIFF/Zarr/Parquet/Avro compress),
 * so `computePipelineStages` can't round-trip them here. `assertReads` skips
 * the pipeline check for presets whose pipelines touch a Pyodide codec and
 * only type-checks + writes them; the real in-browser round-trip is pinned by
 * tests/ui/scenario-curated-variables.mjs. Presets with no Pyodide codec still
 * get the full read-back assertion, fed a `sourceValues` map built from the
 * fixture data exactly the way the worker builds it.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { AppState, Variable, VariableSource } from '../src/types/state.ts';
import type { CodecStep } from '../src/types/codecs.ts';
import { computePipelineStages, type SourceValues } from '../src/hooks/usePipeline.ts';
import { validateManifest, fetchDatasetVariable } from '../src/datasets/assets.ts';
import { colors } from '../src/theme.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', 'src', 'presets');
const fixtureRoot = path.join(__dirname, '..', 'tests', 'fixtures', 'datasets');
// Hardcoded (rather than imported from registry.ts, which reads import.meta.env
// and can't run under plain node/tsx).
const KNOWN_IDS = ['etopo-dem', 'sst-field', 'ghcn-daily', 'copernicus-dem'];

const PYODIDE_CODECS = new Set(['deflate', 'gzip', 'zstd']);

function usesPyodideCodec(state: AppState): boolean {
  const all: CodecStep[] = [
    ...Object.values(state.fieldPipelines).flat(),
    ...state.chunkPipeline,
  ];
  return all.some((s) => PYODIDE_CODECS.has(s.codec));
}

/** Load the fixture manifest for a dataset id. */
function loadFixtureManifest(id: string) {
  return validateManifest(
    JSON.parse(readFileSync(path.join(fixtureRoot, id, 'manifest.json'), 'utf-8')),
    KNOWN_IDS,
  );
}

/** Filesystem-backed fetch of a fixture asset (mirrors fixtures.test.ts). */
function fsFetch(id: string): typeof fetch {
  return (async (url: string | URL | Request) => {
    const file = String(url).split('/').pop()!;
    const buf = readFileSync(path.join(fixtureRoot, id, file));
    return new Response(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  }) as typeof fetch;
}

/** Build the worker-shaped sourceValues map for a state's `source` refs from
 * fixture data. */
async function buildSourceValues(state: AppState): Promise<SourceValues | undefined> {
  const refs = new Map<string, VariableSource>();
  for (const v of state.variables) {
    if (v.source) refs.set(`${v.source.datasetId}/${v.source.variableName}`, v.source);
  }
  if (refs.size === 0) return undefined;
  const out: SourceValues = new Map();
  for (const [key, ref] of refs) {
    const manifest = loadFixtureManifest(ref.datasetId);
    const values = await fetchDatasetVariable(manifest, ref.variableName, (f) => `fixture://${ref.datasetId}/${f}`, fsFetch(ref.datasetId));
    out.set(key, { values, naturalShape: manifest.shape });
  }
  return out;
}

async function assertReads(name: string, state: AppState): Promise<void> {
  if (usesPyodideCodec(state)) {
    console.log(`${name}: SKIP read-back (Pyodide-backed codec — validated in-browser by scenario-curated-variables.mjs)`);
    return;
  }
  const sourceValues = await buildSourceValues(state);
  const result = computePipelineStages(state, undefined, sourceValues);
  if (!result.readResult.success) {
    const r = result.readResult;
    throw new Error(`Preset "${name}" failed to read back: ${r.reason} — ${r.message}`);
  }
  console.log(`${name}: read OK, ${result.files.length} file(s), reconstructed ${result.readResult.reconstructedValues.size} variable(s)`);
}

async function write(name: string, state: AppState): Promise<void> {
  await assertReads(name, state);
  const file = path.join(outDir, `${name}.json`);
  writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  console.log(`wrote ${file}`);
}

// ─── Provenance entries (baked into customEntries; no seeding machinery) ─────

const ETOPO_PROVENANCE = [
  { key: 'source', value: 'NOAA NCEI ETOPO Global Relief (via ERDDAP)' },
  { key: 'source_url', value: 'https://www.ncei.noaa.gov/products/etopo-global-relief-model' },
  { key: 'retrieved', value: '2026-07-13' },
  { key: 'license', value: 'U.S. Government work — public domain' },
  // Spatial entries: verbatim copies of DATASET_SEED_ENTRIES (registry.ts) so a
  // seed and a preset can never disagree (pinned by tests/unit/datasets/catalog.test.ts).
  { key: 'crs', value: 'EPSG:4326' },
  { key: 'bbox', value: '[75, 20, 92.05, 37.05]' },
  { key: 'transform', value: '[75, 0.0166667, 0, 37.05, 0, -0.0166667]' },
];

const SST_PROVENANCE = [
  { key: 'source', value: 'JPL MUR SST v4.1 (via NOAA CoastWatch ERDDAP)' },
  { key: 'source_url', value: 'https://podaac.jpl.nasa.gov/dataset/MUR-JPL-L4-GLOB-v4.1' },
  { key: 'retrieved', value: '2026-07-13' },
  { key: 'license', value: 'Open data — NASA JPL PO.DAAC' },
  { key: 'crs', value: 'EPSG:4326' },
  { key: 'bbox', value: '[-150, -5, -139.77, 5.23]' },
  { key: 'transform', value: '[-150, 0.01, 0, 5.23, 0, -0.01]' },
];

const GHCN_PROVENANCE = [
  { key: 'source', value: 'NOAA NCEI GHCN-Daily (4 US stations)' },
  { key: 'source_url', value: 'https://www.ncei.noaa.gov/products/land-based-station/global-historical-climatology-network-daily' },
  { key: 'retrieved', value: '2026-07-13' },
  { key: 'license', value: 'U.S. Government work — public domain' },
  // CF-style units. Without these the stored ints are unreadable — which is
  // the point: the scale factor lives in the codec_pipelines' scale-offset
  // step, the unit here.
  { key: 'date_units', value: 'days since 1970-01-01' },
  { key: 'temperature_units', value: 'degC' },
  { key: 'precipitation_units', value: 'mm' },
];

const COG_PROVENANCE = [
  { key: 'source', value: 'Copernicus DEM GLO-30 (via Earth Search / AWS)' },
  { key: 'source_url', value: 'https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM' },
  { key: 'retrieved', value: '2026-08-19' },
  { key: 'license', value: 'Copernicus DEM — free and open (ESA), attribution required' },
  { key: 'crs', value: 'EPSG:4326' },
  { key: 'bbox', value: '[8.2, 61.5, 8.5, 61.8]' },
  { key: 'transform', value: '[8.2, 0.0002778, 0, 61.8, 0, -0.0002778]' },
];

const DEFAULT_INCLUDE = { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true, endianness: true };

// ─── GeoTIFFesque (array, the real etopo-dem elevation band) ────────────────
//
// COG: single file, TIFF header/IFD at the front (header placement, BINARY —
// TIFF's IFD is binary, not JSON), magic II*\0, 256×256 tiles, C order,
// little-endian, single band: the real etopo-dem elevation (int16). The
// earlier slope/hillshade "derived bands" were generated smooth NOISE — they
// looked random next to real terrain and taught nothing, so they're gone
// (single-band DEM is the canonical GeoTIFF anyway). Row interleaving means
// per-field pipelines are inactive — DEFLATE lives in the shared chunk
// pipeline, mirroring avroesque's row-mode pattern.

const geotiffVariables: Variable[] = [
  {
    id: 'etopo-dem-elevation', name: 'elevation', color: colors.palette[0],
    source: { datasetId: 'etopo-dem', variableName: 'elevation' },
    logicalType: { type: 'integer', min: -1485, max: 8271, generation: 'smooth' },
    typeAssignment: { storageDtype: 'int16' },
  },
];

const geotiffesque: AppState = {
  dataModel: 'array',
  shape: [1024, 1024],
  chunkShape: [256, 256],
  interleaving: 'row',
  linearization: 'c',
  byteOrder: 'little',
  variables: geotiffVariables,
  // Row mode: per-field pipelines are inactive; the shared chunk pipeline runs.
  fieldPipelines: {
    'etopo-dem-elevation': [],
  },
  chunkPipeline: [{ codec: 'deflate', params: {} }],
  metadata: {
    customEntries: [...ETOPO_PROVENANCE],
    serialization: 'binary',
    include: DEFAULT_INCLUDE,
    enabled: true,
  },
  write: {
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
    source: { datasetId: 'sst-field', variableName: 'sst' },
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
  variables: zarrVariables,
  fieldPipelines: {
    'sst-field-sst': [
      { codec: 'byte-shuffle', params: { elementSize: 4 } },
      { codec: 'zstd', params: {} },
    ],
  },
  chunkPipeline: [],
  metadata: {
    customEntries: [...SST_PROVENANCE],
    serialization: 'json',
    include: DEFAULT_INCLUDE,
    enabled: true,
  },
  write: {
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
  },
};

// ─── COG-esque (array, copernicus-dem — the quantisation arc) ────────────────
//
// Cloud-Optimized GeoTIFF over the FLOAT Copernicus elevation: the source is
// float32 metres with real decimals, and this preset walks the compression arc
// to its destination entirely as codec pipeline steps — scale-offset (×10)
// quantises the decimals onto a 0.1 m grid AND halves the bytes into int16,
// then delta (spatial neighbours differ by little) → DEFLATE (entropy), three
// visible pipeline stages. The float+bitround alternative (the bitround codec
// over a float32 storageDtype) is the guide's "quantise in float space"
// branch, deliberately NOT baked here — it's a different pipeline, not a
// stackable addition to this one. Same TIFF magic/header/tiling as
// GeoTIFFesque; the lesson is the dtype journey, not the container.

const cogVariables: Variable[] = [
  {
    id: 'copernicus-dem-elevation', name: 'elevation', color: colors.palette[0],
    source: { datasetId: 'copernicus-dem', variableName: 'elevation' },
    logicalType: { type: 'decimal', min: 478.5, max: 2459, decimalPlaces: 1, generation: 'smooth' },
    // ×10 → 0.1 m grid; max 2459 m ×10 = 24590 < 32767, so int16 fits with no offset.
    // The scale now lives in the chunk pipeline's scale-offset codec step
    // below, not here — storageDtype is the plain float32 cast.
    typeAssignment: { storageDtype: 'float32' },
  },
];

const cogEsque: AppState = {
  dataModel: 'array',
  shape: [1024, 1024],
  chunkShape: [256, 256],
  interleaving: 'row',
  linearization: 'c',
  byteOrder: 'little',
  variables: cogVariables,
  // Row mode: per-field pipelines inactive; the shared chunk pipeline runs the
  // quantise → delta → entropy arc.
  fieldPipelines: {
    'copernicus-dem-elevation': [],
  },
  chunkPipeline: [
    { codec: 'scale-offset', params: { scale: 10, offset: 0, sourceDtype: 'float32', targetDtype: 'int16' } },
    { codec: 'delta', params: { elementSize: 2 } },
    { codec: 'deflate', params: {} },
  ],
  metadata: {
    customEntries: [...COG_PROVENANCE],
    serialization: 'binary',
    include: DEFAULT_INCLUDE,
    enabled: true,
  },
  write: {
    magicNumber: '49492A00', // II*\0 (TIFF; COG is a GeoTIFF variant)
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
    source: { datasetId: 'ghcn-daily', variableName: 'date' },
    logicalType: { type: 'integer', min: -36889, max: 20643, generation: 'sorted' },
    typeAssignment: { storageDtype: 'int32' },
  },
  // The scale/offset lesson: the values are °C to one decimal, and the
  // fieldPipelines' scale-offset codec step (below, ×10) stores them
  // losslessly in half the bytes a float32 would take — storageDtype itself
  // is just the plain float32 cast now; the scale lives in the pipeline.
  {
    id: 'ghcn-daily-tmax', name: 'tmax', color: colors.palette[1],
    source: { datasetId: 'ghcn-daily', variableName: 'tmax' },
    logicalType: { type: 'decimal', min: -16.7, max: 43.3, decimalPlaces: 1, generation: 'smooth' },
    typeAssignment: { storageDtype: 'float32' },
  },
  {
    id: 'ghcn-daily-tmin', name: 'tmin', color: colors.palette[2],
    source: { datasetId: 'ghcn-daily', variableName: 'tmin' },
    logicalType: { type: 'decimal', min: -26.1, max: 28.9, decimalPlaces: 1, generation: 'smooth' },
    typeAssignment: { storageDtype: 'float32' },
  },
  {
    id: 'ghcn-daily-prcp', name: 'prcp', color: colors.palette[3],
    source: { datasetId: 'ghcn-daily', variableName: 'prcp' },
    logicalType: { type: 'decimal', min: 0, max: 377.2, decimalPlaces: 1, generation: 'stepped' },
    typeAssignment: { storageDtype: 'float32' },
  },
  {
    id: 'ghcn-daily-station', name: 'station', color: colors.palette[4],
    source: { datasetId: 'ghcn-daily', variableName: 'station' },
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
  variables: parquetVariables,
  fieldPipelines: {
    'ghcn-daily-date': [{ codec: 'delta', params: {} }, { codec: 'deflate', params: {} }],
    'ghcn-daily-tmax': [
      { codec: 'scale-offset', params: { scale: 10, offset: 0, sourceDtype: 'float32', targetDtype: 'int16' } },
      { codec: 'delta', params: { elementSize: 2 } },
      { codec: 'zigzag', params: {} },
      { codec: 'deflate', params: {} },
    ],
    'ghcn-daily-tmin': [
      { codec: 'scale-offset', params: { scale: 10, offset: 0, sourceDtype: 'float32', targetDtype: 'int16' } },
      { codec: 'delta', params: { elementSize: 2 } },
      { codec: 'zigzag', params: {} },
      { codec: 'deflate', params: {} },
    ],
    'ghcn-daily-prcp': [
      { codec: 'scale-offset', params: { scale: 10, offset: 0, sourceDtype: 'float32', targetDtype: 'int16' } },
      { codec: 'rle', params: {} },
      { codec: 'deflate', params: {} },
    ],
    'ghcn-daily-station': [{ codec: 'dictionary', params: {} }, { codec: 'rle', params: {} }],
  },
  chunkPipeline: [],
  metadata: {
    customEntries: [...GHCN_PROVENANCE],
    serialization: 'binary',
    include: DEFAULT_INCLUDE,
    enabled: true,
  },
  write: {
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
  variables: avroVariables,
  // Row mode: per-field pipelines are inactive; the shared chunk pipeline runs.
  // tmax/tmin/prcp carry a scale-offset step here as a benignly inactive
  // prefix (values simply store as float32 until row-mode field pipelines
  // activate — see the codec-unification plan's row-mode task).
  fieldPipelines: {
    'ghcn-daily-date': [],
    'ghcn-daily-tmax': [{ codec: 'scale-offset', params: { scale: 10, offset: 0, sourceDtype: 'float32', targetDtype: 'int16' } }],
    'ghcn-daily-tmin': [{ codec: 'scale-offset', params: { scale: 10, offset: 0, sourceDtype: 'float32', targetDtype: 'int16' } }],
    'ghcn-daily-prcp': [{ codec: 'scale-offset', params: { scale: 10, offset: 0, sourceDtype: 'float32', targetDtype: 'int16' } }],
    'ghcn-daily-station': [],
  },
  chunkPipeline: [{ codec: 'deflate', params: {} }],
  metadata: {
    customEntries: [...GHCN_PROVENANCE],
    serialization: 'json',
    include: DEFAULT_INCLUDE,
    enabled: true,
  },
  write: {
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
  },
};

write('geotiffesque', geotiffesque);
write('cog-esque', cogEsque);
write('zarrish', zarrish);
write('parquet-adjacent', parquetAdjacent);
write('avroesque', avroesque);
