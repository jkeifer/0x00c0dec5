/**
 * Copernicus GLO-30 elevation crop → data-branch-work/datasets/copernicus-dem/.
 * Source: Copernicus DEM GLO-30 (float32 metres), resolved via Earth Search
 * (Element84 STAC, collection `cop-dem-glo-30`) and read straight out of the
 * public COG on AWS with range requests — no CSV endpoint like the ETOPO/MUR
 * siblings, so this one uses geotiff.js — a declared devDependency
 * (package.json), restored by `npm install`; no manual install needed.
 *
 * Why a NEW elevation dataset when we already have ETOPO: ETOPO is integer
 * metres — nothing to quantise. Copernicus is float32 with a real fractional
 * part whose sub-metre precision is below the model's true accuracy, so it's
 * the honest vehicle for the decimal→quantise→scale/offset→delta→entropy arc.
 *
 * Region: Jotunheimen, Norway (Galdhøpiggen, ~2469 m) — deep valleys near sea
 * level to alpine peaks gives dramatic relief (great for the delta lesson)
 * while staying under ~3276 m, so a tidy scale=10 (0.1 m grid) still fits int16
 * (2469×10 = 24690 < 32767). It's a land DEM: no bathymetry, so min ≈ 0, no
 * negatives — offset stays 0 and the scale/offset lesson is just a clean ×10.
 */
import { fromUrl } from 'geotiff';
import { assert, outDir, today, writeFloat32Bin, writeManifest } from './lib.ts';
import type { DatasetManifest } from '../../src/datasets/types.ts';

const SIZE = 1024;
const STEP = 1 / 3600; // GLO-30 ≈ 1 arc-second
// North-west (top-left) corner of the crop, in degrees. Galdhøpiggen sits a
// little in from this corner; SIZE×STEP spans ~0.284°.
const LAT_N = 61.79, LON_W = 8.17;
const LAT_S = LAT_N - SIZE * STEP;
const LON_E = LON_W + SIZE * STEP;
const STEP_R = 0.0002778; // 1/3600 to 7 sig figs, for the manifest/seed

// 1. Ask Earth Search which COG covers the crop centre.
const searchRes = await fetch('https://earth-search.aws.element84.com/v1/search', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    collections: ['cop-dem-glo-30'],
    bbox: [LON_W, LAT_S, LON_E, LAT_N],
    limit: 1,
  }),
});
assert(searchRes.ok, `STAC search HTTP ${searchRes.status}`);
const fc = await searchRes.json();
const href: string | undefined = fc.features?.[0]?.assets?.data?.href;
assert(href, 'no cop-dem-glo-30 item intersects the crop bbox — move LAT_N/LON_W');
// Earth Search hands back an s3:// href; geotiff's fetch client only speaks
// http(s). Rewrite to the bucket's regional virtual-hosted HTTPS endpoint
// (copernicus-dem-30m is a public AWS Open Data bucket in eu-central-1 — use
// the regional host, not the us-east-1 global one, which 301s for it).
const S3_REGION = 'eu-central-1';
const cogUrl = href.replace(
  /^s3:\/\/([^/]+)\/(.+)$/,
  (_m, bucket, key) => `https://${bucket}.s3.${S3_REGION}.amazonaws.com/${key}`,
);
console.log(`fetching ${cogUrl}`);

// 2. Windowed read from the COG (range requests → only the crop's tiles).
const tiff = await fromUrl(cogUrl);
const image = await tiff.getImage();
const [ox, oy] = image.getOrigin();       // top-left corner, degrees
const [rx, ry] = image.getResolution();   // (+lon/px, -lat/px)
// Geographic corner → pixel window. ry is negative (north-up).
const x0 = Math.round((LON_W - ox) / rx);
const y0 = Math.round((LAT_N - oy) / ry);
assert(x0 >= 0 && y0 >= 0 && x0 + SIZE <= image.getWidth() && y0 + SIZE <= image.getHeight(),
  `window [${x0},${y0}]+${SIZE} escapes the ${image.getWidth()}×${image.getHeight()} tile — crop straddles a tile edge, nudge the bbox`);
const [band] = await image.readRasters({ window: [x0, y0, x0 + SIZE, y0 + SIZE] }) as unknown as Float32Array[];
assert(band.length === SIZE * SIZE, `expected ${SIZE * SIZE} px, got ${band.length}`);

// COGs are already north-up (row 0 = northmost), so no flip — unlike the
// ERDDAP CSV siblings which come south-first.
const values = new Float64Array(SIZE * SIZE);
let min = Infinity, max = -Infinity;
for (let i = 0; i < band.length; i++) {
  const v = band[i];
  // GLO-30 nodata is a large negative sentinel; a clean land crop has none.
  assert(Number.isFinite(v) && v > -1000, `px ${i}=${v}: nodata/sea in crop — move the bbox`);
  values[i] = v;
  if (v < min) min = v;
  if (v > max) max = v;
}
assert(max - min > 1000, `relief only ${(max - min).toFixed(0)} m — crop too flat`);
assert(max * 10 < 32767, `max ${max.toFixed(1)} m ×10 overflows int16 — pick a lower region or drop scale`);

const dir = outDir('copernicus-dem');
writeFloat32Bin(dir, 'elevation.bin', values); // real metres, decimals intact
const round1 = (x: number) => Math.round(x * 10) / 10;
const manifest: DatasetManifest = {
  id: 'copernicus-dem',
  shape: [SIZE, SIZE],
  attribution: {
    source: 'Copernicus DEM GLO-30 (via Earth Search / AWS)',
    source_url: 'https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM',
    retrieved: today(),
    license: 'Copernicus DEM — free and open (ESA), attribution required',
  },
  spatial: {
    crs: 'EPSG:4326',
    bbox: [round1(LON_W), round1(LAT_S), round1(LON_E), round1(LAT_N)],
    transform: [round1(LON_W), STEP_R, 0, round1(LAT_N), 0, -STEP_R],
  },
  // scale intentionally ABSENT: the bin holds logical metres directly (float32).
  // Turning that into a scaled int16 is the LESSON, shipped in the preset's
  // typeAssignment, not pre-baked into the bin.
  variables: [{
    name: 'elevation', kind: 'number', dtype: 'float32', file: 'elevation.bin',
    min: round1(min), max: round1(max),
    logicalType: { type: 'decimal', min: round1(min), max: round1(max), decimalPlaces: 1, generation: 'smooth' },
  }],
};
writeManifest(dir, manifest);
console.log(`copernicus-dem: ${SIZE}×${SIZE}, range [${round1(min)}, ${round1(max)}] m → ${dir}`);
