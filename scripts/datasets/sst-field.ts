/**
 * Ocean-only SST crop → data-branch-work/datasets/sst-field/.
 * Source: JPL MUR 0.01° SST via NOAA CoastWatch ERDDAP (jplMURSST41).
 * The crop is a central-Pacific box chosen to contain zero land; the
 * NaN/finite assertion in writeFloat32Bin is the hard gate — if it trips,
 * move the box. If the dataset id 404s, find the current MUR griddap
 * dataset on coastwatch.pfeg.noaa.gov/erddap and update.
 */
import { assert, fetchText, outDir, today, writeFloat32Bin, writeManifest } from './lib.ts';
import type { DatasetManifest } from '../../src/datasets/types.ts';

const SIZE = 1024;
const STEP = 0.01;
const LAT0 = -5.0, LON0 = -150.0; // central Pacific, no land within 10.24°
const LAT1 = LAT0 + (SIZE - 1) * STEP;
const LON1 = LON0 + (SIZE - 1) * STEP;
// Recent date with data (MUR lags a few days); adjust if the server returns
// an out-of-range error.
const TIME = '2026-07-01T09:00:00Z';
const DATASET_URL =
  `https://coastwatch.pfeg.noaa.gov/erddap/griddap/jplMURSST41.csv?` +
  `analysed_sst%5B(${TIME})%5D%5B(${LAT0}):(${LAT1})%5D%5B(${LON0}):(${LON1})%5D`;

const csv = await fetchText(DATASET_URL);
const lines = csv.trim().split('\n');
const rows = lines.slice(2).map((l) => l.split(','));
assert(rows.length === SIZE * SIZE, `expected ${SIZE * SIZE} rows, got ${rows.length}`);

const values = new Float64Array(SIZE * SIZE);
for (let i = 0; i < rows.length; i++) {
  const srcRow = Math.floor(i / SIZE);
  const col = i % SIZE;
  values[(SIZE - 1 - srcRow) * SIZE + col] = Number(rows[i][3]); // time,lat,lon,sst
}
// Unit sanity: MUR serves °C on this server; if it's Kelvin, normalize.
let sum = 0; for (const v of values) sum += v;
const mean = sum / values.length;
if (mean > 100) for (let i = 0; i < values.length; i++) values[i] -= 273.15;
let min = Infinity, max = -Infinity;
for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
assert(min > -3 && max < 40, `SST range [${min}, ${max}]°C implausible`);

const dir = outDir('sst-field');
writeFloat32Bin(dir, 'sst.bin', values); // asserts every value finite (no land)
const round2 = (x: number) => Math.round(x * 100) / 100;
const manifest: DatasetManifest = {
  id: 'sst-field',
  shape: [SIZE, SIZE],
  attribution: {
    source: 'JPL MUR SST v4.1 (via NOAA CoastWatch ERDDAP)',
    source_url: 'https://podaac.jpl.nasa.gov/dataset/MUR-JPL-L4-GLOB-v4.1',
    retrieved: today(),
    license: 'Open data — NASA JPL PO.DAAC',
  },
  variables: [{
    name: 'sst', kind: 'number', dtype: 'float32', file: 'sst.bin',
    min: round2(min), max: round2(max),
    logicalType: { type: 'continuous', min: round2(min), max: round2(max), significantFigures: 6, generation: 'smooth' },
  }],
};
writeManifest(dir, manifest);
console.log(`sst-field: ${SIZE}×${SIZE}, range [${round2(min)}, ${round2(max)}]°C → ${dir}`);
