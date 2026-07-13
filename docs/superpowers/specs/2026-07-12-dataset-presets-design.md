# Dataset Presets (Real Data) — Design

Date: 2026-07-12
Status: implemented (DP-1..DP-8 complete; see tests/ui/scenario-dataset-presets.mjs)

> **SUPERSEDED (2026-07-13, split redefinition):** dataset selection now applies
> **SCHEMA + METADATA ONLY** — shape, variables (typeAssignment defaulted from
> the data's natural storage dtype), empty field pipelines, and *appended*
> provenance metadata (tracked in `state.dataset.seededEntries`, removed on
> deselect). It no longer applies the curated codec/chunking/interleaving/write
> config described below; `CuratedDefaults` is deleted from `registry.ts`
> (entries are now just `{ id, label, dataModel }`). Those curated configs moved
> into the four top-level FORMAT presets (Parquet-adjacent, Avro-esque,
> GeoTIFFesque, Zarrish), each a full AppState snapshot carrying its own
> `dataset` ref. See CLAUDE.md's `dataset-select` bullet for the current
> behavior. The sections below describing curated-apply are historical.
Roadmap: `notes/improvement-ideas.md` §2 "Dataset presets (real data)"

## Overview

Add selectable **dataset presets** — real, public-domain data samples — alongside
the current deterministic generator. A dataset preset fixes the data (values,
schema, shape); everything downstream (type assignment, chunking, linearization,
byte order, codecs, metadata, write config) stays fully editable. Real data makes
the lessons land: delta/zigzag on real terrain, bitround+zstd on a real smooth
field, dictionary/RLE on real categorical/zero-heavy columns.

The UI model: a **Dataset dropdown** in the Schema section listing the samples,
with **Custom (generated)** last. Picking a sample applies its schema and locks
the schema-editing fields; picking Custom unlocks them (current behavior,
unchanged). `dataset` is an ordinary `AppState` field, so format presets can
specify a dataset like any other setting they manage.

## Datasets (v1: three samples, all NOAA, all public domain)

All sources are fetched as **CSV over plain HTTPS** (ERDDAP griddap / NCEI file
access) — no GeoTIFF/NetCDF/Parquet readers, **zero new dependencies**.

| id | model | shape | variables | lesson |
|---|---|---|---|---|
| `etopo-dem` | array | 1024×1024 | elevation (int-valued meters, int16-friendly) | delta/zigzag on real terrain |
| `sst-field` | array | 1024×1024 | sea-surface temperature (float, smooth) | bitround + zstd on a smooth field |
| `ghcn-daily` | tabular | ~150–250K rows | date (sorted), TMAX/TMIN (smooth ints), PRCP (zero-heavy), station (categorical string) | dictionary/RLE on real columns |

Source notes:
- `etopo-dem`: ETOPO global relief via an ERDDAP griddap CSV subset (exact
  server/dataset/crop chosen at extraction; crop picked for visible terrain
  relief). Values rounded to integer meters.
- `sst-field`: MUR or OISST SST via ERDDAP griddap CSV. The crop must be
  ocean-only; the extraction script **asserts the crop contains no NaN** and
  fails extraction otherwise.
- `ghcn-daily`: a few GHCN-Daily station CSVs from NCEI
  (`.../access/<station>.csv`), concatenated so the station column has long
  categorical runs. Missing numeric values in the source rows are dropped
  (rows with all-present values only) — the pipeline's typed stage should not
  have to model missingness in v1.

Each sample's attribution (source name, URL, retrieval date, license note) is
recorded in its manifest and shown in the UI.

## Asset pipeline (ver-por-que approach)

MB-scale binaries never enter the main branch:

- **Extraction scripts** live in `scripts/` (one per dataset + shared helpers),
  runnable via `npx tsx`. Each fetches source CSV, parses, validates
  (shape, NaN-free where required, value ranges), and emits outputs to a
  **gitignored** local dir (`data-branch-work/` or similar).
- Outputs are committed to an **orphan branch `data`** with layout:

  ```
  datasets/<id>/manifest.json   — data description (see below)
  datasets/<id>/<var>.bin       — numeric column/grid: raw little-endian values
  datasets/<id>/<var>.dict.json — string column: array of unique strings
  datasets/<id>/<var>.codes.bin — string column: uint8/uint16 dictionary codes
  ```

  The user pushes the branch (agents never touch the remote). Creating and
  committing to the local orphan branch is scripted
  (`scripts/publish-datasets.sh` or documented commands) but run by hand.
- The app references assets by **branch-name raw URLs**:
  `https://raw.githubusercontent.com/jkeifer/0x00c0dec5/data/datasets/<id>/...`.
  raw.githubusercontent.com serves `Access-Control-Allow-Origin: *`, so worker
  fetches work from GitHub Pages and localhost alike. Data fixes ship by
  pushing the `data` branch; no app change needed.

### manifest.json (on the data branch, script-generated)

Pure **data description** — everything needed to decode the bins and present
the schema. Per dataset: `id`, `shape`, `attribution`, and per variable:
`name`, `kind` (`number` | `string`), `dtype` of the bin (`DtypeKey`, e.g.
`int16`/`float32`), `file` (relative), for strings `dictFile`/`codesFile`/
`codesDtype`, observed `min`/`max`, and a display `logicalType` block
(`integer`/`decimal`/`continuous`/`text` + rounding params) that the app maps
onto `LogicalTypeConfig`.

### Registry (on main, in-bundle)

`src/datasets/registry.ts` — small and app-versioned:

```ts
interface DatasetRegistryEntry {
  id: DatasetId;                    // 'etopo-dem' | 'sst-field' | 'ghcn-daily'
  label: string;
  dataModel: 'array' | 'tabular';
  manifestUrl: string;              // data-branch raw URL
  curated: CuratedDefaults;         // see below
}
```

**Split rationale:** the manifest holds *data facts* (shape, dtypes, min/max,
attribution) and lives with the data; **curated pipeline defaults**
(typeAssignments, chunkShape, codec pipelines, interleaving) reference app
registry keys (codec ids, dtype keys) and must stay version-locked to the app,
so they live in the main-branch registry. A codec rename can never strand
remote config.

`CuratedDefaults` is a partial state fragment applied on dataset selection:
per-variable `storageDtype`/`scale`/`offset`/`keepBits` (keyed by variable
*name*, since ids are minted at apply time), `chunkShape`, `interleaving`
(tabular), `linearization` (array), and codec pipelines. Each dataset's
curated block is hand-authored to demo its lesson (e.g. `etopo-dem`: int16
storage, 256×256 chunks, delta→zigzag→deflate). Curated keys that match no
manifest variable are ignored (pinned by a unit test), so a data-branch schema
revision degrades to defaults rather than breaking apply.

## State

- `AppState.dataset: { id: DatasetId; attribution: string } | null` —
  `null` = generated (Custom); explicit null (not optional/undefined) so JSON
  persistence and the default-merge pass handle it unambiguously. Persisted
  like any other field;
  **values are never persisted**. Attribution is copied out of the manifest at
  apply time so the UI can render it after a reload without refetching the
  manifest on the main thread.
- New reducer action `APPLY_DATASET(payload: { id, manifest })`: sets
  `dataset`, `shape`, `variables` (minting ids, mapping manifest logicalTypes,
  assigning palette colors), and the curated defaults. Like format-preset
  loading, the pre-apply state is snapshotted to the model's custom slot.
  It also **seeds `metadata.customEntries`** from the manifest's attribution
  block (`source`, `source_url`, `retrieved`, `license`), replacing any prior
  entries — real provenance metadata flowing into the written file via the
  existing `descriptive` group. The seeded entries are ordinary custom
  entries: editable, deletable, not locked. `SET_DATASET_CUSTOM` leaves them
  in place (like the rest of the schema starting point).
- `SET_DATASET_CUSTOM`: clears `dataset`, keeps the schema as an editable
  starting point (values regenerate deterministically as today).
- `validateExternalState`: unknown/malformed `dataset.id` → dropped to
  undefined (generated), same graceful-degrade as every other field. A known
  id passes through; the persisted schema in the same state is trusted as-is
  (it was applied from the manifest when selected — see integrity check below).
- Format presets: because `dataset` is a validated state field, a format
  preset JSON may include `dataset: { id }` with the matching applied schema.
  `scripts/gen-presets.ts` validation covers this path. **The three shipped
  `basically-*` presets stay on generated data in v1** — updating any of them
  to reference a dataset is a stretch task, not a requirement.

## Data flow

1. **Selection (main thread).** Picking a dataset in the dropdown fetches
   `manifestUrl` (module-level cache), then dispatches `APPLY_DATASET`. The
   Schema section shows a small loading state until the manifest lands;
   on fetch failure it shows an inline error and the selection reverts (state
   untouched).
2. **Compute (worker).** `ComputeRequest.state.dataset.id` present → the worker
   ensures values are loaded: fetch manifest + bins (module-level cache keyed
   by dataset id, exactly the "fetched+cached in worker memory by preset id"
   slot the perf plan reserved), decode bins → per-variable `ValueArray`
   (numeric: typed-array view widened to `Float64Array`/number values;
   strings: `codes.bin` indices into the dict). Compute awaits this on first
   use; afterwards it's a cache hit.
3. **Injection.** `computeValuesStage` gains an optional
   `presetValues?: Map<string, ValueArray>` parameter used in place of
   `generateValues` when present. This is also the unit-test seam — engine
   tests inject values directly, no network.
4. **Integrity check.** Before injection the worker verifies each bin's byte
   length equals `shape product × dtype size` (and codes length matches, dict
   indices in range). Mismatch (e.g. data branch revised while a stale schema
   persists) → compute fails through the existing `ResultErr` path with a
   message naming the dataset and suggesting re-selecting it.
5. **Failure.** Any asset fetch failure → `ResultErr` with a clear message
   (offline dev, branch missing). Generated mode is never affected.

Boot with a persisted dataset id follows path 2 (worker fetch) — the schema is
already in state, so no main-thread manifest fetch is needed to render.

## UI

- **Dataset dropdown** at the top of the Schema section
  (`data-testid="dataset-select"`): the registry's entries for the active data
  model, then **Custom (generated)** last. Reflects `state.dataset` (Custom
  when unset).
- **Locks while a dataset is active:** shape inputs, add/remove variable,
  variable name inputs, and logicalType/generation controls are disabled with
  a "fixed by dataset" hint. `typeAssignment` (storage dtype, scale/offset,
  keepBits), codecs, chunking, linearization, byte order, metadata, and write
  config remain fully editable.
- **Attribution** line rendered in the Schema section while active
  (`data-testid="dataset-attribution"`), from the manifest.
- Loading/error states per Data flow §1 (`dataset-loading`, `dataset-error`
  testids).
- Guide copy: a short addition explaining dataset vs format presets (data vs
  pipeline config).

## Service worker

Add the data-branch asset URLs (manifests + bins for all registry entries) to
the existing SW cache list so the talk demo survives offline after one warm
load. Cross-origin cached responses are fine (CORS-enabled fetches).

## Testing

Unit (tests/unit/):
- Bin decoding: bytes → ValueArray for each dtype used; dict/codes decoding;
  length/range integrity failures produce the expected errors.
- `computeValuesStage` injection: preset values flow through Values→Typed
  stages identically to generated values (stats, layout, tracing unaffected).
- State: `APPLY_DATASET` applies schema + curated defaults and snapshots the
  custom slot; `SET_DATASET_CUSTOM` clears and unlocks; `validateExternalState`
  drops unknown ids; a format-preset-shaped state with `dataset` validates.
- Manifest mapping: manifest logicalType blocks → `LogicalTypeConfig`.

Extraction scripts:
- Each script self-validates its output (shape, NaN-free, ranges) and fails
  loudly. Committed outputs are the fixture of record; scripts are not run in
  CI.
- A small checked-in fixture manifest + bins (a few hundred bytes) under
  `tests/unit/fixtures/` exercises the decode path without network.

Scenario (tests/ui/, via scenario-helpers):
- `scenario-dataset-presets.mjs`: serve fixture assets locally (route
  interception mapping the raw URLs to fixture files — no network in the
  harness), pick each dataset → schema locks apply, attribution renders,
  pipeline computes, hex/table views show real values, codec ratios are sane
  (e.g. delta+deflate on DEM < raw size), switch to Custom → unlocks and
  regenerates, reload with persisted dataset id → still works.

## Non-goals (v1)

- Editing preset values (values are fixed; Custom is the editable path).
- Per-variable data sources (mixing real and generated variables).
- SHA-pinned asset URLs, data versioning/migration beyond the byte-length
  integrity check.
- Updating the shipped `basically-*` presets to reference datasets (stretch).
- Modeling missing data (NaN rows dropped at extraction).

## Rejected alternatives

- **Values as JSON in the bundle** (like format presets): MB-scale JSON bloats
  the bundle and memory; rejected in brainstorming.
- **Assets in `public/` on main**: puts MBs into main-branch history forever;
  replaced by the orphan `data` branch (ver-por-que pattern).
- **Curated defaults in the remote manifest**: app-version-coupled keys on a
  mutable data branch invites drift; curated config stays on main.
- **Per-variable data source**: no lesson needs it; lock semantics get murky.
