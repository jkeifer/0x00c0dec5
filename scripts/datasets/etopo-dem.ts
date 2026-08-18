/**
 * ETOPO elevation crop → data-branch-work/datasets/etopo-dem/.
 * Source: NOAA ERDDAP griddap CSV (ETOPO — public domain, U.S. Government).
 * Primary server/dataset below; if it 404s, find the current ETOPO griddap
 * dataset on https://coastwatch.pfeg.noaa.gov/erddap/ or NCEI's ERDDAP and
 * update DATASET_URL — the assertions below are the contract, not the URL.
 */
import { assert, fetchText, outDir, today, writeInt16Bin, writeManifest } from './lib.ts';
import type { DatasetManifest } from '../../src/datasets/types.ts';

const SIZE = 1024;
// ETOPO1 (etopo180) is 1 arc-minute: 1024 cells span ~17.05°.
// Himalaya crop: visible relief from lowlands to 8000m+.
const LAT0 = 20.0, LON0 = 75.0;
const STEP = 1 / 60;
const LAT1 = LAT0 + (SIZE - 1) * STEP;
const LON1 = LON0 + (SIZE - 1) * STEP;
// Rounded to 7 significant figures for the manifest's spatial block (and the
// registry seed, which must match verbatim) — STEP's raw float64 has a long
// repeating tail that isn't a meaningful pixel-size precision.
const STEP_R = 0.0166667;
const DATASET_URL =
  `https://coastwatch.pfeg.noaa.gov/erddap/griddap/etopo180.csv?` +
  `altitude%5B(${LAT0}):(${LAT1})%5D%5B(${LON0}):(${LON1})%5D`;

const csv = await fetchText(DATASET_URL);
const lines = csv.trim().split('\n');
// ERDDAP CSV: header row + units row, then lat,lon,altitude rows.
const rows = lines.slice(2).map((l) => l.split(','));
assert(rows.length === SIZE * SIZE, `expected ${SIZE * SIZE} rows, got ${rows.length} — adjust LAT1/LON1 for the server's grid registration`);

// Rows come lat-outer ascending (south first). Flip to north-up for display.
const values = new Float64Array(SIZE * SIZE);
for (let i = 0; i < rows.length; i++) {
  const srcRow = Math.floor(i / SIZE);
  const col = i % SIZE;
  const v = Math.round(Number(rows[i][2]));
  assert(Number.isFinite(v), `row ${i}: non-numeric altitude ${rows[i][2]}`);
  values[(SIZE - 1 - srcRow) * SIZE + col] = v;
}

let min = Infinity, max = -Infinity;
for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
assert(min >= -32768 && max <= 32767, `range [${min}, ${max}] exceeds int16`);
assert(max - min > 1000, `relief only ${max - min}m — crop is too flat, pick another`);

const dir = outDir('etopo-dem');
writeInt16Bin(dir, 'elevation.bin', values);
const manifest: DatasetManifest = {
  id: 'etopo-dem',
  shape: [SIZE, SIZE],
  attribution: {
    source: 'NOAA NCEI ETOPO Global Relief (via ERDDAP)',
    source_url: 'https://www.ncei.noaa.gov/products/etopo-global-relief-model',
    retrieved: today(),
    license: 'U.S. Government work — public domain',
  },
  spatial: {
    crs: 'EPSG:4326',
    bbox: [LON0, LAT0, LON1, LAT1],
    transform: [LON0, STEP_R, 0, LAT1, 0, -STEP_R],
  },
  variables: [{
    name: 'elevation', kind: 'number', dtype: 'int16', file: 'elevation.bin',
    min, max,
    logicalType: { type: 'integer', min, max, generation: 'smooth' },
  }],
};
writeManifest(dir, manifest);
console.log(`etopo-dem: ${SIZE}×${SIZE}, range [${min}, ${max}]m → ${dir}`);
