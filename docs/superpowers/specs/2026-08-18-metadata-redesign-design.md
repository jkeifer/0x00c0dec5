# Metadata Redesign — Design Spec

Date: 2026-08-18. Status: approved in conversation; not yet implemented.

## Goal

The app's core narrative is "file formats don't work without metadata." Today the
metadata subsystem undercuts that story: everything is included by default (nothing to
discover), the UI spoils each toggle's consequence, the chunk index is demanded even
when unnecessary, "binary" serialization is readable ASCII, there is no key/value view
of what's actually in the metadata, custom entries can't override auto-collected ones,
and spatial data sources carry no geospatial metadata. This redesign makes metadata the
discovery arc of the tool.

Two verified reader bugs are folded in because the same code paths are being reworked:

- **Per-chunk partitioning doesn't need a chunk index but the reader demands one.**
  `makePerChunkFileReader` (`src/engine/readReassemble.ts`) resolves chunks by filename
  from coords and never reads `entry.offset`/`entry.size`, yet `resolveChunkIndex`
  throws `NoChunkIndexError` for any entropy codec regardless of partitioning.
- **`chunk_order` is written but never read.** `parseStructure` doesn't parse it; the
  synthetic index always assumes row-major. Column-major chunk order + no chunk index +
  size-preserving codecs reads *successfully with silently scrambled chunk placement*.

## 1. State shape

`src/types/state.ts`:

- **Delete `write.includeMetadata`.** Add `metadata.enabled: boolean`, default `false`.
  This is the master switch for metadata *assembly*: off → `collectMetadata` is never
  consulted and the Metadata stage's bytes are a zero-length `Uint8Array` (NOT a
  serialized-empty `{}` — truly nothing, overriding every include group and the
  `metadata_format` envelope key).
- **`write.metadataPlacement` gains `'omit'`**: `'header' | 'footer' | 'sidecar' | 'omit'`.
  Omit = metadata is assembled (stage pane shows real bytes; Entries view works) but
  Write places it in no file, sidecar included. Distinct lesson from `enabled: false`:
  "the writer had the self-description in hand and threw it away." Both produce a
  `no-metadata` read failure; the reader cannot tell why metadata is absent — that
  indistinguishability is itself honest.
- **`MetadataIncludeConfig` defaults all `false`** (was all `true`). Fresh-session
  ladder: enable metadata → read fails at read-schema (only the envelope key is
  written) → each group toggle unlocks the next named read step. No state migration —
  existing saves keep stored values.
- **`descriptive` now gates only `variable_statistics`.** Custom entries are written
  whenever metadata is enabled — clicking "+ Entry" is the intent. (Under default-off
  groups, gating custom entries would make "+ Entry" silently write nothing, and
  structural overrides would bizarrely require the descriptive toggle.)

### Persistence / share / presets

- `migrateState` (`src/state/persistence.ts`): a raw state carrying
  `write.includeMetadata` (the removed field) → return `null` (drop to defaults, no
  migration — standing policy). Share links go through the same pipeline
  (`src/state/share.ts` → `validateExternalState`), so old links drop too. The
  validator must accept the new fields (`metadata.enabled`, placement `'omit'`).
- The four presets (`src/presets/*.json`) update: remove `write.includeMetadata`, add
  `"enabled": true` under `metadata`, keep include groups all-true. (Spatial entries
  added in §7.)

## 2. Metadata assembly (`src/engine/metadata.ts`)

- **Delete `chunk_grid`.** Written today, never read (`parseStructure` recomputes the
  grid from shape × chunk_shape). Remove from `collectMetadata`, `METADATA_KEY_GROUPS`,
  and tests. Every entry the file carries must be one the reader (or a human) actually
  uses.
- **Override-wins replaces `user_` renaming.** Delete `dedupeCustomKey` and DC-5
  machinery. In `collectMetadata`: a custom entry whose key equals an existing auto
  entry's key **replaces that entry's value in place** (position preserved); otherwise
  it appends. Duplicate custom keys: last wins. Users can now lie to the reader (wrong
  `shape`, fake `codec_pipelines`) — the sabotage-lesson family the include toggles
  already belong to.
