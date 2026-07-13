# Dataset Presets (Real Data) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Selectable real-data dataset presets (ETOPO DEM, SST field, GHCN daily tabular) alongside the current generator, with binaries on an orphan `data` branch fetched at runtime.

**Architecture:** `AppState.dataset` selects a dataset; a small main-branch registry maps ids to remote manifest URLs and curated pipeline defaults; script-generated manifests + little-endian `.bin` files live on the orphan `data` branch (raw.githubusercontent URLs, CORS `*`). The worker fetches+caches values per dataset id and injects them into `computeValuesStage` in place of `generateValues`. Schema editing locks while a dataset is active.

**Tech Stack:** React + TypeScript + Vite (existing). No new dependencies — extraction uses Node ≥18 global `fetch` + hand-rolled CSV parsing, run via `npx tsx`.

**Spec:** `docs/superpowers/specs/2026-07-12-dataset-presets-design.md`. One deliberate refinement over the spec: `dataset` is `{ id, attribution } | null` (not `?: undefined`) so JSON persistence and `deepMergeDefaults` (which only keeps keys present in `DEFAULT_STATE`) handle it without undefined-dropping ambiguity. `APPLY_DATASET` carries a prebuilt `DatasetApplication` (the manifest fetch happens in the provider wrapper, keeping the reducer pure, matching `loadPreset`'s architecture).

## Global Constraints

- **No new dependencies** (dev or runtime). Extraction scripts: Node ≥18 `fetch`, `npx tsx` (same pattern as `scripts/gen-presets.ts`).
- **Unit tests in `tests/unit/`**, never `src/`. Scenario tests build on `tests/ui/scenario-helpers.mjs`.
- **TDD**: failing test first for every engine/state change.
- **Commit per task**; prek hooks run eslint + `tsc -b`. Do not create branches; never touch the remote.
- **Never commit MB-scale data to main.** Real extracted outputs go to `data-branch-work/` (gitignored). Only the tiny synthetic fixtures under `tests/fixtures/datasets/` are committed.
- Vite base path is `/0x00c0dec5/`; dev server serves at `http://localhost:5173/0x00c0dec5/`.
- Styling: inline styles from `src/theme.ts`. New interactive elements get `data-testid`s per CLAUDE.md conventions.
- Codec keys (exact, from `src/engine/codecs.ts`): `delta`, `zigzag`, `byte-shuffle`, `bit-shuffle`, `dictionary`, `rle`, `zstd`, `gzip`, `deflate`. `CodecStep = { codec: string; params: Record<string, number | string> }`.
- `ValueArray = LogicalValue[] | Float64Array` (`src/engine/layout.ts:11`); numeric dataset values decode to `Float64Array`, string columns to `string[]`.
- Bins are **little-endian**; decode with explicit-LE `DataView` reads (never bare typed-array views — platform-endianness-dependent).

---

### Task DP-1: Manifest types + asset decoding (`src/datasets/`)

**Files:**
- Create: `src/datasets/types.ts`
- Create: `src/datasets/assets.ts`
- Test: `tests/unit/datasets/assets.test.ts`

**Interfaces:**
- Consumes: `DtypeKey`, `LogicalTypeConfig` (existing types), `ValueArray` from `src/engine/layout.ts`.
- Produces (used by DP-2/3/4/5):
  - `DatasetId = 'etopo-dem' | 'sst-field' | 'ghcn-daily'`
  - `DatasetManifest`, `ManifestVariable`, `DatasetAttribution` (shapes below)
  - `validateManifest(raw: unknown): DatasetManifest` (throws with a descriptive message)
  - `decodeNumericBin(buf: ArrayBuffer, dtype: NumericBinDtype, expectedLength: number, label: string): Float64Array`
  - `decodeStringColumn(dict: unknown, codesBuf: ArrayBuffer, codesDtype: 'uint8' | 'uint16', expectedLength: number, label: string): string[]`
  - `fetchDatasetValues(manifest: DatasetManifest, urlFor: (file: string) => string, fetchFn?: typeof fetch): Promise<Map<string, ValueArray>>`

- [ ] **Step 1: Write `src/datasets/types.ts`**

```ts
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
  min: number;         // observed at extraction (display/logicalType bounds)
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
```

- [ ] **Step 2: Write the failing tests**

`tests/unit/datasets/assets.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  validateManifest, decodeNumericBin, decodeStringColumn, fetchDatasetValues,
} from '../../../src/datasets/assets.ts';
import type { DatasetManifest } from '../../../src/datasets/types.ts';

function le16(values: number[]): ArrayBuffer {
  const buf = new ArrayBuffer(values.length * 2);
  const dv = new DataView(buf);
  values.forEach((v, i) => dv.setInt16(i * 2, v, true));
  return buf;
}

const MANIFEST: DatasetManifest = {
  id: 'etopo-dem',
  shape: [2, 2],
  attribution: { source: 's', source_url: 'u', retrieved: '2026-07-12', license: 'PD' },
  variables: [{
    name: 'elevation', kind: 'number', dtype: 'int16', file: 'elevation.bin',
    min: -3, max: 9,
    logicalType: { type: 'integer', min: -3, max: 9, generation: 'smooth' },
  }],
};

describe('validateManifest', () => {
  it('passes a well-formed manifest through', () => {
    expect(validateManifest(JSON.parse(JSON.stringify(MANIFEST)))).toEqual(MANIFEST);
  });
  it.each([
    ['not an object', 42],
    ['unknown id', { ...MANIFEST, id: 'nope' }],
    ['bad shape', { ...MANIFEST, shape: [0, 2] }],
    ['empty variables', { ...MANIFEST, variables: [] }],
    ['duplicate names', { ...MANIFEST, variables: [MANIFEST.variables[0], MANIFEST.variables[0]] }],
    ['bad dtype', { ...MANIFEST, variables: [{ ...MANIFEST.variables[0], dtype: 'int64' }] }],
    ['missing attribution', { ...MANIFEST, attribution: undefined }],
  ])('throws on %s', (_label, raw) => {
    expect(() => validateManifest(raw)).toThrow(/dataset manifest/i);
  });
});

describe('decodeNumericBin', () => {
  it('decodes int16 LE to Float64Array', () => {
    const out = decodeNumericBin(le16([-3, 0, 7, 9]), 'int16', 4, 'elevation.bin');
    expect(out).toBeInstanceOf(Float64Array);
    expect(Array.from(out)).toEqual([-3, 0, 7, 9]);
  });
  it('decodes float32 LE', () => {
    const buf = new ArrayBuffer(8);
    const dv = new DataView(buf);
    dv.setFloat32(0, 1.5, true); dv.setFloat32(4, -2.25, true);
    expect(Array.from(decodeNumericBin(buf, 'float32', 2, 'x.bin'))).toEqual([1.5, -2.25]);
  });
  it('throws on byte-length mismatch, naming the file', () => {
    expect(() => decodeNumericBin(le16([1, 2, 3]), 'int16', 4, 'elevation.bin'))
      .toThrow(/elevation\.bin.*8 bytes.*got 6/);
  });
});

describe('decodeStringColumn', () => {
  it('maps codes through the dict', () => {
    const codes = new Uint8Array([0, 1, 1, 0]).buffer;
    expect(decodeStringColumn(['a', 'b'], codes, 'uint8', 4, 'station'))
      .toEqual(['a', 'b', 'b', 'a']);
  });
  it('throws on out-of-range code', () => {
    const codes = new Uint8Array([0, 2]).buffer;
    expect(() => decodeStringColumn(['a', 'b'], codes, 'uint8', 2, 'station'))
      .toThrow(/station.*code 2/);
  });
  it('throws on non-string-array dict and on length mismatch', () => {
    expect(() => decodeStringColumn('nope', new Uint8Array([0]).buffer, 'uint8', 1, 's')).toThrow(/dict/i);
    expect(() => decodeStringColumn(['a'], new Uint8Array([0]).buffer, 'uint8', 2, 's')).toThrow(/2.*got 1/);
  });
});

describe('fetchDatasetValues', () => {
  const files = new Map<string, ArrayBuffer | string>([
    ['elevation.bin', le16([-3, 0, 7, 9])],
  ]);
  const fakeFetch = ((url: string) => {
    const key = url.split('/').pop()!;
    const body = files.get(key);
    if (body === undefined) return Promise.resolve(new Response(null, { status: 404 }));
    return Promise.resolve(new Response(body));
  }) as unknown as typeof fetch;

  it('fetches and decodes every variable, keyed by name', async () => {
    const vals = await fetchDatasetValues(MANIFEST, (f) => `http://x/${f}`, fakeFetch);
    expect(Array.from(vals.get('elevation') as Float64Array)).toEqual([-3, 0, 7, 9]);
  });
  it('rejects on HTTP error, naming the file', async () => {
    const m = { ...MANIFEST, variables: [{ ...MANIFEST.variables[0], file: 'missing.bin' }] };
    await expect(fetchDatasetValues(m, (f) => `http://x/${f}`, fakeFetch))
      .rejects.toThrow(/missing\.bin.*404/);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/unit/datasets/assets.test.ts`
Expected: FAIL — module `src/datasets/assets.ts` not found.

- [ ] **Step 4: Implement `src/datasets/assets.ts`**

```ts
import type { ValueArray } from '../engine/layout.ts';
import type {
  DatasetId, DatasetManifest, ManifestVariable, NumericBinDtype,
} from './types.ts';

const DATASET_IDS: readonly string[] = ['etopo-dem', 'sst-field', 'ghcn-daily'];
const NUMERIC_DTYPES: readonly string[] = ['int16', 'int32', 'float32', 'float64'];
const CODES_DTYPES: readonly string[] = ['uint8', 'uint16'];

function fail(msg: string): never {
  throw new Error(`dataset manifest invalid: ${msg}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Structural validation of a fetched manifest. Throws (never coerces):
 * a bad manifest is a data-branch bug, not user input — surface it. */
export function validateManifest(raw: unknown): DatasetManifest {
  if (!isRecord(raw)) fail('not an object');
  if (typeof raw.id !== 'string' || !DATASET_IDS.includes(raw.id)) fail(`unknown id ${JSON.stringify(raw.id)}`);
  if (!Array.isArray(raw.shape) || raw.shape.length === 0 ||
      !raw.shape.every((d) => typeof d === 'number' && Number.isInteger(d) && d > 0)) {
    fail('shape must be positive integers');
  }
  const att = raw.attribution;
  if (!isRecord(att) || ['source', 'source_url', 'retrieved', 'license'].some((k) => typeof att[k] !== 'string')) {
    fail('attribution must have source/source_url/retrieved/license strings');
  }
  if (!Array.isArray(raw.variables) || raw.variables.length === 0) fail('variables must be non-empty');
  const names = new Set<string>();
  for (const v of raw.variables) {
    if (!isRecord(v) || typeof v.name !== 'string' || v.name === '') fail('variable missing name');
    if (names.has(v.name)) fail(`duplicate variable name ${v.name}`);
    names.add(v.name);
    if (!isRecord(v.logicalType)) fail(`${v.name}: missing logicalType`);
    if (v.kind === 'number') {
      if (typeof v.dtype !== 'string' || !NUMERIC_DTYPES.includes(v.dtype)) fail(`${v.name}: bad dtype`);
      if (typeof v.file !== 'string') fail(`${v.name}: missing file`);
      if (typeof v.min !== 'number' || typeof v.max !== 'number') fail(`${v.name}: missing min/max`);
    } else if (v.kind === 'string') {
      if (typeof v.dictFile !== 'string' || typeof v.codesFile !== 'string') fail(`${v.name}: missing dict/codes file`);
      if (typeof v.codesDtype !== 'string' || !CODES_DTYPES.includes(v.codesDtype)) fail(`${v.name}: bad codesDtype`);
    } else {
      fail(`${v.name}: kind must be 'number' or 'string'`);
    }
  }
  return raw as unknown as DatasetManifest;
}

const READERS: Record<NumericBinDtype, { size: number; read: (dv: DataView, off: number) => number }> = {
  int16:   { size: 2, read: (dv, o) => dv.getInt16(o, true) },
  int32:   { size: 4, read: (dv, o) => dv.getInt32(o, true) },
  float32: { size: 4, read: (dv, o) => dv.getFloat32(o, true) },
  float64: { size: 8, read: (dv, o) => dv.getFloat64(o, true) },
};

/** Decode a little-endian numeric bin into logical (float64) values.
 * Explicit-LE DataView reads, not typed-array views (platform endianness). */
export function decodeNumericBin(
  buf: ArrayBuffer, dtype: NumericBinDtype, expectedLength: number, label: string,
): Float64Array {
  const { size, read } = READERS[dtype];
  const expectedBytes = expectedLength * size;
  if (buf.byteLength !== expectedBytes) {
    throw new Error(`dataset asset ${label}: expected ${expectedBytes} bytes (${expectedLength} × ${dtype}), got ${buf.byteLength}`);
  }
  const dv = new DataView(buf);
  const out = new Float64Array(expectedLength);
  for (let i = 0; i < expectedLength; i++) out[i] = read(dv, i * size);
  return out;
}

/** Decode a dictionary-coded string column: dict JSON + LE codes bin. */
export function decodeStringColumn(
  dict: unknown, codesBuf: ArrayBuffer, codesDtype: 'uint8' | 'uint16',
  expectedLength: number, label: string,
): string[] {
  if (!Array.isArray(dict) || !dict.every((s) => typeof s === 'string')) {
    throw new Error(`dataset asset ${label}: dict is not a string array`);
  }
  const size = codesDtype === 'uint8' ? 1 : 2;
  if (codesBuf.byteLength !== expectedLength * size) {
    throw new Error(`dataset asset ${label}: expected ${expectedLength * size} bytes of codes, got ${codesBuf.byteLength}`);
  }
  const dv = new DataView(codesBuf);
  const out = new Array<string>(expectedLength);
  for (let i = 0; i < expectedLength; i++) {
    const code = codesDtype === 'uint8' ? dv.getUint8(i) : dv.getUint16(i * 2, true);
    if (code >= dict.length) throw new Error(`dataset asset ${label}: code ${code} out of range (dict has ${dict.length})`);
    out[i] = dict[code];
  }
  return out;
}

async function fetchBuf(url: string, label: string, fetchFn: typeof fetch): Promise<ArrayBuffer> {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`dataset asset ${label}: fetch failed (${res.status}) — ${url}`);
  return res.arrayBuffer();
}

/** Fetch + decode every variable's values for a manifest. `urlFor` maps a
 * manifest-relative file name to an absolute URL (registry provides it). */
export async function fetchDatasetValues(
  manifest: DatasetManifest,
  urlFor: (file: string) => string,
  fetchFn: typeof fetch = fetch,
): Promise<Map<string, ValueArray>> {
  const n = manifest.shape.reduce((a, b) => a * b, 1);
  const out = new Map<string, ValueArray>();
  for (const v of manifest.variables as ManifestVariable[]) {
    if (v.kind === 'number') {
      out.set(v.name, decodeNumericBin(await fetchBuf(urlFor(v.file), v.file, fetchFn), v.dtype, n, v.file));
    } else {
      const dictRes = await fetchFn(urlFor(v.dictFile));
      if (!dictRes.ok) throw new Error(`dataset asset ${v.dictFile}: fetch failed (${dictRes.status})`);
      const dict = await dictRes.json();
      const codes = await fetchBuf(urlFor(v.codesFile), v.codesFile, fetchFn);
      out.set(v.name, decodeStringColumn(dict, codes, v.codesDtype, n, v.name));
    }
  }
  return out;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/unit/datasets/assets.test.ts`
Expected: all PASS.

- [ ] **Step 6: Full gate + commit**

Run: `npx vitest run && npm run lint`
Expected: all pass (1047 + new).

```bash
git add src/datasets/ tests/unit/datasets/
git commit -m "feat: dataset manifest types + asset decoding (dp-1)"
```

---

### Task DP-2: Registry + apply logic (`registry.ts`, `apply.ts`)

**Files:**
- Create: `src/datasets/registry.ts`
- Create: `src/datasets/apply.ts`
- Test: `tests/unit/datasets/apply.test.ts`

**Interfaces:**
- Consumes: DP-1's types; `Variable`, `TypeAssignment`, `AppState` from `src/types/state.ts`; `CodecStep`; `colors.palette` from `src/theme.ts`.
- Produces (used by DP-3/4/5/7):
  - `DATASET_BASE: string` (dev: `${BASE_URL}data-dev/`; prod: `https://raw.githubusercontent.com/jkeifer/0x00c0dec5/data/`)
  - `datasetUrl(id: DatasetId, file: string): string`
  - `DATASETS: DatasetRegistryEntry[]`, `datasetById(id: string): DatasetRegistryEntry | undefined`
  - `loadManifest(id: DatasetId, fetchFn?: typeof fetch): Promise<DatasetManifest>` (promise-cached; failed loads evicted so retry works)
  - `buildDatasetApplication(entry: DatasetRegistryEntry, manifest: DatasetManifest): DatasetApplication`
  - `DatasetApplication` (shape below — exactly what the reducer applies)

- [ ] **Step 1: Write the failing tests**

`tests/unit/datasets/apply.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { DATASETS, datasetById, datasetUrl } from '../../../src/datasets/registry.ts';
import { buildDatasetApplication } from '../../../src/datasets/apply.ts';
import type { DatasetManifest } from '../../../src/datasets/types.ts';

const GHCN_MANIFEST: DatasetManifest = {
  id: 'ghcn-daily',
  shape: [4],
  attribution: { source: 'NOAA', source_url: 'https://ncei.noaa.gov', retrieved: '2026-07-12', license: 'PD' },
  variables: [
    { name: 'date', kind: 'number', dtype: 'int32', file: 'date.bin', min: 20200101, max: 20200104,
      logicalType: { type: 'integer', min: 20200101, max: 20200104, generation: 'sorted' } },
    { name: 'station', kind: 'string', dictFile: 'station.dict.json', codesFile: 'station.codes.bin',
      codesDtype: 'uint8',
      logicalType: { type: 'text', min: 0, max: 0, wordSet: 'stations', generation: 'stepped' } },
  ],
};

describe('registry', () => {
  it('has all three datasets with model scoping', () => {
    expect(DATASETS.map((d) => d.id).sort()).toEqual(['etopo-dem', 'ghcn-daily', 'sst-field']);
    expect(datasetById('etopo-dem')!.dataModel).toBe('array');
    expect(datasetById('sst-field')!.dataModel).toBe('array');
    expect(datasetById('ghcn-daily')!.dataModel).toBe('tabular');
    expect(datasetById('nope')).toBeUndefined();
  });
  it('builds dataset-relative URLs', () => {
    expect(datasetUrl('etopo-dem', 'manifest.json')).toMatch(/\/datasets\/etopo-dem\/manifest\.json$/);
  });
});

describe('buildDatasetApplication', () => {
  const entry = datasetById('ghcn-daily')!;
  const app = buildDatasetApplication(entry, GHCN_MANIFEST);

  it('mints deterministic ids and palette colors', () => {
    expect(app.variables.map((v) => v.id)).toEqual(['ghcn-daily-date', 'ghcn-daily-station']);
    expect(app.variables.every((v) => typeof v.color === 'string' && v.color.length > 0)).toBe(true);
  });
  it('takes logicalType from the manifest and shape/dataset from entry+manifest', () => {
    expect(app.shape).toEqual([4]);
    expect(app.dataset).toEqual({ id: 'ghcn-daily', attribution: 'NOAA · PD' });
    expect(app.variables[0].logicalType.generation).toBe('sorted');
  });
  it('applies curated typeAssignment by name; falls back to bin dtype / char16', () => {
    // curated block covers these names — the assertions pin what registry.ts declares
    expect(app.variables[0].typeAssignment.storageDtype).toBe('int32');
    expect(app.variables[1].typeAssignment.storageDtype).toBe('char16');
  });
  it('keys fieldPipelines by minted variable id and ignores unknown curated names', () => {
    for (const key of Object.keys(app.fieldPipelines)) {
      expect(app.variables.some((v) => v.id === key)).toBe(true);
    }
    // curated names not present in the manifest (e.g. tmax here) simply don't appear
    expect(Object.keys(app.fieldPipelines)).not.toContain('ghcn-daily-tmax');
  });
  it('seeds provenance customEntries', () => {
    expect(app.customEntries).toEqual([
      { key: 'source', value: 'NOAA' },
      { key: 'source_url', value: 'https://ncei.noaa.gov' },
      { key: 'retrieved', value: '2026-07-12' },
      { key: 'license', value: 'PD' },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/datasets/apply.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/datasets/registry.ts`**

```ts
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
```

- [ ] **Step 4: Implement `src/datasets/apply.ts`**

```ts
import type { Variable } from '../types/state.ts';
import type { CodecStep } from '../types/codecs.ts';
import type { DatasetManifest } from './types.ts';
import type { DatasetRegistryEntry } from './registry.ts';
import { colors } from '../theme.ts';

/** Everything APPLY_DATASET writes into state, prebuilt outside the reducer
 * (the manifest fetch is async; the reducer stays pure — loadPreset pattern). */
export interface DatasetApplication {
  dataset: { id: string; attribution: string };
  shape: number[];
  chunkShape: number[];
  interleaving?: 'row' | 'column';
  linearization?: 'c' | 'fortran' | 'morton';
  variables: Variable[];
  fieldPipelines: Record<string, CodecStep[]>;
  chunkPipeline: CodecStep[];
  customEntries: { key: string; value: string }[];
}

export function buildDatasetApplication(
  entry: DatasetRegistryEntry,
  manifest: DatasetManifest,
): DatasetApplication {
  const variables: Variable[] = manifest.variables.map((mv, i) => ({
    id: `${manifest.id}-${mv.name}`,
    name: mv.name,
    logicalType: mv.logicalType,
    typeAssignment: entry.curated.typeAssignments[mv.name]
      ?? (mv.kind === 'number' ? { storageDtype: mv.dtype } : { storageDtype: 'char16' }),
    color: colors.palette[i % colors.palette.length],
  }));

  const fieldPipelines: Record<string, CodecStep[]> = {};
  for (const v of variables) {
    fieldPipelines[v.id] = entry.curated.fieldPipelines[v.name] ?? [];
  }

  const att = manifest.attribution;
  return {
    dataset: { id: manifest.id, attribution: `${att.source} · ${att.license}` },
    shape: [...manifest.shape],
    chunkShape: entry.curated.chunkShape.map((c, d) => Math.min(c, manifest.shape[d] ?? c)),
    interleaving: entry.curated.interleaving,
    linearization: entry.curated.linearization,
    variables,
    fieldPipelines,
    chunkPipeline: entry.curated.chunkPipeline ?? [],
    customEntries: [
      { key: 'source', value: att.source },
      { key: 'source_url', value: att.source_url },
      { key: 'retrieved', value: att.retrieved },
      { key: 'license', value: att.license },
    ],
  };
}
```

Check `AppState['linearization']`'s actual union in `src/types/state.ts` (imported from `engine/order.ts`) and use that type instead of the inline union if it differs.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/unit/datasets/`
Expected: PASS.

- [ ] **Step 6: Full gate + commit**

```bash
npx vitest run && npm run lint
git add src/datasets/ tests/unit/datasets/
git commit -m "feat: dataset registry + curated apply logic (dp-2)"
```

---

### Task DP-3: State wiring (reducer, provider, persistence)

**Files:**
- Modify: `src/types/state.ts` (AppState + DEFAULT_STATE + makeEmptyState)
- Modify: `src/state/useAppState.ts` (actions APPLY_DATASET / SET_DATASET_CUSTOM, schema-edit guards, provider wrappers)
- Modify: `src/state/persistence.ts` (validateState: dataset field)
- Test: `tests/unit/state/dataset.test.ts` (new; follow the existing reducer/persistence test files' style in `tests/unit/state/`)

**Interfaces:**
- Consumes: `DatasetApplication`, `buildDatasetApplication`, `loadManifest`, `datasetById` (DP-2).
- Produces:
  - `AppState.dataset: { id: string; attribution: string } | null` (DEFAULT_STATE and makeEmptyState: `null`)
  - Actions: `{ type: 'APPLY_DATASET'; application: DatasetApplication }`, `{ type: 'SET_DATASET_CUSTOM' }`
  - Provider context additions: `applyDataset(id: string): Promise<boolean>` (fetch manifest → snapshot custom slot → dispatch; `false` on failure), `selectCustomDataset(): void`
  - Reducer guards: while `state.dataset !== null`, `SET_SHAPE`/`ADD_VARIABLE`/`REMOVE_VARIABLE` are no-ops, and `UPDATE_VARIABLE` strips `name`/`logicalType` changes (typeAssignment still applies)

- [ ] **Step 1: Write the failing tests**

`tests/unit/state/dataset.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { reducer } from '../../../src/state/useAppState.ts';
import { validateExternalState } from '../../../src/state/persistence.ts';
import { DEFAULT_STATE } from '../../../src/types/state.ts';
import { datasetById } from '../../../src/datasets/registry.ts';
import { buildDatasetApplication } from '../../../src/datasets/apply.ts';
import type { DatasetManifest } from '../../../src/datasets/types.ts';

const MANIFEST: DatasetManifest = {
  id: 'ghcn-daily',
  shape: [4],
  attribution: { source: 'NOAA', source_url: 'u', retrieved: '2026-07-12', license: 'PD' },
  variables: [
    { name: 'date', kind: 'number', dtype: 'int32', file: 'date.bin', min: 1, max: 4,
      logicalType: { type: 'integer', min: 1, max: 4, generation: 'sorted' } },
  ],
};
const APPLICATION = buildDatasetApplication(datasetById('ghcn-daily')!, MANIFEST);

function applied() {
  return reducer(structuredClone(DEFAULT_STATE), { type: 'APPLY_DATASET', application: APPLICATION });
}

describe('APPLY_DATASET', () => {
  it('applies dataset, shape, variables, pipelines, customEntries', () => {
    const s = applied();
    expect(s.dataset).toEqual({ id: 'ghcn-daily', attribution: 'NOAA · PD' });
    expect(s.shape).toEqual([4]);
    expect(s.variables.map((v) => v.name)).toEqual(['date']);
    expect(Object.keys(s.fieldPipelines)).toEqual(['ghcn-daily-date']);
    expect(s.metadata.customEntries.map((e) => e.key)).toEqual(['source', 'source_url', 'retrieved', 'license']);
    expect(s.interleaving).toBe('column');
  });
});

describe('schema locks while dataset active', () => {
  it('SET_SHAPE / ADD_VARIABLE / REMOVE_VARIABLE are no-ops', () => {
    const s = applied();
    expect(reducer(s, { type: 'SET_SHAPE', shape: [9] })).toBe(s);
    expect(reducer(s, {
      type: 'ADD_VARIABLE',
      variable: { id: 'x', name: 'x', color: '#fff',
        logicalType: { type: 'integer', min: 0, max: 1, generation: 'random' },
        typeAssignment: { storageDtype: 'int16' } },
    })).toBe(s);
    expect(reducer(s, { type: 'REMOVE_VARIABLE', id: 'ghcn-daily-date' })).toBe(s);
  });
  it('UPDATE_VARIABLE strips name/logicalType but keeps typeAssignment', () => {
    const s = applied();
    const out = reducer(s, {
      type: 'UPDATE_VARIABLE', id: 'ghcn-daily-date',
      changes: { name: 'hax', typeAssignment: { storageDtype: 'int16' } },
    });
    expect(out.variables[0].name).toBe('date');
    expect(out.variables[0].typeAssignment.storageDtype).toBe('int16');
  });
});

describe('SET_DATASET_CUSTOM', () => {
  it('clears dataset, keeps schema and customEntries as starting point', () => {
    const s = reducer(applied(), { type: 'SET_DATASET_CUSTOM' });
    expect(s.dataset).toBeNull();
    expect(s.shape).toEqual([4]);
    expect(s.variables).toHaveLength(1);
    expect(s.metadata.customEntries).toHaveLength(4);
    // unlocked again
    expect(reducer(s, { type: 'SET_SHAPE', shape: [9] }).shape).toEqual([9]);
  });
});

describe('persistence validation', () => {
  it('passes a known, model-matching dataset through', () => {
    const s = validateExternalState({ ...structuredClone(DEFAULT_STATE), dataset: { id: 'ghcn-daily', attribution: 'a' } }, 'tabular');
    expect(s?.dataset).toEqual({ id: 'ghcn-daily', attribution: 'a' });
  });
  it.each([
    ['unknown id', { id: 'nope', attribution: 'a' }],
    ['wrong model', { id: 'etopo-dem', attribution: 'a' }], // array dataset in tabular state
    ['malformed', { id: 42 }],
    ['string', 'ghcn-daily'],
  ])('drops %s to null', (_l, dataset) => {
    const s = validateExternalState({ ...structuredClone(DEFAULT_STATE), dataset }, 'tabular');
    expect(s?.dataset).toBeNull();
  });
  it('defaults missing dataset to null', () => {
    const s = validateExternalState(structuredClone(DEFAULT_STATE), 'tabular');
    expect(s?.dataset).toBeNull();
  });
});
```

(If `DEFAULT_STATE` doesn't yet have `dataset`, the first compile fails — that's the failing test.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/state/dataset.test.ts`
Expected: FAIL (type error / unknown action).

- [ ] **Step 3: Implement**

`src/types/state.ts` — add to `AppState` (near `dataModel`):

```ts
  /**
   * Dataset preset (real data) selection. `null` = generated values (Custom).
   * `attribution` is copied from the manifest at apply time so the UI renders
   * it after a reload without a main-thread manifest refetch. Values are
   * NEVER persisted — the worker fetches+caches them by id.
   */
  dataset: { id: string; attribution: string } | null;
```

Add `dataset: null` to `DEFAULT_STATE` and to `makeEmptyState`'s return.

`src/state/useAppState.ts` — action types:

```ts
  // Dataset presets (real data): apply a prebuilt application (manifest was
  // fetched in the applyDataset wrapper; reducer stays pure), or return to
  // generated values keeping the schema as a starting point.
  | { type: 'APPLY_DATASET'; application: DatasetApplication }
  | { type: 'SET_DATASET_CUSTOM' }
```

Reducer cases:

```ts
    case 'APPLY_DATASET': {
      const a = action.application;
      return produce(state, (draft) => {
        draft.dataset = a.dataset;
        draft.shape = a.shape;
        draft.chunkShape = a.chunkShape;
        if (a.interleaving !== undefined) draft.interleaving = a.interleaving;
        if (a.linearization !== undefined) draft.linearization = a.linearization;
        draft.variables = a.variables;
        draft.fieldPipelines = a.fieldPipelines;
        draft.chunkPipeline = a.chunkPipeline;
        draft.metadata.customEntries = a.customEntries;
      });
    }

    case 'SET_DATASET_CUSTOM':
      if (state.dataset === null) return state;
      return produce(state, (draft) => {
        draft.dataset = null;
      });
```

Schema-edit guards (root-cause: one guard in the reducer covers every dispatch path, not just the disabled UI):

- `SET_SHAPE`: first line `if (state.dataset) return state;`
- `ADD_VARIABLE`: same guard.
- `REMOVE_VARIABLE`: same guard.
- `UPDATE_VARIABLE`: inside the produce, skip `name`/`logicalType` assignment when `draft.dataset` is set (typeAssignment line unchanged).

Provider wrappers (context value additions, after `loadPreset`):

```ts
  const applyDataset = useCallback(async (id: string): Promise<boolean> => {
    const entry = datasetById(id);
    if (!entry || entry.dataModel !== stateRef.current.dataModel) return false;
    try {
      const manifest = await loadManifest(entry.id);
      // Same snapshot contract as loadPreset: the pre-apply state is
      // recoverable via 'Custom (restore)'.
      saveCustomPreset(stateRef.current);
      dispatch({ type: 'APPLY_DATASET', application: buildDatasetApplication(entry, manifest) });
      return true;
    } catch {
      return false;
    }
  }, []);

  const selectCustomDataset = useCallback(() => {
    dispatch({ type: 'SET_DATASET_CUSTOM' });
  }, []);
```

Add both to `AppStateContextValue` (with doc comments in the file's existing style) and to the provider value object.

`src/state/persistence.ts` — in `validateState`, after the variables block:

```ts
  // Dataset presets: a persisted dataset ref must name a known dataset whose
  // model matches this state, else it degrades to generated (null) — same
  // graceful-degrade as every other field. (Values are never persisted; the
  // worker refetches by id.)
  const ds = state.dataset as unknown;
  if (
    !isPlainObject(ds) ||
    typeof ds.id !== 'string' ||
    typeof ds.attribution !== 'string' ||
    datasetById(ds.id)?.dataModel !== state.dataModel
  ) {
    state.dataset = null;
  }
```

Import `datasetById` from `../datasets/registry.ts` (no cycle: registry imports only types/theme/assets).

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/unit/state/ tests/unit/datasets/`
Expected: PASS, including all pre-existing state tests (the guards must not break them — existing tests run with `dataset: null`).

- [ ] **Step 5: Full gate + commit**

```bash
npx vitest run && npm run lint
git add src/types/state.ts src/state/ tests/unit/state/
git commit -m "feat: dataset state field, apply/custom actions, schema locks (dp-3)"
```

---

### Task DP-4: Pipeline injection + worker fetch (OPUS implementer)

**Files:**
- Modify: `src/engine/pipelineCompute.ts` (`computeValuesStage`, `computePipelineStages`, `createPipelineComputer`)
- Modify: `src/worker/pipeline.worker.ts` (dataset values cache + await before compute)
- Modify: `src/hooks/useWorkerPipeline.ts` (deps allowlist)
- Test: `tests/unit/engine/datasetValues.test.ts`

**Interfaces:**
- Consumes: `loadManifest`, `datasetUrl`, `fetchDatasetValues` (DP-1/2); `AppState.dataset` (DP-3).
- Produces:
  - `computeValuesStage(shape, variables, byteOrder?, presetValues?: Map<string, ValueArray>)` — when `presetValues` is present, every variable's values come from it (a missing name or wrong length throws)
  - `computePipelineStages(state, onStage?, presetValues?)`
  - `createPipelineComputer()` returns `(state, knownKeys?, onStage?, presetValues?) => PipelineDelta`; the values memo key gains `datasetId`
  - Worker: `ensureDatasetValues(state)` module-level cache; compute awaits it inside the existing try (failures → `ResultErr`)

- [ ] **Step 1: Write the failing tests**

`tests/unit/engine/datasetValues.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  computeValuesStage, computePipelineStages, createPipelineComputer,
} from '../../../src/engine/pipelineCompute.ts';
import { generateValues } from '../../../src/engine/generate.ts';
import { DEFAULT_STATE, type AppState, type Variable } from '../../../src/types/state.ts';

const VAR: Variable = {
  id: 'v1', name: 'elevation', color: '#fff',
  logicalType: { type: 'integer', min: -10, max: 10, generation: 'smooth' },
  typeAssignment: { storageDtype: 'int16' },
};

describe('computeValuesStage with presetValues', () => {
  it('uses injected values instead of the generator', () => {
    const preset = new Map([['elevation', new Float64Array([1, 2, 3, 4])]]);
    const withPreset = computeValuesStage([4], [VAR], 'little', preset);
    expect(withPreset.variableValues.get('elevation')).toBe(preset.get('elevation'));
    // and the stage bytes reflect the injected values, not generated ones
    const generated = computeValuesStage([4], [VAR], 'little');
    expect(withPreset.stage.bytes).not.toEqual(generated.stage.bytes);
  });

  it('equals the generated pipeline when injected values equal generated values', () => {
    const gen = generateValues(VAR.name, VAR.logicalType, 4);
    const preset = new Map([['elevation', gen]]);
    const a = computeValuesStage([4], [VAR], 'little');
    const b = computeValuesStage([4], [VAR], 'little', preset);
    expect(b.stage.bytes).toEqual(a.stage.bytes);
  });

  it('throws on missing variable name', () => {
    const preset = new Map([['wrong-name', new Float64Array([1, 2, 3, 4])]]);
    expect(() => computeValuesStage([4], [VAR], 'little', preset))
      .toThrow(/elevation.*not present/i);
  });

  it('throws on length mismatch, naming variable and counts', () => {
    const preset = new Map([['elevation', new Float64Array([1, 2])]]);
    expect(() => computeValuesStage([4], [VAR], 'little', preset))
      .toThrow(/elevation.*4.*got 2/);
  });
});

describe('full pipeline with presetValues', () => {
  it('round-trips: readResult.success true, encoded < typed for compressible data', () => {
    const n = 1024;
    const vals = new Float64Array(n);
    for (let i = 0; i < n; i++) vals[i] = 100 + Math.round(10 * Math.sin(i / 20)); // smooth terrain-ish
    const state: AppState = {
      ...structuredClone(DEFAULT_STATE),
      dataModel: 'array',
      dataset: { id: 'etopo-dem', attribution: 'test' },
      shape: [32, 32], chunkShape: [16, 16],
      variables: [VAR],
      fieldPipelines: { v1: [{ codec: 'delta', params: {} }, { codec: 'zigzag', params: {} }] },
      chunkPipeline: [],
    };
    const result = computePipelineStages(state, undefined, new Map([['elevation', vals]]));
    expect(result.readResult.success).toBe(true);
    // reconstructed values match the injected ones exactly (int16 storage, lossless codecs)
    const rec = result.stageSources; // reconstructed read values live in stage sources
    void rec;
    const typedBytes = result.stages[1].stats.byteCount;
    expect(typedBytes).toBe(n * 2); // int16
  });
});

describe('createPipelineComputer dataset keying', () => {
  it('invalidates the values stage when dataset id changes, hits when unchanged', () => {
    const compute = createPipelineComputer();
    const preset = new Map([['elevation', new Float64Array(16).fill(5)]]);
    const base: AppState = {
      ...structuredClone(DEFAULT_STATE),
      dataModel: 'array', shape: [4, 4], chunkShape: [4, 4],
      variables: [VAR], fieldPipelines: { v1: [] },
      dataset: { id: 'etopo-dem', attribution: 'a' },
    };
    const d1 = compute(base, {}, undefined, preset);
    // same state, client now knows the keys → values omitted from delta
    const known = Object.fromEntries(Object.entries(d1).map(([s, e]) => [s, e.key]));
    const d2 = compute(base, known, undefined, preset);
    expect(d2.values.payload).toBeUndefined();
    // dataset switched → values key changes → payload present
    const other = { ...base, dataset: { id: 'sst-field', attribution: 'a' } };
    const preset2 = new Map([['elevation', new Float64Array(16).fill(7)]]);
    const d3 = compute(other, known, undefined, preset2);
    expect(d3.values.key).not.toBe(d1.values.key);
    expect(d3.values.payload).toBeDefined();
  });

  it('throws if state names a dataset but no values were provided', () => {
    const compute = createPipelineComputer();
    const base: AppState = {
      ...structuredClone(DEFAULT_STATE), dataModel: 'array',
      shape: [4, 4], chunkShape: [4, 4], variables: [VAR], fieldPipelines: { v1: [] },
      dataset: { id: 'etopo-dem', attribution: 'a' },
    };
    expect(() => compute(base, {})).toThrow(/dataset.*not loaded/i);
  });
});
```

Adjust the round-trip assertion to whatever `PipelineResult` actually exposes for read-reconstructed values (`result.readResult.reconstructedValues` per `gen-presets.ts` — assert `Array.from(reconstructedValues.get('elevation'))` equals `Array.from(vals)`).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/engine/datasetValues.test.ts`
Expected: FAIL — `computeValuesStage` takes no 4th arg (TS error).

- [ ] **Step 3: Implement `pipelineCompute.ts` changes**

`computeValuesStage` (line ~101):

```ts
export function computeValuesStage(
  shape: number[],
  variables: Variable[],
  byteOrder: 'little' | 'big' = 'little',
  presetValues?: Map<string, ValueArray>,
): ValuesStageResult {
  const totalElements = shape.reduce((a, b) => a * b, 1);

  const variableValues = new Map<string, ValueArray>();
  for (const v of variables) {
    if (presetValues) {
      // Dataset preset: all-or-nothing. A missing name or wrong length means
      // the persisted schema and the fetched assets disagree — fail loudly
      // (surfaces via the worker's ResultErr path) rather than silently mixing
      // real and generated values.
      const vals = presetValues.get(v.name);
      if (!vals) throw new Error(`dataset values: variable "${v.name}" not present in the loaded dataset`);
      if (vals.length !== totalElements) {
        throw new Error(`dataset values: variable "${v.name}" expected ${totalElements} values, got ${vals.length} — re-select the dataset`);
      }
      variableValues.set(v.name, vals);
    } else {
      variableValues.set(v.name, generateValues(v.name, v.logicalType, totalElements));
    }
  }
  // ... rest unchanged
```

`computePipelineStages`: add `presetValues?: Map<string, ValueArray>` third parameter, thread into the `computeValuesStage` call only.

`createPipelineComputer`: returned function gains 4th param `presetValues?: Map<string, ValueArray>`. At the top of the returned function:

```ts
    if (state.dataset && !presetValues) {
      // The worker resolves values before calling compute; hitting this means
      // a caller skipped that step.
      throw new Error(`dataset "${state.dataset.id}" values not loaded before compute`);
    }
```

Values memo (line ~583): add `datasetId: state.dataset?.id ?? null` to the deps object and pass `presetValues` to `computeValuesStage`. (The typed/linearized/... stages chain off `valuesKey`, so nothing else changes.)

- [ ] **Step 4: Implement worker changes** (`src/worker/pipeline.worker.ts`)

```ts
import { loadManifest, datasetUrl, datasetById } from '../datasets/registry.ts';
import { fetchDatasetValues } from '../datasets/assets.ts';
import type { ValueArray } from '../engine/layout.ts';
import type { DatasetId } from '../datasets/types.ts';
```

```ts
// Dataset presets: values fetched+decoded once per dataset id and cached in
// worker memory for its lifetime (the slot the perf plan reserved). Promise-
// cached so concurrent computes share one fetch; failures evict for retry.
const datasetValuesCache = new Map<string, Promise<Map<string, ValueArray>>>();

function ensureDatasetValues(id: string): Promise<Map<string, ValueArray>> {
  let p = datasetValuesCache.get(id);
  if (!p) {
    p = (async () => {
      if (!datasetById(id)) throw new Error(`unknown dataset "${id}"`);
      const manifest = await loadManifest(id as DatasetId);
      return fetchDatasetValues(manifest, (file) => datasetUrl(id as DatasetId, file));
    })();
    p.catch(() => datasetValuesCache.delete(id));
    datasetValuesCache.set(id, p);
  }
  return p;
}
```

In `self.onmessage`, inside the existing `try`, before `computeDelta`:

```ts
    const presetValues = msg.state.dataset ? await ensureDatasetValues(msg.state.dataset.id) : undefined;
    const delta = computeDelta(msg.state, msg.knownKeys, (stage, ms) => { ... }, presetValues);
```

- [ ] **Step 5: `useWorkerPipeline.ts` deps**

Add `dataset` to the destructure at line 70 and the dep array at line 75, and extend the trailing comment sentence ("any new AppState field that reaches pipelineCompute must be added here") with `dataset` included in the list — this is exactly the CL-10 lesson.

```ts
  const { dataModel, shape, chunkShape, interleaving, linearization, byteOrder, variables, fieldPipelines, chunkPipeline, metadata, write, dataset } = state;
  useEffect(() => {
    ...
  }, [dataModel, shape, chunkShape, interleaving, linearization, byteOrder, variables, fieldPipelines, chunkPipeline, metadata, write, dataset]);
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run`
Expected: all PASS (new + 1047 existing — pay attention to any test invoking `createPipelineComputer` with a dataset-less state: unaffected by construction).

- [ ] **Step 7: Commit**

```bash
npm run lint
git add src/engine/pipelineCompute.ts src/worker/pipeline.worker.ts src/hooks/useWorkerPipeline.ts tests/unit/engine/datasetValues.test.ts
git commit -m "feat: preset-values injection through pipeline + worker dataset cache (dp-4)"
```

---

### Task DP-5: Extraction scripts + committed fixtures (network required)

**Files:**
- Create: `scripts/datasets/lib.ts` (shared: fetch, CSV parse, bin/manifest writers, assertions)
- Create: `scripts/datasets/etopo-dem.ts`, `scripts/datasets/sst-field.ts`, `scripts/datasets/ghcn-daily.ts`
- Create: `scripts/datasets/gen-fixtures.ts` (synthetic, deterministic, no network)
- Create: `scripts/datasets/README.md` (publish-to-orphan-branch instructions)
- Create (committed): `tests/fixtures/datasets/{etopo-dem,sst-field,ghcn-daily}/…` (tiny)
- Modify: `.gitignore` (+ `data-branch-work/`)
- Test: `tests/unit/datasets/fixtures.test.ts`

**Interfaces:**
- Consumes: manifest shape from DP-1 (scripts import `src/datasets/types.ts` ONLY — never `registry.ts`, whose `import.meta.env` doesn't exist under `tsx`).
- Produces: `data-branch-work/datasets/<id>/{manifest.json, *.bin, *.dict.json}` (real, uncommitted) and `tests/fixtures/datasets/<id>/…` (synthetic, committed). Fixture variable names/dtypes/model MUST match the registry's curated blocks — the fixtures test pins this.

- [ ] **Step 1: Write `scripts/datasets/lib.ts`**

```ts
/**
 * Shared helpers for the dataset extraction scripts (run manually:
 *   npx tsx scripts/datasets/etopo-dem.ts
 * Outputs go to data-branch-work/ — gitignored on main; committed to the
 * orphan `data` branch by hand, see README.md alongside this file).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatasetManifest } from '../../src/datasets/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const OUT_ROOT = path.join(__dirname, '..', '..', 'data-branch-work', 'datasets');

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`extraction failed: ${msg}`);
}

export async function fetchText(url: string): Promise<string> {
  console.log(`fetching ${url}`);
  const res = await fetch(url);
  assert(res.ok, `HTTP ${res.status} for ${url}`);
  return res.text();
}

/** Minimal CSV line parser handling double-quoted fields (GHCN NAME contains
 * commas). No embedded newlines in any source we use. */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

export function writeInt16Bin(dir: string, file: string, values: number[] | Float64Array): void {
  const buf = new ArrayBuffer(values.length * 2);
  const dv = new DataView(buf);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    assert(Number.isInteger(v) && v >= -32768 && v <= 32767, `${file}[${i}]=${v} not int16`);
    dv.setInt16(i * 2, v, true);
  }
  writeFileSync(path.join(dir, file), Buffer.from(buf));
}

export function writeInt32Bin(dir: string, file: string, values: number[]): void {
  const buf = new ArrayBuffer(values.length * 4);
  const dv = new DataView(buf);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    assert(Number.isInteger(v) && Math.abs(v) <= 0x7fffffff, `${file}[${i}]=${v} not int32`);
    dv.setInt32(i * 4, v, true);
  }
  writeFileSync(path.join(dir, file), Buffer.from(buf));
}

export function writeFloat32Bin(dir: string, file: string, values: number[] | Float64Array): void {
  const buf = new ArrayBuffer(values.length * 4);
  const dv = new DataView(buf);
  for (let i = 0; i < values.length; i++) {
    assert(Number.isFinite(values[i]), `${file}[${i}] not finite (NaN in crop?)`);
    dv.setFloat32(i * 4, values[i], true);
  }
  writeFileSync(path.join(dir, file), Buffer.from(buf));
}

export function writeStringColumn(dir: string, baseName: string, values: string[]): { dictFile: string; codesFile: string; codesDtype: 'uint8' | 'uint16' } {
  const dict = Array.from(new Set(values)).sort();
  assert(dict.length <= 65536, `${baseName}: dict too large`);
  const codesDtype = dict.length <= 256 ? 'uint8' : 'uint16';
  const index = new Map(dict.map((s, i) => [s, i]));
  const size = codesDtype === 'uint8' ? 1 : 2;
  const buf = new ArrayBuffer(values.length * size);
  const dv = new DataView(buf);
  values.forEach((s, i) => {
    const code = index.get(s)!;
    if (codesDtype === 'uint8') dv.setUint8(i, code);
    else dv.setUint16(i * 2, code, true);
  });
  const dictFile = `${baseName}.dict.json`;
  const codesFile = `${baseName}.codes.bin`;
  writeFileSync(path.join(dir, dictFile), JSON.stringify(dict, null, 1) + '\n');
  writeFileSync(path.join(dir, codesFile), Buffer.from(buf));
  return { dictFile, codesFile, codesDtype };
}

export function writeManifest(dir: string, manifest: DatasetManifest): void {
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

export function outDir(id: string): string {
  const dir = path.join(OUT_ROOT, id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
```

- [ ] **Step 2: Write `scripts/datasets/etopo-dem.ts`**

```ts
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
  variables: [{
    name: 'elevation', kind: 'number', dtype: 'int16', file: 'elevation.bin',
    min, max,
    logicalType: { type: 'integer', min, max, generation: 'smooth' },
  }],
};
writeManifest(dir, manifest);
console.log(`etopo-dem: ${SIZE}×${SIZE}, range [${min}, ${max}]m → ${dir}`);
```

- [ ] **Step 3: Write `scripts/datasets/sst-field.ts`**

```ts
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
```

- [ ] **Step 4: Write `scripts/datasets/ghcn-daily.ts`**

```ts
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
```

- [ ] **Step 5: Write `scripts/datasets/gen-fixtures.ts`**

Synthetic, deterministic, no network. Same variable names/dtypes/kinds as the real manifests, tiny shapes. Reuses lib writers, writes to `tests/fixtures/datasets/`:

```ts
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

// ghcn-daily: 96 rows, 2 stations with long runs, zero-heavy prcp
{
  const N = 96;
  const date: number[] = [], tmax: number[] = [], tmin: number[] = [], prcp: number[] = [], station: string[] = [];
  for (let i = 0; i < N; i++) {
    date.push(20200101 + Math.floor(i / 2));
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
      { name: 'date', kind: 'number', dtype: 'int32', file: 'date.bin', min: 20200101, max: 20200148,
        logicalType: { type: 'integer', min: 20200101, max: 20200148, generation: 'sorted' } },
      { name: 'tmax', kind: 'number', dtype: 'int16', file: 'tmax.bin', min: 120, max: 180,
        logicalType: { type: 'integer', min: 120, max: 180, generation: 'smooth' } },
      { name: 'tmin', kind: 'number', dtype: 'int16', file: 'tmin.bin', min: 20, max: 80,
        logicalType: { type: 'integer', min: 20, max: 80, generation: 'smooth' } },
      { name: 'prcp', kind: 'number', dtype: 'int16', file: 'prcp.bin', min: 0, max: 25,
        logicalType: { type: 'integer', min: 0, max: 25, generation: 'stepped' } },
      { name: 'station', kind: 'string', ...stationFiles,
        logicalType: { type: 'text', min: 0, max: 0, wordSet: 'stations', generation: 'stepped' } },
    ],
  };
  writeManifest(d, m);
}
console.log(`fixtures written to ${FIXTURE_ROOT}`);
```

Note `lib.ts`'s writers take an explicit dir, so they work for both roots — but `writeStringColumn`/`writeManifest` already do. Adjust `lib.ts` if any helper hardcodes `OUT_ROOT`.

- [ ] **Step 6: Failing fixtures test, then generate**

`tests/unit/datasets/fixtures.test.ts` — the cross-check that pins fixtures ↔ registry ↔ engine together (this is the test that catches curated-name drift):

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateManifest, fetchDatasetValues } from '../../../src/datasets/assets.ts';
import { DATASETS, datasetById } from '../../../src/datasets/registry.ts';
import { buildDatasetApplication } from '../../../src/datasets/apply.ts';
import { computePipelineStages } from '../../../src/engine/pipelineCompute.ts';
import { DEFAULT_STATE, type AppState } from '../../../src/types/state.ts';

const ROOT = path.join(__dirname, '..', '..', 'fixtures', 'datasets');

function fsFetch(id: string): typeof fetch {
  return (async (url: string | URL | Request) => {
    const file = String(url).split('/').pop()!;
    const buf = readFileSync(path.join(ROOT, id, file));
    return new Response(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  }) as typeof fetch;
}

describe.each(DATASETS.map((d) => [d.id] as const))('fixture %s', (id) => {
  const manifest = validateManifest(JSON.parse(readFileSync(path.join(ROOT, id, 'manifest.json'), 'utf-8')));
  const entry = datasetById(id)!;

  it('matches the registry: model + every curated name exists in the manifest', () => {
    const names = new Set(manifest.variables.map((v) => v.name));
    for (const name of Object.keys(entry.curated.typeAssignments)) expect(names.has(name)).toBe(true);
    for (const name of Object.keys(entry.curated.fieldPipelines)) expect(names.has(name)).toBe(true);
  });

  it('decodes, applies, computes, and read-roundtrips', async () => {
    const values = await fetchDatasetValues(manifest, (f) => `fixture://${id}/${f}`, fsFetch(id));
    const app = buildDatasetApplication(entry, manifest);
    const state: AppState = {
      ...structuredClone(DEFAULT_STATE),
      dataModel: entry.dataModel,
      dataset: app.dataset,
      shape: app.shape,
      chunkShape: app.chunkShape,
      interleaving: app.interleaving ?? DEFAULT_STATE.interleaving,
      linearization: app.linearization ?? structuredClone(DEFAULT_STATE).linearization,
      variables: app.variables,
      fieldPipelines: app.fieldPipelines,
      chunkPipeline: app.chunkPipeline,
    };
    const result = computePipelineStages(state, undefined, values);
    expect(result.readResult.success).toBe(true);
  });
});
```

Caveat for the implementer: `sst-field`'s curated pipeline uses `zstd` (a pyodide codec) — if `computePipelineStages` under vitest can't run pyodide codecs, the roundtrip test for that dataset should swap the curated pipeline for the state under test (e.g. replace fieldPipelines with `{}`) and assert the rest; check how existing tests handle pyodide codecs (`tests/unit/` has real-codec tests — follow their pattern; there is a node-side pyodide loader used by the P4 test suite).

Run: `npx vitest run tests/unit/datasets/fixtures.test.ts` → FAIL (no fixtures yet).

Generate: `npx tsx scripts/datasets/gen-fixtures.ts`
Re-run → PASS.

- [ ] **Step 7: Run the real extractions (network)**

```bash
npx tsx scripts/datasets/etopo-dem.ts
npx tsx scripts/datasets/sst-field.ts
npx tsx scripts/datasets/ghcn-daily.ts
ls -la data-branch-work/datasets/*/
```

Expected: three dirs; elevation.bin 2.0MB, sst.bin 4.0MB, ghcn bins ~2MB total. Each script prints its shape/range summary. **Adapt server URLs/coordinates if a source 404s or an assertion trips — the assertions are the contract.** If outbound network is unavailable in this session, mark this step as deferred in the task report and tell the user to run the three commands — everything else in the plan works off fixtures.

- [ ] **Step 8: Write `scripts/datasets/README.md`**

```markdown
# Dataset assets — extraction & publishing

Real data lives on the orphan `data` branch, never on main. The app fetches
`https://raw.githubusercontent.com/jkeifer/0x00c0dec5/data/datasets/<id>/…`
(see `src/datasets/registry.ts`; in dev, the vite middleware serves
`data-branch-work/` with a `tests/fixtures/datasets/` fallback).

## Extract (writes to gitignored data-branch-work/)

    npx tsx scripts/datasets/etopo-dem.ts
    npx tsx scripts/datasets/sst-field.ts
    npx tsx scripts/datasets/ghcn-daily.ts

## Publish to the data branch (by hand — agents never touch the remote)

    git worktree add ../0x00c0dec5-data data 2>/dev/null \
      || git worktree add --orphan -b data ../0x00c0dec5-data
    rsync -a --delete data-branch-work/datasets/ ../0x00c0dec5-data/datasets/
    cd ../0x00c0dec5-data
    git add -A && git commit -m "data: refresh dataset assets"
    git push -u origin data
    cd - && git worktree remove ../0x00c0dec5-data

## Fixtures

`scripts/datasets/gen-fixtures.ts` regenerates the tiny committed fixtures in
`tests/fixtures/datasets/` (synthetic, deterministic, no network). Keep their
variable names/dtypes in lockstep with the real scripts — the fixtures unit
test cross-checks them against the registry.
```

- [ ] **Step 9: gitignore + gate + commit**

Append `data-branch-work/` to `.gitignore`.

```bash
npx vitest run && npm run lint
git status --porcelain   # MUST show no data-branch-work/ entries
git add scripts/datasets/ tests/fixtures/datasets/ tests/unit/datasets/fixtures.test.ts .gitignore
git commit -m "feat: dataset extraction scripts + committed fixtures (dp-5)"
```

---

### Task DP-6: Dev middleware + service-worker data cache

**Files:**
- Modify: `vite.config.ts` (data-dev middleware plugin)
- Modify: `public/sw.js` (raw.githubusercontent data cache, network-first)

**Interfaces:**
- Consumes: `DATASET_BASE` contract from DP-2 (`/0x00c0dec5/data-dev/datasets/<id>/<file>` in dev).
- Produces: dev URLs resolve from `data-branch-work/` first, `tests/fixtures/` second; prod SW caches data-branch responses network-first (offline talk demo after one warm load).

- [ ] **Step 1: Middleware plugin in `vite.config.ts`**

```ts
import path from 'node:path'

// Dataset presets: serve /0x00c0dec5/data-dev/* in dev from the local
// extraction output (data-branch-work/), falling back to the committed
// synthetic fixtures (tests/fixtures/) so dev + scenarios work with no
// network and no extraction run. Prod uses the data branch's raw URLs
// (src/datasets/registry.ts).
const dataDevPlugin = () => ({
  name: 'serve-dataset-dev',
  configureServer(server: import('vite').ViteDevServer) {
    server.middlewares.use((req, res, next) => {
      const prefix = '/0x00c0dec5/data-dev/'
      const url = (req.url ?? '').split('?')[0]
      if (!url.startsWith(prefix)) return next()
      const rel = path.normalize(url.slice(prefix.length))
      if (rel.startsWith('..') || path.isAbsolute(rel)) { res.statusCode = 400; return res.end() }
      for (const root of ['data-branch-work', path.join('tests', 'fixtures')]) {
        const file = path.join(root, rel)
        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
          res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'application/octet-stream')
          return fs.createReadStream(file).pipe(res)
        }
      }
      res.statusCode = 404
      res.end(`dataset dev asset not found: ${rel} (run scripts/datasets/*.ts or gen-fixtures.ts)`)
    })
  },
})
```

Add `dataDevPlugin()` to the `plugins` array. (`fs` is already imported at the top of the config.) NOTE the URL layout: `data-dev/datasets/<id>/<file>` maps to `data-branch-work/datasets/<id>/<file>` and `tests/fixtures/datasets/<id>/<file>` — both roots contain a `datasets/` dir, so `rel` includes it.

- [ ] **Step 2: Verify manually**

```bash
npm run dev &
sleep 2
curl -s http://localhost:5173/0x00c0dec5/data-dev/datasets/etopo-dem/manifest.json | head -c 200
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5173/0x00c0dec5/data-dev/datasets/nope/x.bin
kill %1
```

Expected: manifest JSON (from data-branch-work if extracted, else fixture), then `404`.

- [ ] **Step 3: SW data cache** (`public/sw.js`)

After the pyodide constants:

```js
// Dataset presets: real-data assets from the orphan `data` branch. The
// branch is MUTABLE (branch-name URLs, not SHA-pinned), so unlike the
// pinned pyodide wheels this must be network-first with cache fallback —
// cache-first would pin stale data forever. Persistent across app deploys
// (not keyed to VERSION): the data lifecycle is independent of the app's.
const DATA_ORIGIN = 'https://raw.githubusercontent.com';
const DATA_PATH_PREFIX = '/jkeifer/0x00c0dec5/data/';
const DATA_CACHE = '0xc-data-v1';
```

In `activate`, keep it: extend the filter to `name !== CACHE && name !== PYODIDE_CACHE && name !== DATA_CACHE`.

In `fetch`, after the pyodide branch:

```js
    if (url.origin === DATA_ORIGIN) {
        if (!url.pathname.startsWith(DATA_PATH_PREFIX)) {
            return;
        }
        event.respondWith(
            (async () => {
                const cache = await self.caches.open(DATA_CACHE);
                try {
                    const response = await fetch(request);
                    if (response.ok) {
                        await cache.put(request, response.clone());
                    }
                    return response;
                } catch (error) {
                    const cached = await cache.match(request);
                    if (cached) {
                        return cached;
                    }
                    throw error;
                }
            })()
        );
        return;
    }
```

- [ ] **Step 4: Gate + commit**

```bash
npx vitest run && npm run lint && npm run build
git add vite.config.ts public/sw.js
git commit -m "feat: data-dev middleware + SW data-branch cache (dp-6)"
```

---

### Task DP-7: UI — dataset dropdown, locks, attribution

**Files:**
- Modify: `src/components/config/SchemaEditor.tsx`
- Modify: `src/components/layout/Sidebar.tsx`
- Modify: `src/components/guide/steps.ts` (one-line Schema-step copy addition)
- Test: Playwright spot-check (manual script or screenshot), full scenario lands in DP-8

**Interfaces:**
- Consumes: `DATASETS` (DP-2), `applyDataset`/`selectCustomDataset` from `useAppState()` (DP-3), `state.dataset`.
- Produces testids: `dataset-select`, `dataset-attribution`, `dataset-loading`, `dataset-error`. Locked-while-active controls: shape inputs, ±Dim, add-variable, variable name inputs, remove-variable buttons, logicalType/min-max/generation controls.

- [ ] **Step 1: SchemaEditor props + dropdown + locks**

Add props:

```ts
  dataset: { id: string; attribution: string } | null;
  datasetOptions: { id: string; label: string }[];
  datasetStatus: { loading: boolean; error: string | null };
  onSelectDataset: (id: string | 'custom') => void;
```

At the top of the returned JSX (before shape inputs):

```tsx
      {/* Dataset picker: real-data presets, Custom (generated) last */}
      <div style={{ display: 'flex', alignItems: 'center', gap: spacing.sm }}>
        <span style={{ fontSize: fontSizes.sm, color: colors.textSecondary, minWidth: 40 }}>Data</span>
        <select
          value={dataset?.id ?? 'custom'}
          disabled={datasetStatus.loading}
          onChange={(e) => onSelectDataset(e.target.value)}
          data-testid="dataset-select"
          style={{ ...inputStyle(fontSizes.xs), cursor: 'pointer', flex: 1, minWidth: 0 }}
        >
          {datasetOptions.map((d) => (
            <option key={d.id} value={d.id}>{d.label}</option>
          ))}
          <option value="custom">Custom (generated)</option>
        </select>
      </div>
      {datasetStatus.loading && (
        <div data-testid="dataset-loading" style={{ fontSize: fontSizes.xs, color: colors.textTertiary }}>
          loading dataset…
        </div>
      )}
      {datasetStatus.error && (
        <div
          data-testid="dataset-error"
          style={{
            background: colors.warningDim, borderLeft: `2px solid ${colors.warning}`,
            borderRadius: radii.sm, padding: spacing.xs, fontSize: fontSizes.xs, color: colors.warning,
          }}
        >
          {datasetStatus.error}
        </div>
      )}
      {dataset && (
        <div data-testid="dataset-attribution" style={{ fontSize: fontSizes.xs, color: colors.textTertiary, fontStyle: 'italic' }}>
          {dataset.attribution} · schema fixed by dataset
        </div>
      )}
```

Locks — `const locked = dataset !== null;` then:
- Both shape-input branches: `disabled={locked}` on the `NumberInput`s (it spreads rest props); hide the `+ Dim`/`- Dim` buttons when `locked`.
- `+ Variable` button: `disabled={locked}` (and dim it: `color: locked ? colors.textTertiary : colors.accent`, `cursor: locked ? 'default' : 'pointer'`).
- Variable name `<input>`: `disabled={locked}`.
- Remove-variable `x` button: render only when `!locked`.
- LogicalType `<select>`, min/max `NumberInput`s, decimal/sigfig inputs, wordSet select, generation `<select>`: `disabled={locked}`.
- typeAssignment is NOT in this component (TypeAssignConfig) — untouched, stays editable.

- [ ] **Step 2: Sidebar wiring**

In `Sidebar.tsx`'s Schema case: pull `applyDataset`, `selectCustomDataset` from `useAppState()`; add local state (at the Sidebar component top level, not inside `renderSection`):

```tsx
  const [datasetStatus, setDatasetStatus] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });

  async function handleSelectDataset(id: string | 'custom') {
    if (id === 'custom') {
      setDatasetStatus({ loading: false, error: null });
      selectCustomDataset();
      return;
    }
    setDatasetStatus({ loading: true, error: null });
    const ok = await applyDataset(id);
    setDatasetStatus(ok
      ? { loading: false, error: null }
      : { loading: false, error: 'dataset failed to load — check your connection and try again' });
  }
