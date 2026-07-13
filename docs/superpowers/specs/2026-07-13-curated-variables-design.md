# Curated Variables Design

**Status:** Approved (replaces the dataset-composition "middle rung" landed in commit 9eb93d0).

## Motivation

The current model makes a *dataset* a schema-wide mode: applying one replaces the
variable set, owns the shape, locks structural edits, seeds metadata entries it must
later un-seed, and binds values to variables by id prefix. That coupling produced the
lock machinery, the seeded-entry bookkeeping, and the re-apply-wipes-composed-variables
sharp edge flagged in the RI final review.

The better model: **the curated unit is the variable, not the dataset.** A variable's
data source is an explicit per-variable field. Datasets become nothing but a catalog of
curated variables. Presets — which are already full AppState snapshots — do the
composing.

## Data model

- `Variable.source?: { datasetId: DatasetId; variableName: string }` — absent means
  custom/generated (the default for new variables).
- Binding is by this explicit ref only. Variable `name` is just a label; renaming can
  never hijack or lose values. Variable ids carry no meaning.
- **Deleted outright:** `state.dataset`, `seededEntries`, `DATASET_LOCKED_ACTIONS`,
  `APPLY_DATASET` / `SET_DATASET_CUSTOM` actions, `isDatasetVariable`, the Schema
  section's dataset picker (`dataset-select`, `dataset-attribution`, `dataset-loading`,
  `dataset-error`), and `buildDatasetApplication`.
- No locks remain except per-field: a curated row's `logicalType` is manifest-owned
  (locked); everything else — name, color, typeAssignment, codecs, add/remove, and the
  schema **shape** — is always editable.

## Values: tile/crop fill

The schema shape is a free knob; curated data adapts to it by modulo indexing:

- `value(coords) = source[coords % naturalShape]`, applied per dimension, aligned from
  the **trailing** dimensions. Extra leading schema dimensions broadcast (repeat the
  source). Examples:
  - schema `[200,200]`, source `[1024,1024]` → top-left crop window.
  - schema `[2048,2048]`, source `[1024,1024]` → 2×2 tile.
  - schema `[10,200,200]`, source `[1024,1024]` → same 200×200 crop repeated on the
    leading axis.
  - tabular schema `[500000]`, source 144,769 rows → rows repeat modulo 144,769.
  - schema with **fewer** dims than the source (e.g. schema `[50]`, source
    `[1024,1024]`) → index the source's trailing dims, fixing the source's unmatched
    leading dims at 0 (here: the first 50 values of row 0).
- Cropping is the degenerate case of tiling: one code path, no error states, any shape
  works with any curated variable.
- Implemented as a pure engine function operating on the fetched `ValueArray` (numeric
  `Float64Array` or text `string[]`) + natural shape; unit-tested in `tests/unit/`.

## Fetch path

- The worker fetches curated data **per variable ref**, derived from
  `state.variables[].source` (the manifests already store one file — or dict+codes —
  per variable). Cache key `${datasetId}/${variableName}`; cached entries carry
  `{ values, naturalShape }`.
- Fetch failure for a referenced variable stays fail-loud through the existing worker
  error surface (pipeline error); no new error UI.
- The dev-server data middleware (`data-branch-work/` then `tests/fixtures/`) is
  unchanged.

## Schema UI

- Each variable row gets a **source dropdown**: `Custom (generated)` first/default,
  then curated variables grouped by dataset (e.g. "GHCN Daily › tmax",
  "ETOPO › elevation", "SST › sst"), filtered to the active data model.
- Selecting a curated source sets the row's `logicalType` (and defaults its
  `typeAssignment` from the data's natural storage dtype, as dataset-apply does today)
  and locks `logicalType` while curated. Switching back to Custom unlocks it, keeps the
  curated `logicalType` as a starting point, and values become generated again.
- A small per-row attribution hint (from the manifest) shows while a curated source is
  selected — purely informational; it writes nothing to metadata.

## Provenance & presets

- **Provenance is preset-carried only**: presets bake source/source_url/retrieved/
  license (and, later, geospatial metadata) as ordinary `metadata.customEntries` in
  their snapshots. No derivation logic, no seeding, no removal bookkeeping. Accepted
  consequence: ad-hoc curated variables added outside a preset produce files with no
  attribution entries.
- Format presets compose curated variables by baking `source` refs into their variable
  entries. `scripts/gen-presets.ts` is reworked accordingly and all four presets
  regenerated: Parquet-adjacent and Avro-esque reference the five GHCN columns;
  GeoTIFFesque references ETOPO elevation plus two custom smooth bands; Zarrish
  references SST. Cross-dataset composition (e.g. sst + elevation, both [1024,1024])
  becomes possible for free, though no shipped preset requires it.

## Migration

One `migrateState` step in the existing persistence machinery:

- For persisted states carrying `dataset: { id, ... }`: any variable whose id starts
  with `{dataset.id}-` gains `source: { datasetId: dataset.id, variableName: name }`.
- `state.dataset` is dropped. Previously seeded metadata entries need no handling —
  they already physically live in `customEntries` and simply remain as the user's
  ordinary entries.
- Shipped presets are regenerated, so only user localStorage states need the migration.

## Testing

- Engine: tile/crop fill — crop, exact-fit, tile, broadcast leading dims, tabular
  modulo, text variables; determinism with generated variables untouched.
- Reducer/state: source field set/clear semantics, logicalType lock scoping, migration
  fixture (old dataset-shaped state → source refs).
- UI scenario: `tests/ui/scenario-dataset-presets.mjs` reworked around the per-row
  source dropdown (pick a curated source ad-hoc, values are real; shape edits re-crop /
  tile without error; presets still round-trip in-browser).
- Docs: CLAUDE.md dataset paragraphs rewritten; guide steps re-checked where they
  mention the Data picker or dataset locking.

## Out of scope

- Geospatial metadata (future preset-level addition; this design only keeps the door
  open via preset-carried customEntries).
- Per-variable generator parameter editing, new datasets, zoom/pan, and anything else
  not named above.