- `metadata_format` envelope key: still always written *when enabled*.
- Custom entries no longer inside the `if (include.descriptive)` block (§1).
- `collectMetadata` is never called when `metadata.enabled` is false; the worker/write
  path short-circuits to zero bytes. (Callers that pass config-derived state — the
  sidebar preview — check `enabled` themselves and show 0 bytes.)

## 3. Truly-binary serialization

Replace `serializeMetadataBinary`/`deserializeMetadataBinary` with a TIFF-flavored tag
format. No back-compat with the old length-prefixed format (drop-migrations policy;
old files were session-scoped anyway). All framing is **fixed little-endian** — a spec
constant like TIFF's `II`; only chunk data follows the `byte_order` setting.

```
[u16 entry count]
per entry: [u16 tag] [u8 type] [u32 payloadLength] [payload]
```

**Tags** (the "you need the spec" lesson — key names vanish from the bytes):

| tag | key | tag | key |
|-----|-----|-----|-----|
| 0 | (custom key — see below) | 8 | codec_pipelines |
| 1 | schema | 9 | chunk_index |
| 2 | shape | 10 | type_assignments |
| 3 | chunk_shape | 11 | logical_types |
| 4 | chunk_order | 12 | variable_statistics |
| 5 | partitioning | 13 | metadata_format |
| 6 | interleaving | 14 | byte_order |
| 7 | linearization | | |

Tag 0 payload: `[u16 keyLen][key utf8][value bytes per type]`. Registered-tag payload
is the value bytes directly.

**Types** (`u8`):

- `0` — UTF-8 string. Used for genuinely nested config (`codec_pipelines`,
  `type_assignments`, `logical_types`, `variable_statistics`) which stays
  JSON-in-a-string payload, for custom values, and as the universal fallback.
- `1` — u32 array (`shape`, `chunk_shape`): `[u32 × n]`, n from payloadLength/4.
- `2` — enum u8 code (`chunk_order`, `partitioning`, `interleaving`, `linearization`,
  `byte_order`, `metadata_format`). Per-key enum value tables live in the spec table.
- `3` — packed chunk index: `[u8 ndim][u32 entryCount]` then per entry
  `[u32 × ndim coords][u32 offset][u32 size][u8 varNameLen][varName utf8]`
  (varNameLen 0 = no variableName). Fixed-width offsets mean `convergeHeaderMetadata`
  converges immediately for binary; its JSON-only whitespace-padding path stays
  JSON-only.
- `4` — schema table: `[u16 varCount]` then per var `[u8 nameLen][name utf8][u8 dtypeCode]`.
  Stable dtype-code table over `DtypeKey` lives beside the tag table.

**Architecture**: `MetadataEntry { key, value: string }` stays the interchange type
everywhere. A per-key spec table (new `src/engine/metadataBinary.ts`) maps
key ↔ tag and value-string ↔ payload in both directions. Encoders parse the entry's
value string into the key's native type; **if it doesn't fit (the user overrode
`interleaving` with `"banana"`), fall back to type 0 string** — lies stay writable, and
the reader chokes on them honestly at `parseStructure` time, not in the writer.
**The type byte is authoritative on decode.** Decode re-stringifies native types with
`JSON.stringify` so binary round-trips produce the exact strings `collectMetadata`
emitted (chunk-index object key order: `coords, offset, size, variableName?`).
`parseStructure`, the JSON path, and all other consumers are untouched.

`deserializeMetadataBinary` additionally reports total bytes consumed (records are
self-describing), replacing `scanBinaryForward`'s re-serialize trick for
`headerByteLength`.

**Locator scans** (`src/engine/readLocate.ts`): `scanBinaryForward` walks the new
record framing (plausible = u16 count in 1..999 and records walk cleanly);
`looksLikeBinaryMetadataHeader` and `scanBinaryBackward`'s plausibility window update
to the u16-count framing. The footer-locator=`'none'` lesson (binary has no
self-describing start) survives unchanged.

## 4. Reader (`src/engine/read.ts`, `readReassemble.ts`)