```

Pass to SchemaEditor:

```tsx
            dataset={state.dataset}
            datasetOptions={DATASETS.filter((d) => d.dataModel === state.dataModel).map((d) => ({ id: d.id, label: d.label }))}
            datasetStatus={datasetStatus}
            onSelectDataset={handleSelectDataset}
```

(`import { DATASETS } from '../../datasets/registry.ts';`, `import { useState } from 'react';` if absent.)

- [ ] **Step 3: Guide copy**

In `src/components/guide/steps.ts`, find the Schema step's body text and append one sentence, e.g.: "The Data picker loads real public-domain datasets (terrain, sea-surface temperature, weather stations) in place of the generator — dataset presets choose the data, format presets choose the pipeline." Match the file's existing copy style and length.

- [ ] **Step 4: Visual verification (Playwright)**

With `npm run dev` running, write a throwaway script (or reuse scenario-helpers) that: opens the app, screenshots the Schema section, selects `ghcn-daily` from `dataset-select` (tabular default model), waits for pipeline idle, screenshots again (locks + attribution visible), selects custom, screenshots. Inspect the three screenshots. Fix visual/interaction bugs before moving on (CLAUDE.md UI workflow).

- [ ] **Step 5: Gate + commit**

```bash
npx vitest run && npm run lint
git add src/components/ 
git commit -m "feat: dataset picker UI with schema locks + attribution (dp-7)"
```

---

### Task DP-8: Scenario, docs, suite verification

**Files:**
- Create: `tests/ui/scenario-dataset-presets.mjs`
- Modify: `CLAUDE.md` (testids + scenario list entry)
- Modify: `docs/superpowers/specs/2026-07-12-dataset-presets-design.md` (status: implemented note, if the spec has a status line)

**Interfaces:**
- Consumes: everything; `tests/ui/scenario-helpers.mjs` (`launch`, `check`, `waitForPipelineIdle`, `seedStateAndReload` — read the helper file for exact exports before writing).

- [ ] **Step 1: Write `tests/ui/scenario-dataset-presets.mjs`**

Structure (adapt to scenario-helpers' actual API — read two existing scenarios first, e.g. `scenario-linearization-endianness.mjs` and `scenario-real-codecs.mjs`, and follow their shape):

Checks, in order:

1. **Tabular dataset**: fresh load (default tabular) → `dataset-select` present with `ghcn-daily` option + `custom`. Select `ghcn-daily` → wait for pipeline idle → assert:
   - `dataset-attribution` visible, non-empty text
   - `shape-input` disabled; `add-variable` disabled; `variable-name-0` disabled
   - table view renders (values from fixture/real data)
   - read status shows success (`read-status` contains no failure text)
2. **Compression sanity**: pipeline-strip Encoded stage byte count < Typed stage byte count (parse the `pipeline-stage-{index}` nodes' text; delta/RLE/dictionary on fixture data compresses).
3. **Unlock**: select `custom` in `dataset-select` → `shape-input` enabled again, attribution gone, pipeline still computes (generated values).
4. **Persistence**: select `ghcn-daily` again, wait idle, `page.reload()` → `dataset-select` value still `ghcn-daily`, attribution still rendered, pipeline computes (worker refetches).
5. **Array datasets**: switch data model to array (Header control — find its testid/label in `Header.tsx`), select `etopo-dem` → locks + compute OK; select `sst-field` → compute OK (zstd via pyodide: use the runtime-ready wait pattern from `scenario-real-codecs.mjs`).
6. **Failure path**: `page.route` abort on `**/data-dev/datasets/etopo-dem/manifest.json` (main-thread fetch — reliably interceptable), select `etopo-dem` from a custom state → `dataset-error` appears, state unchanged (`dataset-select` still `custom`). Unroute after.

- [ ] **Step 2: Run the scenario**

```bash
npm run dev &
node tests/ui/scenario-dataset-presets.mjs
```

Expected: all PASS, exit 0. Debug and fix (root-cause, not scenario-tweaking) anything that fails.

- [ ] **Step 3: Full verification sweep**

```bash
npx vitest run          # expect ~1080+ tests, 0 failures
npm run lint            # 0 errors
npm run build           # clean
for f in tests/ui/scenario-*.mjs; do node "$f" || echo "FAILED: $f"; done
kill %1
```

Expected: every scenario file exits 0 (23 files now).

- [ ] **Step 4: CLAUDE.md updates**

Add to the scenario list: `node tests/ui/scenario-dataset-presets.mjs`. Add to the testid conventions:

```markdown
- `dataset-select` — the Schema section's dataset preset picker (real-data samples per model + "Custom (generated)" last); `dataset-attribution` — provenance line shown while a dataset is active; `dataset-loading` / `dataset-error` — manifest fetch states. While a dataset is active the schema is locked (shape/add/remove/rename/logicalType disabled); everything downstream (typeAssignment, codecs, chunking, metadata, write) stays editable. Dataset values are fetched by the worker from the orphan `data` branch (dev: vite `data-dev` middleware serving `data-branch-work/` then `tests/fixtures/`).
```

- [ ] **Step 5: Commit**

```bash
git add tests/ui/scenario-dataset-presets.mjs CLAUDE.md docs/
git commit -m "test: dataset presets scenario + docs (dp-8)"
```

---

## Execution notes (for the coordinating session)

- Subagent-driven per user instruction: **sonnet** implementers/reviewers; **opus** for DP-4 (engine/worker heart) and the final whole-branch review. Briefs/reports prefixed `task-dp-N` in `.superpowers/sdd/`; append the ledger per task.
- DP-5 needs outbound network for the real extractions; if unavailable, fixtures still unblock DP-6/7/8 and the real runs become a user follow-up (three commands, documented in scripts/datasets/README.md).
- After the branch is done, remind the user: push the `data` branch (README flow) before the deployed site's dataset picker works; until then prod selections fail with the honest error path.
- Stretch (only if the user asks): a `basically-*` format preset referencing a dataset — the state mechanism supports it (`dataset` validates like any field); would need `gen-presets.ts` to embed an applied schema.

## Self-review (done at write time)

- Spec coverage: datasets ✓ (DP-5), asset pipeline/orphan branch ✓ (DP-5/6), registry+curated split ✓ (DP-2), state+locks+customEntries ✓ (DP-3), worker flow+integrity+failure ✓ (DP-4), UI ✓ (DP-7), SW ✓ (DP-6), testing ✓ (each + DP-8), format-preset composition mechanism ✓ (validation path in DP-3; shipped presets unchanged = non-goal).
- Known judgment points left to implementers (deliberate, gated by assertions): exact ERDDAP dataset ids/crops (DP-5), scenario-helpers exact API (DP-8), pyodide-codec handling in the fixtures roundtrip test (DP-5).
