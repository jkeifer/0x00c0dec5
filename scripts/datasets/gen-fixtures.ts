/**
 * Deterministic synthetic fixtures mirroring the real datasets' manifests
 * (same ids, variable names, dtypes, kinds — tiny shapes). Committed under
 * tests/fixtures/datasets/ and used by: unit tests (fs), the vite dev
 * middleware fallback, and the dataset scenario. Regenerate:
 *   npx tsx scripts/datasets/gen-fixtures.ts
 */
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { writeInt16Bin, writeInt32Bin, writeFloat32Bin, writeStringColumn, writeManifest } from './lib.ts';
import type { DatasetManifest } from '../../src/datasets/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, '..', '..', 'tests', 'fixtures', 'datasets');
const ATT = { source: 'synthetic test fixture', source_url: 'https://example.invalid', retrieved: '2026-07-12', license: 'n/a (generated)' };

function dir(id: string): string {
  const d = path.join(FIXTURE_ROOT, id);
  mkdirSync(d, { recursive: true });
  return d;
}

// etopo-dem: 16×16 smooth int ramp — delta-compressible like real terrain
{
  const S = 16;
  const vals = new Float64Array(S * S);
  for (let r = 0; r < S; r++) for (let c = 0; c < S; c++) vals[r * S + c] = 100 + r * 5 + Math.round(3 * Math.sin(c));
  const d = dir('etopo-dem');
  writeInt16Bin(d, 'elevation.bin', vals);
  const m: DatasetManifest = {
    id: 'etopo-dem', shape: [S, S], attribution: ATT,
    variables: [{ name: 'elevation', kind: 'number', dtype: 'int16', file: 'elevation.bin', min: 97, max: 178,
      logicalType: { type: 'integer', min: 97, max: 178, generation: 'smooth' } }],
  };
  writeManifest(d, m);
}

// sst-field: 16×16 smooth float32
{
  const S = 16;
  const vals = new Float64Array(S * S);
  for (let r = 0; r < S; r++) for (let c = 0; c < S; c++) vals[r * S + c] = 20 + Math.sin(r / 4) + Math.cos(c / 4);
  const d = dir('sst-field');
  writeFloat32Bin(d, 'sst.bin', vals);
  const m: DatasetManifest = {
    id: 'sst-field', shape: [S, S], attribution: ATT,
    variables: [{ name: 'sst', kind: 'number', dtype: 'float32', file: 'sst.bin', min: 18, max: 22,
      logicalType: { type: 'continuous', min: 18, max: 22, significantFigures: 6, generation: 'smooth' } }],
  };
  writeManifest(d, m);
}

// ghcn-daily: 96 rows, 2 stations with long runs, zero-heavy prcp.
// Mirrors the real extraction: date is days-since-epoch, and the temperature
// bins hold tenths with manifest `scale: 10`.
{
  const N = 96;
  const date: number[] = [], tmax: number[] = [], tmin: number[] = [], prcp: number[] = [], station: string[] = [];
  for (let i = 0; i < N; i++) {
    date.push(18262 + Math.floor(i / 2)); // 18262 = 2020-01-01
    tmax.push(150 + Math.round(30 * Math.sin(i / 10)));
    tmin.push(50 + Math.round(30 * Math.sin(i / 10)));
    prcp.push(i % 7 === 0 ? 25 : 0);
    station.push(i < N / 2 ? 'ALPHA STATION' : 'BETA STATION');
  }
  const d = dir('ghcn-daily');
  writeInt32Bin(d, 'date.bin', date);
  writeInt16Bin(d, 'tmax.bin', tmax);
  writeInt16Bin(d, 'tmin.bin', tmin);
  writeInt16Bin(d, 'prcp.bin', prcp);
  const stationFiles = writeStringColumn(d, 'station', station);
  const m: DatasetManifest = {
    id: 'ghcn-daily', shape: [N], attribution: ATT,
    variables: [
      { name: 'date', kind: 'number', dtype: 'int32', file: 'date.bin', min: 18262, max: 18309,
        logicalType: { type: 'integer', min: 18262, max: 18309, generation: 'sorted' } },
      { name: 'tmax', kind: 'number', dtype: 'int16', file: 'tmax.bin', scale: 10, min: 12, max: 18,
        logicalType: { type: 'decimal', min: 12, max: 18, decimalPlaces: 1, generation: 'smooth' } },
      { name: 'tmin', kind: 'number', dtype: 'int16', file: 'tmin.bin', scale: 10, min: 2, max: 8,
        logicalType: { type: 'decimal', min: 2, max: 8, decimalPlaces: 1, generation: 'smooth' } },
      { name: 'prcp', kind: 'number', dtype: 'int16', file: 'prcp.bin', scale: 10, min: 0, max: 2.5,
        logicalType: { type: 'decimal', min: 0, max: 2.5, decimalPlaces: 1, generation: 'stepped' } },
      { name: 'station', kind: 'string', ...stationFiles,
        logicalType: { type: 'text', min: 0, max: 0, wordSet: 'stations', generation: 'stepped' } },
    ],
  };
  writeManifest(d, m);
}
console.log(`fixtures written to ${FIXTURE_ROOT}`);
