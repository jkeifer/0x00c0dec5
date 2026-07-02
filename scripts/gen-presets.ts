/**
 * One-off generator for the built-in presets (D10, remediation-plan.md, task
 * 6.2). Not part of the app bundle or the test suite — run manually with:
 *
 *   npx tsx scripts/gen-presets.ts
 *
 * Constructs each preset as a real, fully-typed `AppState` object (so the
 * shape can never drift from what the app actually reads/writes), runs it
 * through `computePipelineStages` to confirm `readResult.success === true`,
 * and writes the validated state to `src/presets/*.json`. Re-run this any
 * time `AppState`'s shape changes and the presets need regenerating.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { AppState, Variable } from '../src/types/state.ts';
import { computePipelineStages } from '../src/hooks/usePipeline.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', 'src', 'presets');

function assertReads(name: string, state: AppState): void {
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

// ─── Basically Parquet ──────────────────────────────────────────────────
//
// Tabular, 1-D, column-oriented (per-column codecs — Parquet is columnar),
// footer metadata with the D1 trailer (the "Parquet is literally
// [footer][len]['PAR1']" punchline), chunked into row groups. One numeric
// column (humidity, stepped generation) gets delta+RLE so the compression
// story is visible; temperature stays codec-free as the contrast case.

const parquetVariables: Variable[] = [
  {
    id: 'temperature', name: 'temperature', color: '#e06c75',
    logicalType: { type: 'decimal', min: -50, max: 50, decimalPlaces: 1, generation: 'smooth' },
    typeAssignment: { storageDtype: 'float32' },
  },
  {
    id: 'pressure', name: 'pressure', color: '#61afef',
    logicalType: { type: 'decimal', min: 900, max: 1100, decimalPlaces: 1, generation: 'sorted' },
    typeAssignment: { storageDtype: 'float32' },
  },
  {
    id: 'humidity', name: 'humidity', color: '#98c379',
    logicalType: { type: 'integer', min: 0, max: 100, generation: 'stepped' },
    typeAssignment: { storageDtype: 'uint16' },
  },
];

const basicallyParquet: AppState = {
  dataModel: 'tabular',
  shape: [64],
  chunkShape: [16], // "row groups"
  interleaving: 'column',
  variables: parquetVariables,
  fieldPipelines: {
    temperature: [],
    pressure: [],
    humidity: [
      { codec: 'delta', params: { order: 1 } },
      { codec: 'rle', params: {} },
    ],
  },
  chunkPipeline: [],
  metadata: {
    customEntries: [{ key: 'created_by', value: '0x00C0DEC5' }],
    serialization: 'json',
    includeChunkIndex: true,
  },
  write: {
    includeMetadata: true,
    magicNumber: '00C0DEC5',
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

// ─── Basically GeoTIFF ──────────────────────────────────────────────────
//
// Array, 2-D, tiled chunks, header metadata placement, CRS + transform
// custom entries. elevation is a smooth continuous surface; landcover is a
// stepped uint8 (categorical-ish) — both codec-free so the geo metadata is
// the focus, not compression.

const geotiffVariables: Variable[] = [
  {
    id: 'elevation', name: 'elevation', color: '#61afef',
    logicalType: { type: 'continuous', min: 0, max: 3000, significantFigures: 6, generation: 'smooth' },
    typeAssignment: { storageDtype: 'float32' },
  },
  {
    id: 'landcover', name: 'landcover', color: '#98c379',
    logicalType: { type: 'integer', min: 0, max: 20, generation: 'stepped' },
    typeAssignment: { storageDtype: 'uint8' },
  },
];

const basicallyGeotiff: AppState = {
  dataModel: 'array',
  shape: [16, 16],
  chunkShape: [8, 8], // tiles
  interleaving: 'column',
  variables: geotiffVariables,
  fieldPipelines: {
    elevation: [],
    landcover: [],
  },
  chunkPipeline: [],
  metadata: {
    customEntries: [
      { key: 'crs', value: 'EPSG:4326' },
      { key: 'transform', value: '[0.1, 0.0, -180.0, 0.0, -0.1, 90.0]' },
    ],
    serialization: 'json',
    includeChunkIndex: true,
  },
  write: {
    includeMetadata: true,
    magicNumber: '00C0DEC5',
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

// ─── Basically Zarr ─────────────────────────────────────────────────────
//
// Array, 2-D, per-chunk partitioning (one file per chunk, Zarr-style),
// sidecar JSON metadata (Zarr's .zarray/.zattrs live alongside chunk files,
// not embedded in them).

const zarrVariables: Variable[] = [
  {
    id: 'temperature', name: 'temperature', color: '#e06c75',
    logicalType: { type: 'decimal', min: -20, max: 40, decimalPlaces: 1, generation: 'smooth' },
    typeAssignment: { storageDtype: 'float32' },
  },
  {
    id: 'precipitation', name: 'precipitation', color: '#56b6c2',
    logicalType: { type: 'decimal', min: 0, max: 500, decimalPlaces: 1, generation: 'sorted' },
    typeAssignment: { storageDtype: 'float32' },
  },
];

const basicallyZarr: AppState = {
  dataModel: 'array',
  shape: [16, 16],
  chunkShape: [8, 8],
  interleaving: 'column',
  variables: zarrVariables,
  fieldPipelines: {
    temperature: [],
    precipitation: [],
  },
  chunkPipeline: [],
  metadata: {
    customEntries: [],
    serialization: 'json',
    includeChunkIndex: true,
  },
  write: {
    includeMetadata: true,
    magicNumber: '00C0DEC5',
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

write('basically-parquet', basicallyParquet);
write('basically-geotiff', basicallyGeotiff);
write('basically-zarr', basicallyZarr);