- `parseStructure` additionally parses `partitioning` (`'single' | 'per-chunk'`,
  default `'single'` when absent) and `chunk_order` (`'row-major' | 'column-major'`,
  default `'row-major'`) into `ParsedStructure`. Both are layout-group keys, so
  they're guaranteed present-or-defaulted by the time reconstruct runs.
- **Chunk-reader selection keys off parsed `partitioning`**, not
  `dataFiles.length === 1` (fixes the 1-chunk-per-chunk-file edge where the single-file
  reader mis-slices). Fallback when the key is absent: current file-count heuristic.
- `resolveChunkIndex`:
  - **Per-chunk partitioning**: synthesize coords-only entries (offset/size unused by
    the per-chunk reader; write 0s) for every chunk (× every variable in column mode).
    **No size-changing-codec check** — each file is its chunk.
  - **Single file**: current logic, but enumerate coords in the parsed
    `chunk_order`'s order when synthesizing offsets (fixes the silent-corruption bug).
    `NoChunkIndexError` still thrown for size-changing codecs.

## 5. Sidebar UI

**`MetadataEditor.tsx`** — new order, top to bottom:

1. **"Enable metadata"** toggle (testid `metadata-enabled-toggle`). Everything below
   dims when off (replaces the old cross-section "enable Include Metadata in Write"
   notice, which is deleted).
2. Include-group toggles — **`hint` strings deleted entirely** (labels only; no
   spoilers). The Read section's step-progress line is the feedback loop.
3. Auto-collected preview (existing collapsible list).
4. **"+ Entry" button directly above the custom rows**, custom rows beneath it.
   Collision warning becomes an informational note: "overrides auto-collected `{key}`"
   (testid `metadata-key-override-note-{i}`; the old
   `metadata-key-collision-warning-{i}` and warning border go away — empty-key warning
   border stays).
5. Serialization radio (JSON / Binary).
6. Serialized size (shows 0 bytes when disabled).

**`WriteConfig.tsx`**: Include Metadata toggle removed. Placement select gains
`Omit` option; footer-locator control shown only for footer placement (unchanged);
per-chunk partitioning keeps its existing placement forcing except `omit` remains
selectable.

## 6. Metadata stage "Entries" view

New view mode for the Metadata stage in `StagePane.tsx`, **listed first** (so it's the
default via the existing first-mode fallback): `[Entries, Hex, Flat]`.

- Renders a key/value table parsed **from the stage's actual serialized bytes** — in
  binary mode each row also shows its numeric tag and type code (the spec-lookup step
  made visible). Long values pretty-printed/scrollable within the row.
- Per CLAUDE.md pitfall 8 (no engine calls from components): the worker includes the
  parsed entries in the metadata stage payload
  (`{ key, value, tag?, type? }[]`); the component only renders.
- Disabled metadata → empty state ("metadata is disabled — nothing is assembled").
- Testids: `metadata-entries-view`, `metadata-entry-{key}`.

## 7. Geospatial + attribution seeding on source pick

- **Manifest** (`src/datasets/types.ts`): optional
  `spatial?: { crs: string; bbox: [west, south, east, north]; transform?: number[] }`
  on `DatasetManifest`. Added to the real (`data-branch-work/`) and fixture manifests
  for the two gridded datasets. Values derive from the extraction scripts (both are
  EPSG:4326 north-up):
  - `etopo-dem`: LAT0 20.0, LON0 75.0, step 1/60°, 1024² → bbox ≈ [75.0, 20.0, 92.05, 37.05];
    transform (GDAL order) `[75.0, 1/60, 0, 37.05, 0, -1/60]`. Exact numbers computed
    from the script constants at implementation time.
  - `sst-field`: LAT0 −5.0, LON0 −150.0, step 0.01°, 1024² → bbox ≈ [−150.0, −5.0, −139.77, 5.23];
    transform `[−150.0, 0.01, 0, 5.23, 0, −0.01]`.
  - `ghcn-daily`: no spatial block (tabular stations).
- **Registry** (`src/datasets/registry.ts`): per-dataset static
  `seedEntries: { key: string; value: string }[]` — attribution
  (`source`, `source_url`, `retrieved`, `license`) + spatial (`crs`, `bbox`,
  `transform`) for the grids + units (`date_units`, `temperature_units`,
  `precipitation_units`) for ghcn-daily. Mirrored by hand from the manifests, pinned by
  the existing catalog test (`tests/unit/datasets/catalog.test.ts`) for the
  manifest-derived parts.
