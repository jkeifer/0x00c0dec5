/**
 * GHCN-Daily station rows → data-branch-work/datasets/ghcn-daily/.
 * Source: NOAA NCEI GHCN-Daily by-station CSVs (public domain).
 * Columns kept: DATE (int yyyymmdd, sorted per station), TMAX/TMIN/PRCP
 * (tenths, int16), station NAME (categorical — long runs across the
 * concatenated stations: the dictionary/RLE payoff). Rows missing any kept
 * value are dropped (spec: no missingness modeling in v1).
 */
import { assert, fetchText, outDir, parseCsvLine, today, writeInt16Bin, writeInt32Bin, writeManifest, writeStringColumn } from './lib.ts';
import type { DatasetManifest } from '../../src/datasets/types.ts';

const STATIONS = [
  'USW00094728', // NYC Central Park
  'USW00023174', // Los Angeles Intl
  'USW00012839', // Miami Intl
  'USW00024233', // Seattle-Tacoma Intl
];
const MAX_ROWS = 250_000;
const BASE = 'https://www.ncei.noaa.gov/data/global-historical-climatology-network-daily/access';

const date: number[] = [], tmax: number[] = [], tmin: number[] = [], prcp: number[] = [];
const station: string[] = [];

for (const id of STATIONS) {
  const csv = await fetchText(`${BASE}/${id}.csv`);
  const lines = csv.trim().split('\n');
  const header = parseCsvLine(lines[0]);
  const col = (name: string) => {
    const i = header.indexOf(name);
    assert(i >= 0, `${id}: column ${name} missing`);
    return i;
  };
  const cDate = col('DATE'), cName = col('NAME'), cTmax = col('TMAX'), cTmin = col('TMIN'), cPrcp = col('PRCP');
  let kept = 0;
  for (const line of lines.slice(1)) {
    if (date.length >= MAX_ROWS) break;
    const f = parseCsvLine(line);
    const [dt, tx, tn, pr] = [f[cDate], f[cTmax], f[cTmin], f[cPrcp]];
    if (!dt || tx === '' || tn === '' || pr === '') continue;
    const d = Number(dt.replaceAll('-', ''));
    const [txN, tnN, prN] = [Number(tx), Number(tn), Number(pr)];
    if (![d, txN, tnN, prN].every(Number.isFinite)) continue;
    if (Math.abs(txN) > 32767 || Math.abs(tnN) > 32767 || prN < 0 || prN > 32767) continue;
    date.push(d); tmax.push(txN); tmin.push(tnN); prcp.push(prN);
    station.push(f[cName]);
    kept++;
  }
  console.log(`${id}: kept ${kept} rows`);
}
assert(date.length >= 50_000, `only ${date.length} rows total — add stations`);
const zeros = prcp.filter((v) => v === 0).length;
assert(zeros / prcp.length > 0.3, `prcp only ${Math.round(100 * zeros / prcp.length)}% zeros — RLE lesson needs more`);

const n = date.length;
const dir = outDir('ghcn-daily');
writeInt32Bin(dir, 'date.bin', date);
writeInt16Bin(dir, 'tmax.bin', tmax);
writeInt16Bin(dir, 'tmin.bin', tmin);
writeInt16Bin(dir, 'prcp.bin', prcp);
const stationFiles = writeStringColumn(dir, 'station', station);

// Single-pass min/max — never Math.min(...bigArray): spreading 250K args overflows the stack.
function range(a: number[]): { min: number; max: number } {
  let min = Infinity, max = -Infinity;
  for (const v of a) { if (v < min) min = v; if (v > max) max = v; }
  return { min, max };
}
const rDate = range(date), rTmax = range(tmax), rTmin = range(tmin), rPrcp = range(prcp);

const manifest: DatasetManifest = {
  id: 'ghcn-daily',
  shape: [n],
  attribution: {
    source: 'NOAA NCEI GHCN-Daily (4 US stations)',
    source_url: 'https://www.ncei.noaa.gov/products/land-based-station/global-historical-climatology-network-daily',
    retrieved: today(),
    license: 'U.S. Government work — public domain',
  },
  variables: [
    { name: 'date', kind: 'number', dtype: 'int32', file: 'date.bin', min: rDate.min, max: rDate.max,
      logicalType: { type: 'integer', min: rDate.min, max: rDate.max, generation: 'sorted' } },
    { name: 'tmax', kind: 'number', dtype: 'int16', file: 'tmax.bin', min: rTmax.min, max: rTmax.max,
      logicalType: { type: 'integer', min: rTmax.min, max: rTmax.max, generation: 'smooth' } },
    { name: 'tmin', kind: 'number', dtype: 'int16', file: 'tmin.bin', min: rTmin.min, max: rTmin.max,
      logicalType: { type: 'integer', min: rTmin.min, max: rTmin.max, generation: 'smooth' } },
    { name: 'prcp', kind: 'number', dtype: 'int16', file: 'prcp.bin', min: rPrcp.min, max: rPrcp.max,
      logicalType: { type: 'integer', min: rPrcp.min, max: rPrcp.max, generation: 'stepped' } },
    { name: 'station', kind: 'string', ...stationFiles,
      logicalType: { type: 'text', min: 0, max: 0, wordSet: 'stations', generation: 'stepped' } },
  ],
};
writeManifest(dir, manifest);
console.log(`ghcn-daily: ${n} rows, ${new Set(station).size} stations → ${dir}`);