- **Reducer** (`UPDATE_VARIABLE` binding a source): append each of the dataset's
  seed entries whose key is not already present in `customEntries`. Idempotent;
  first-dataset-wins on cross-dataset key conflicts; no unseeding — they're plain
  entries the user edits or deletes. Seed keys match the preset-carried keys exactly,
  so loading a preset then re-picking a source adds nothing.
- **Presets**: keep entries baked in (snapshots); geotiffesque + zarrish gain the
  spatial entries.
- The `variable-source-attribution-{index}` hint's documented "writes nothing to
  metadata itself" behavior inverts — update CLAUDE.md/docs accordingly.

## 8. Docs, guide, CLAUDE.md

- **Guide metadata step** (`src/components/guide/steps.ts`): binary option rewritten
  for the tag format (numeric tags, typed payloads, packed index — "opaque without the
  spec"); chunk-index option gains the per-chunk-files exception ("each file *is* its
  chunk") and single-file qualifier; new try-its: the enable-metadata ladder, and
  overriding `shape` with a lie; body mentions that picking a curated spatial source
  seeds CRS/bbox as ordinary custom entries. Check the write-step guide entry for
  references to the removed Write toggle.
- **`docs/design.md`**: metadata assembly + write sections updated — enabled toggle,
  placement omit, default-off groups, override-wins (DC-5 removal), chunk_grid
  removal, binary format spec, chunk_order/partitioning now parsed by the reader.
- **CLAUDE.md testid list**: add `metadata-enabled-toggle`, `metadata-entries-view`,
  `metadata-entry-{key}`, `metadata-key-override-note-{i}`; remove
  `include-metadata-toggle`, `metadata-key-collision-warning-{i}`; update the
  include-toggle bullet (no hints, new defaults, descriptive gates stats only), the
  chunk-index bullet (per-chunk exception), and the `variable-source-{index}` seeding
  note.

## 9. Tests

Unit (in `tests/unit/`):

- metadata: override-wins (replace-in-place, position, last-custom-wins), chunk_grid
  gone, custom entries ungated from descriptive, descriptive gates stats only,
  envelope behavior.
- metadataBinary: roundtrip per type code; custom keys (tag 0); lie-fallback (enum key
  with non-enum value → type 0); exact string-equality roundtrip against
  `collectMetadata` output; consumed-length reporting; empty entries.
- read: `parseStructure` partitioning/chunk_order defaults; `resolveChunkIndex`
  per-chunk with entropy codec (succeeds), column-major synthesis; reader selection by
  partitioning (incl. 1-chunk per-chunk case); locator scans on the new framing.
- state: seeding reducer (idempotence, no-clobber); persistence/share drop of
  old-shape states; preset validity.
- write: placement omit (no metadata bytes in any file, no sidecar), enabled=false
  (zero-length stage bytes).

Scenarios (`tests/ui/scenario-*.mjs`): `scenario-placement-matrix` gains the omit row;
`scenario-read-process` re-grounded on new defaults (the ladder); `scenario-curated-variables`
asserts seeded entries; sweep all scenarios for `include-metadata-toggle` usage and
include-group-default assumptions; new coverage for the Entries view and
`metadata-enabled-toggle`.

## Implementation phasing

1. State shape, defaults, persistence/share drop, presets; assembly changes
   (enabled, override-wins, chunk_grid, descriptive ungating) + unit tests.
2. Reader: partitioning/chunk_order parsing, per-chunk synthetic index, reader
   selection + unit tests.
3. Binary format + locator scans + unit tests.
4. UI: MetadataEditor reorder/enable, WriteConfig omit, Entries view + worker payload
   + Playwright checks.
5. Seeding: manifests (real + fixtures), registry seedEntries, reducer, presets,
   catalog test.
6. Guide, design.md, CLAUDE.md, scenario sweep.

Phases 1–2 are independent of 3; 4 depends on 1 (and lightly on 3 for tag/type
display); 5 is independent of 2–4; 6 last.
