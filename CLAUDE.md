# CLAUDE.md — Project Instructions for Claude Code

## Project Overview

This is **0x00C0DEC5**, an interactive web tool for learning how data file formats are constructed. See `docs/design.md` for the full specification and `docs/extension-read-step.md` for the read/round-trip extension.

Tech stack: React + TypeScript + Vite.

## Development Workflow

### Starting the dev server

```bash
npm run dev
```

Vite runs on `http://localhost:5173` by default.

### Running tests

```bash
npx vitest run          # single run
npx vitest              # watch mode
```

### Build order

Follow the Implementation Order in `docs/design.md`. The cardinal rule: **the engine layer (`src/engine/`) must be tested and correct before building UI components.** The prototyping phase of this project failed repeatedly because UI was built on broken data logic. Do not repeat this mistake.

When implementing a new engine module:
1. Write the module
2. Write tests for the module
3. Run the tests and fix failures
4. Only then move on

When implementing a new UI component:
1. Build the component
2. Test it visually using Playwright (see below)
3. Fix visual/interaction bugs before moving on

## Testing Strategy

### Engine tests (vitest)

All files in `src/engine/` are pure functions operating on typed arrays and plain objects. They should have thorough unit tests covering:

- **Dtype operations**: write/read roundtrips for every dtype, edge cases (min/max values, NaN for floats, zero)
- **Codec roundtrips**: for each codec, `decode(encode(input, dtype, params), dtype, params)` should produce the expected output. Lossless codecs should roundtrip exactly. Lossy codecs (bitround, scale/offset across float↔int) should be tested for expected error bounds.
- **Chunking**: verify chunk counts, chunk boundaries, element assignment for both data models and multiple shapes
- **Linearization**: verify byte order changes between row and column interleaving
- **Tracing**: verify traceIds are preserved through non-size-changing transforms and degrade to chunk-level after entropy codecs
- **Metadata serialization**: JSON and binary roundtrips
- **Write step**: verify file assembly (magic number position, metadata placement, chunk ordering)

### UI testing (Playwright)

For debugging UI bugs and verifying interactive behavior, use Playwright with a headless Chromium browser.

#### Setup

```bash
npx playwright install chromium
```

#### Writing UI test scripts

Create test scripts in `tests/ui/` that:

1. Start or connect to the Vite dev server
2. Navigate to the app
3. Interact with the UI (click, hover, type, select)
4. Take screenshots to verify visual state
5. Assert on DOM content where possible

Example pattern:

```typescript
import { chromium } from 'playwright';

async function testHoverLinking() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('http://localhost:5173');

  // Wait for the app to render
  await page.waitForSelector('[data-testid="table-view"]');

  // Hover over a table cell
  const cell = page.locator('[data-testid="table-cell-temperature-5"]');
  await cell.hover();

  // Screenshot to verify hex view highlighting
  await page.screenshot({ path: 'tests/ui/screenshots/hover-linking.png', fullPage: true });

  // Check that the hover bar shows the expected value
  const hoverBar = page.locator('[data-testid="hover-bar"]');
  const text = await hoverBar.textContent();
  console.log('Hover bar:', text);

  // Verify hex view has highlighted bytes
  const highlightedBytes = page.locator('[data-testid="hex-byte"].highlighted');
  const count = await highlightedBytes.count();
  console.log(`Highlighted bytes: ${count}`);

  await browser.close();
}

testHoverLinking().catch(console.error);
```

#### When to use Playwright

- **After building any viewer component** (HexView, TableView, GridView, FlatView): verify rendering, virtual scrolling, and hover behavior
- **After wiring up cross-pane interactions**: verify hover in one pane highlights in the other
- **After building the pipeline strip**: verify stage nodes render with correct stats
- **After implementing resizable panels**: verify drag handles work and don't break layout
- **When a bug is reported or suspected**: write a Playwright script that reproduces the scenario, screenshot the result, inspect the DOM

#### Regression scenarios

`tests/ui/scenario-*.mjs` are the standing regression harness (see
`docs/remediation-plan.md` Phase 1 task 1.5). Each is a standalone, dependency-free
script (beyond `playwright`, already installed) run against a dev server you start
yourself:

```bash
npm run dev &                                   # serves at http://localhost:5173/0x00c0dec5/
node tests/ui/scenario-crash-inputs.mjs
node tests/ui/scenario-placement-matrix.mjs
node tests/ui/scenario-hover-linking.mjs
node tests/ui/scenario-pane-defaults.mjs
node tests/ui/scenario-worker-pipeline.mjs
node tests/ui/scenario-large-array.mjs
node tests/ui/scenario-read-process.mjs
node tests/ui/scenario-perf1-large-boot.mjs
node tests/ui/scenario-real-codecs.mjs
node tests/ui/scenario-linearization-endianness.mjs
node tests/ui/scenario-curated-variables.mjs
kill %1                                          # stop the dev server when done
```

Shared setup (server URL, fresh-context launch, console/pageerror capture, and the
results harness) lives in `tests/ui/scenario-helpers.mjs` — new scenarios should
build on it rather than re-implementing page setup.

Each check prints `PASS`, `FAIL`, or `KNOWN-FAIL`:

- **PASS** — behaves as expected.
- **FAIL** — behaves unexpectedly; a scenario run with any `FAIL` exits nonzero.
- **KNOWN-FAIL** — the check intentionally documents a defect already tracked in
  `docs/remediation-plan.md` Part 1 (e.g. `RP-1`, `UI-2`, `SW-2`) that a later
  remediation phase fixes. These are asserted as *currently failing*, printed
  loudly with the finding ID and the phase that's expected to fix them, and do
  **not** affect the exit code — a scenario file with only `PASS`/`KNOWN-FAIL`
  results exits 0. If a `KNOWN-FAIL` check ever starts passing (the underlying fix
  landed), the harness reports it as `UNEXPECTED` and fails the run — that's the
  signal to flip the scenario's expectation to a normal `check` and close the
  finding.

Old exploratory scripts (`smoke1-8.mjs`, `verify-phase0.mjs`, `helper.mjs`) remain
in `tests/ui/` for reference; prefer the `scenario-*.mjs` files and
`scenario-helpers.mjs` for anything new.

#### Data-testid conventions

`data-testid` attributes exist throughout `src/` today (verified by grep — this list is no longer aspirational). Key ones:

- `table-view`, `hex-view`, `write-hex-view`, `grid-view`, `flat-view` — viewer containers (`hex-view`/`write-hex-view` are the same `HexView` component; the testid reflects whether it's rendering with multi-file section headers)
- `table-cell-{variable}-{index}` — individual table cells
- `hex-byte-{offset}` — individual hex bytes
- `hover-bar` — the cross-stage hover info bar; `hover-bar-positional` — the italic note it adds when the hovered trace is a positional slot rather than a real element (post Byte Shuffle — see Common Pitfall 1's `traceMode` table). The existing "(chunk-level, value detail lost)" note is its `chunk-level` counterpart and has no testid.
- `pipeline-stage-{index}` — pipeline strip nodes
- `pipeline-stage-encoded-warning` — the Encoded-stage pipeline-strip warning icon (codec applicability/size-increase issues)
- `pane-left`, `pane-right` — comparison pane containers (rendered as `pane-{paneId}`)
- `pane-dropdown-left`, `pane-dropdown-right` — stage selector dropdowns (rendered as `pane-dropdown-{paneId}`)
- `view-mode-{mode}` — view mode radio buttons
- `sidebar-section-{name}` — sidebar config sections
- `sidebar-collapse-toggle` — collapses/expands the Sidebar panel (`react-resizable-panels` v4 `collapsible`/`collapsedSize`); same testid on both the expanded chrome's collapse button and the collapsed rail's expand button (GuidePanel.tsx's rail precedent — a ~36px vertical strip with just the expand chevron)
- `pane-collapse-left`, `pane-collapse-right` — collapse/expand toggle for each comparison pane (StagePane's controls bar when expanded, the collapsed rail's expand button when collapsed — same testid both times). The two panes can never both be collapsed: collapsing one while the other is already collapsed expands the other first. Dragging a collapsed pane's separator outward expands it (library default `collapsible` behavior, unmodified).
- `codec-step-{variable}-{index}` — individual codec pipeline steps
- `codec-warning-{variable}-{index}` — codec applicability warning icons
- `codec-enabled-{variable}-{index}` — per-step enable/disable toggle (F31). A disabled step (`CodecStep.enabled === false`; **absent = enabled**, no migration) is kept in state with params intact but filtered out at every pipeline consumption boundary via `activeSteps` (`src/engine/codecs.ts`) — it doesn't encode, doesn't reach the written metadata (so the read round-trip stays honest with a step toggled off), and is a pass-through in the editor's dtype flow (a disabled step's output dtype must not affect the next step's input — CLAUDE.md pitfall 3). Rendered dimmed when off.
- `runtime-banner` — the Pyodide load-progress strip rendered under the Header; narrates loading (`runtime-banner-step-{id}` per step, ids from `RUNTIME_STEP_ORDER` in `src/engine/pyodideRuntime.ts`, prefix text "Loading compression runtime:") and, on failure, becomes a dismissible error (`runtime-banner-dismiss`) with text prefixed `Compression codecs unavailable:`. Unmounts entirely (not just hidden) once the runtime is ready or the error is dismissed.
- `linearization-select` — the Chunk section's element-traversal-order picker (C order / Fortran order / Morton), rendered only for the array model with `shape.length > 1`
- `byte-order-toggle` — the Chunk section's little/big-endian select, visible for both data models at every ndim (unlike `linearization-select`, not gated on array/multi-dim)
- `footer-locator-toggle` — D1 footer locator radio (trailer/none), shown only when metadata placement is footer
- `metadata-enabled-toggle` — the Metadata section's master switch (`metadata.enabled`, default **false**), sitting above the six include-group toggles and dimming everything below it when off. This is the assembly-level switch: off means `collectMetadata` is never consulted and the Metadata stage's bytes are a true zero-length `Uint8Array`, not a serialized-empty object — distinct from `write.metadataPlacement === 'omit'` (below), which assembles real bytes and then writes them nowhere. Replaces the old cross-section "enable Include Metadata in Write" notice, which is gone.
- `include-schema-toggle`, `include-layout-toggle`, `include-codecs-toggle`, `include-chunk-index-toggle`, `include-descriptive-toggle`, `include-endianness-toggle` — the Metadata section's six granular include-group toggles (`MetadataIncludeConfig`), all **default off** (was all-true) so there's a discovery ladder rather than a fully-described file from the first click: enable metadata, watch Read fail at read-schema, enable schema, watch it fail at read-layout — the structural groups unlock the read step by step. No hint strings on the toggles — labels only, no spoilers. `include-descriptive-toggle` now gates only `variable_statistics`; custom entries are written whenever metadata is enabled regardless of any group toggle (clicking "+ Entry" is the intent — gating it under a default-off group would make the button silently write nothing). What each group's absence does to the read varies — it is NOT a uniform hard-fail: `schema` and `layout` off are the only unconditional hard-fails (`missing-schema` at read-schema / `missing-layout` at read-layout). `chunkIndex` off (D3's chunk index group) fails `no-chunk-index` only in single-file mode with a size-changing codec in play — otherwise offsets are computed from geometry, and per-chunk partitioning needs no chunk index at all (each chunk file is its own chunk, so the toggle has nothing to starve there). `codecs` off makes the reader assume an identity pipeline: it hard-fails (`decode-error`, via `AssumedIdentitySizeMismatchError`'s byte-count check) only when a size-changing codec was actually applied; a value-preserving codec (Delta, Byte Shuffle) garbles values *silently on a successful read* (the decode step's detail text narrates the assumption). `descriptive` off never fails anything — `variable_statistics` is optional everywhere; read-schema merely notes its absence. `include-endianness-toggle` also never fails, with a sharper edge: the reader silently assumes the host's byte order and proceeds, so a big-endian file written with it off reads successfully with wrong values rather than failing honestly.
- `metadata-key-override-note-{i}` — the informational note on a custom entry row whose key matches an auto-collected key ("overrides auto-collected `{key}`"). Override-wins semantics: the custom entry's value replaces the auto entry's value in place (position preserved) rather than being renamed away — the old `user_`-prefix rename and its `metadata-key-collision-warning-{i}` warning border are both gone; this is deliberately just an informational note now, since lying to the reader (wrong `shape`, fake `codec_pipelines`) is an intended lesson, not a mistake to warn against. The empty-key warning border on a blank custom key is unaffected.
- `metadata-entries-view` — the Metadata stage pane's default view mode (first in `[Entries, Hex, Flat]`, so it wins the pane's existing first-mode fallback): a key/value table parsed from that stage's own serialized bytes (binary mode additionally shows each row's numeric tag and type code — the spec-lookup step made visible). `metadata-entry-{key}` — individual entry rows. Empty state: metadata disabled reads "metadata is disabled — nothing is assembled". (A "no entries" string also exists as a defensive branch, but it's unreachable in practice — `collectMetadata` unconditionally emits the `metadata_format` envelope entry whenever metadata is enabled, so even all-groups-off with no custom entries renders one row.) Per CLAUDE.md pitfall 8, the worker computes and includes the parsed entries in the stage payload — the component only renders, it does not call `decodeMetadataBinary`/`collectMetadata` itself.
- `magic-input` — the Write section's magic-number hex input
- `read-status` — the sidebar's Read section status display
- `read-status-progress` — the sidebar Read section's step-progress line above the status message ("8/8 steps", or "N/8 steps · failed at: {label}" on failure)
- `read-process-view` — the Read stage pane's "Process" view mode, rendering the reader's narrated 8-step log; `read-step-{id}` — individual step rows within it (ids per `READ_STEP_ORDER` in `src/engine/read.ts`)
- `file-explorer` — the output file list container; `file-entry-{i}` — individual file rows
- `shape-input` (tabular) / `shape-input-{d}` (array) — dataset shape inputs
- `add-variable` — the Schema section's "add variable" button
- `variable-row-{index}`, `variable-name-{index}` — per-variable Schema editor rows and name inputs
- `variable-color-{index}` — per-variable Schema editor color dot (a button; always enabled, even when a bound curated source locks that row's logicalType-family controls — see the `variable-source-{index}` entry below; name and color are never locked). Clicking opens a popover: `variable-color-swatch-{i}` — the 10 palette swatches (click commits immediately), `variable-color-custom` — opens the native OS color dialog, which commits exactly once on dialog close (DOM `change` event, never per-drag `input` events — every color commit triggers a full worker recompute)
- `about-button` — Header's ⓘ button that opens the About modal
- `about-modal` — the About modal's panel container
- `about-performance-toggle` — the About modal's collapsed-by-default Performance section toggle
- `about-blog-link-{i}` — the About modal's "Further reading" list of all five `BLOG_POSTS` entries (`src/components/guide/steps.ts`), rendered after the GitHub link with the same anchor styling
- `guide-link-{i}` — the GuidePanel's per-step "Further reading" list (`GuideStep.links`, a subset/full slice of `BLOG_POSTS`), rendered after the "Try it" box; present on `intro` (all five), `chunk` (the two Chunks and Chunkability posts), `codecs` (the raster-compression post), and `metadata` (the metadata post) — omitted elsewhere
- `grid-canvas` — GridView's canvas render, used above `MAX_CELLS` (10,000 cells) in place of the DOM grid; `grid-canvas-status` — its hover status line (`variable[row,col] = value`). `grid-hover-cell` / `grid-hover-chunk` — the canvas mode's absolutely-positioned overlay divs for the hovered value (filled `var(--hover-strong)`) and its containing chunk (filled `var(--hover-weak)`, plus a 1px `var(--chunk-outline)` edge); both can render simultaneously (same value+chunk-mate convention as the DOM-mode grid and every other viewer). Scale for their positioning is derived from the canvas element's own rendered width, not the padded scroll container, so they stay pixel-aligned with the mouse at any scroll position.
- `grid-stretch-select` — GridView's per-pane contrast-stretch picker ("stretch: 2–98%" / "stretch: min–max") for the numeric value→color ramp; defaults to percentile (not persisted AppState — a per-session view knob like the selected-variable tab). Hidden for text variables (ordinal colorValues are uniform by construction) and while diff coloring is active (its own diverging maxAbsDiff scale isn't affected by the stretch).
- `hex-overview` — HexView's FileMapStrip, shown for windowed sections above `WINDOWED_SECTION_ROWS` (262,144 rows); click-to-jump. `hex-offset-input` — the paired offset-jump text input (accepts hex like `0x100000`, Enter to jump)
- `element-cap-warning` — the Schema section's banner when total values (shape product × variable count) exceed `SOFT_ELEMENT_CAP` (8,000,000). Two tiers: advisory yellow up to `HARD_ELEMENT_CAP` (32,000,000, `src/engine/pipelineCompute.ts`), red above it — past the hard cap `pipelineCapError` makes both compute entries refuse (worker `ok:false`, stale view retained) instead of OOM-crashing, persistence drops oversized saves to defaults on load (no crash loop), and MetadataEditor skips its per-chunk placeholder index. There's also `HARD_CHUNK_CAP` (1,048,576 chunks) for tiny-chunk explosions. Shape and chunk-shape `NumberInput`s commit on blur/Enter only (`commitOnBlur`), so Playwright must `fill()` then `blur()` (or press Enter) to commit them.
- `variable-source-{index}` — per-variable Schema editor source dropdown, the entire curated-data mechanism (there is no schema-wide dataset picker anymore — see the migration note below). First option `Generated` (value `custom`), then the static catalog `CURATED_VARIABLES` (`src/datasets/registry.ts` — 7 variables across 3 datasets: `etopo-dem`/`elevation`, `sst-field`/`sst`, `ghcn-daily`/`date`+`tmax`+`tmin`+`prcp`+`station`) filtered to the active data model and grouped by dataset via `<optgroup>`, option value `${datasetId}/${variableName}`. Selecting a source dispatches `UPDATE_VARIABLE` with the `{ datasetId, variableName }` ref (`Variable.source`, or `null`/`undefined` to clear it back to `custom`); the reducer (`src/state/useAppState.ts`'s `UPDATE_VARIABLE` case) resolves the ref against the catalog and, if found, overwrites that row's `logicalType` (deep copy of the catalog entry) and `typeAssignment` (numeric → the catalog's `dtype`; text → `char16`). A manifest numeric variable may declare `scale` (`ManifestNumericVariable.scale`, `src/datasets/types.ts`): the bin holds a fixed-precision integer encoding and `decodeNumericBin` divides it out, so GHCN's int16 tenths decode to °C/mm at one decimal (`logicalType: decimal`, `decimalPlaces: 1`). For those rows the catalog's `dtype` is deliberately the **unscaled** `float32`, not the bin's `int16` — a fresh drop-in costs 4 bytes/value and re-deriving the 2-byte `{ storageDtype: 'int16', scale: 10 }` assignment is the scale/offset lesson, which the two tabular presets ship pre-set. `date` is int32 **days since 1970-01-01** (Parquet/Arrow DATE), not yyyymmdd; the presets carry CF-style `date_units`/`temperature_units`/`precipitation_units` in `customEntries`. While `v.source` is set, the row's **generation controls are hidden entirely** (`{!v.source && ...}` around the logicalType/min/max/wordset/decimalPlaces/sigfigs row and the generation-mode row — they only feed `generateValues`, so on a curated row they're dead controls, not merely disabled ones; the reducer still refuses `logicalType` changes while a source is set). **Name, color, shape, typeAssignment, and codecs all stay fully editable** on a curated row (unlike the deleted dataset mechanism, which froze name and shape too). `variable-source-attribution-{index}` — the tertiary informational attribution hint line shown while a row has a source (the catalog's `attribution` string). Binding a source also seeds `metadata.customEntries` with that dataset's provenance (and, for the two gridded datasets, spatial `crs`/`bbox`/`transform`, plus units keys for `ghcn-daily`) via `DATASET_SEED_ENTRIES` (`src/datasets/registry.ts`) — the reducer's `UPDATE_VARIABLE` case appends each seed entry whose key isn't already present (idempotent, first-source-wins on key conflicts, no unseeding on clear/change: seeded entries are plain custom entries the user can edit or delete like any other). Values: `computeValuesStage` fetches each distinct `source` ref's real array once per worker lifetime (promise-cached in `src/worker/pipeline.worker.ts`'s `sourceValuesCache`, keyed `${datasetId}/${variableName}`) and fills the variable via `fillFromSource` (`src/engine/sourceFill.ts`) — modulo tile/crop against the schema's *current* shape, trailing dims aligned, unmatched leading schema dims broadcast, unmatched leading source dims cropped to index 0. This means a curated row's shape is never locked: shrinking the schema below the source's natural shape crops, growing it beyond tiles (wraps). A `source` ref that fails to resolve (unknown dataset, fetch/manifest error) fails that compute loudly (`computeValuesStage` throws) rather than silently falling back to generated values. Curated data is fetched from the orphan `data` branch (dev: vite `data-dev` middleware serving `data-branch-work/` then `tests/fixtures/`). The four top-level FORMAT presets (Header `preset-select`: Parquet-adjacent + Avro-esque for tabular, GeoTIFFesque + Zarrish for array) carry curated `source` refs on their variables plus provenance (source/source_url/retrieved/license, plus spatial/units keys where applicable) as plain, ordinary `metadata.customEntries`, baked in verbatim rather than seeded at load time (a preset is just a full `AppState` snapshot loaded once) — but the values are identical to what `DATASET_SEED_ENTRIES` would seed for the same source, so loading a preset and then re-picking the same source on a row adds nothing new. All four use a Pyodide-backed codec (deflate/zstd), so their round-trip is validated in-browser by `scenario-curated-variables.mjs`, not in the node vitest suite.
- **Migration note:** the old schema-wide dataset picker (`dataset-select`/`dataset-attribution`/`dataset-loading`/`dataset-error` testids, `state.dataset`, `APPLY_DATASET`/`SET_DATASET_CUSTOM` actions, `isDatasetVariable`/id-prefix binding, `DATASET_LOCKED_ACTIONS`) is gone entirely, replaced by the per-variable `variable-source-{index}` mechanism above. Old persisted saves with a non-null top-level `dataset: { id, ... }` are DROPPED, not migrated (`src/state/persistence.ts`'s `migrateState` returns `null`, degrading to defaults) — the id-prefix binding shape isn't worth converting to per-variable `source` refs.

New UI work should keep adding testids per these conventions rather than relying on text/structure selectors.

## Code Conventions

### File organization

Follow the project structure in the design doc. Keep engine logic in `src/engine/`, types in `src/types/`, React components in `src/components/`, state management in `src/state/`, hooks in `src/hooks/`.

### State management

Use React's built-in `useState`, `useMemo`, `useContext`. If prop drilling becomes painful, introduce Zustand — but try without it first.

### Styling

Use inline styles with values from `src/theme.ts`. The design doc specifies all colors, fonts, and spacing. Do not use CSS-in-JS libraries or Tailwind. A single `src/index.css` file can define CSS custom properties from the theme for use in rare cases where inline styles aren't sufficient (e.g., scrollbar styling, focus outlines).

### Performance

- Memoize all pipeline stage computations. A change to codec params should not recompute chunking or interleaving.
- Virtual scrolling for all list-type views. Use `@tanstack/react-virtual`.
- Debounce localStorage saves at 500ms.
- Keep the total element count reasonable (soft warn above `SOFT_ELEMENT_CAP` = 8,000,000 total values, `src/components/config/SchemaEditor.tsx` — advisory; hard refusal above `HARD_ELEMENT_CAP` = 32,000,000 or `HARD_CHUNK_CAP` = 1,048,576 chunks via `pipelineCapError`, `src/engine/pipelineCompute.ts`).

### Error handling

Do not crash on invalid user input. Degenerate states (zero variables, empty codecs, etc.) should produce empty but valid pipeline outputs. See the Edge Cases table in the design doc.

## Common Pitfalls

Based on earlier prototyping (and a full remediation pass — see `docs/remediation-plan.md`), these are the things most likely to go wrong:

1. **Byte tracing through codecs — three modes, declared by the codec, not guessed at the call site.** A codec's `traceMode` (`CodecDefinition`, `src/types/codecs.ts`) says how far per-value tracing survives it; `encodedChunkMeta` (`src/engine/layout.ts`) folds a pipeline's steps into the worst mode any step declares (degradation is monotone) and that becomes `ChunkBlockRegion.mode`:

   - **`value-preserving`** (the default, absent field) — the codec rewrites values in place without moving bytes: Delta, Zigzag. Byte offset N still holds element N's data, so the traceId stays `${variableName}:${coords}` and cross-pane hover linking works normally. Non-codec stages are all here too, including the Typed stage, where a variable's dtype actually changes (float64 logical values → int16 storage bytes) — a dtype change alone doesn't break the one-to-one mapping from a value to its bytes.
   - **`positional`** — the codec permutes bytes *within* the chunk: Byte Shuffle. The slot geometry survives (these codecs preserve byte size) but a slot is no longer its element's bytes, so its traceId is `makeSlotTraceId(startByte, byteCount)` (`src/engine/trace.ts`) — deliberately un-matchable by any other pane, which makes a value hover degrade to the chunk wash instead of strong-highlighting a byte range that isn't that element's. HoverBar renders `hover-bar-positional` to say so.
   - **`chunk-level`** — no byte carries per-element meaning: every entropy codec (RLE, deflate/gzip/zstd, dictionary — they change the byte count, breaking 1:1 mapping) plus Bit Shuffle (one output byte packs one bit from each of 8 elements). The whole chunk becomes one opaque span.

   Do not try to maintain per-value tracing through a codec that doesn't declare it. Adding a codec that moves or mixes bytes without setting `traceMode` is the bug this list exists to prevent: it silently inherits `value-preserving` and the UI confidently points at the wrong bytes.

   **Display values follow the same principle.** A stage's `ValueSources.bytes` is that stage's *own* bytes, and `traceAt` decodes chunk-region display values out of them rather than looking up the pre-codec `values` map — so the Encoded stage shows what its bytes actually say (Delta shows differences; Byte Shuffle shows the garbage a reader ignoring the codec would decode). Pointing the Encoded stage at pre-codec values was the original bug here: every codec displayed its input.

   As of the perf plan's Task 10, no `ByteTrace[]` is materialized anywhere in production: every trace is computed on demand from a stage's `StageLayout` via `traceAt`/`byteRangesForTrace` (`src/engine/layout.ts`) — O(1)/O(log n) lookups against layout regions rather than arrays. The pre-Task-10 array-building code survives only as a frozen, test-only reference implementation (`tests/unit/helpers/referenceTraces.ts`) that the layout equivalence tests pin against; it mirrors the three modes above. `tests/unit/engine/encodedTracing.test.ts` pins the per-mode behavior directly, and `tests/ui/scenario-hover-linking.mjs` pins it in the UI.

2. **Virtual scrolling + hover state interaction.** Virtual scrolling unmounts rows that scroll out of view. Hover state must not depend on mounted elements — use data indices, not DOM refs. The `@tanstack/react-virtual` library handles this correctly if you key rows by data index. (GridView's hover currently uses `querySelector` as a DOM-ref-shaped exception — see `docs/remediation-plan.md` UI-19 — because it isn't virtualized; don't copy that pattern into a view that is.)

3. **Type-assignment and codec dtype flow are two separate mechanisms — don't conflate them.** Scale/offset and bit-rounding are **not codecs**; they live on `Variable.typeAssignment` and are applied once, in the Typed stage (`src/engine/typeAssign.ts`'s `assignType`), converting a variable's logical values directly to its `storageDtype`. The **codec pipeline** (Delta, Byte Shuffle, RLE, LZ — `src/engine/codecs.ts`) runs afterward, entirely within that fixed storage dtype (or `uint8` after an entropy codec): each step's `encode()` input dtype is the previous step's `outputDtype`, and `outputDtypeFor(codec, inputDtype)` is the single source of truth for that flow — call it rather than re-deriving the rule locally (`reverseCodecPipeline` and `isPipelineLossy` both used to, and both silently went stale when the rule changed). The rule: **`uint8` for anything whose output has no elements in it** — every entropy codec, *and* every codec declaring a `traceMode` (Byte Shuffle's byte planes, Bit Shuffle's bit planes). Only value-rewriting codecs (Delta, Zigzag) preserve the input dtype. A codec that moves bytes must not report the pre-move dtype: that lie propagates into the next step's `elementSize`, the ⚠ warnings, and the dtype label on the step. What the Encoded *pane* draws for a positional slot is a different question with a different answer — `encodedChunkMeta().slotDtype`, the pre-shuffle element a naive reader would decode there. If you need to reverse either direction, `reverseCodecPipeline` (`src/engine/decode.ts`) walks the codec pipeline backward first, and only then does `reverseTypeAssignment` (`src/engine/typeAssign.ts`) undo the type assignment — they are sequential phases, not interleaved steps of one pipeline. Test the dtype flow explicitly at both boundaries: within the codec pipeline itself, and at the handoff where the fully-reversed codec pipeline's output dtype must equal the variable's `typeAssignment.storageDtype` before `reverseTypeAssignment` runs.

4. **Interleaving mode switches.** When switching from column to row interleaving, per-field codec pipelines (`fieldPipelines`, keyed by `Variable.id`) become inactive (but are preserved in state — `SET_INTERLEAVING` never touches them). When switching back, they reactivate unchanged. The codec section UI (`CodecSection.tsx`) must reflect this correctly.

5. **Resizable panels breaking layout.** The app is `height: 100vh` with no page scroll. Resizable panels must respect min/max constraints and not cause overflow. Test at various viewport sizes.

6. **Hex view alignment.** Each row must show exactly 16 bytes (or fewer for the last row). The offset column, hex bytes, gap at byte 8, and ASCII column must align across all rows regardless of content — including the last, short row, where padding columns must not receive their own separators (an earlier bug shifted the ASCII column on any byte count not a multiple of 16). Use monospace font and fixed-width spans.

7. **Seeding localStorage for agents/tests: use `seedStateAndReload`, not a bare `evaluate` + `reload`.** The app's normal 500ms debounced save is also flushed synchronously on `pagehide` (see `docs/design.md`'s State Management section) so last-second edits aren't lost when a tab closes or navigates away. That flush fires on the *outgoing* document during navigation and will silently clobber anything written via `page.evaluate(() => localStorage.setItem(...))` immediately before `page.reload()` — the seed appears to "not take" for no visible reason. `tests/ui/scenario-helpers.mjs`'s `seedStateAndReload(page, entries)` avoids this by using `page.context().addInitScript(...)` to set the values on the *incoming* document before any app code runs, guaranteeing the seed always wins regardless of the outgoing page's flush timing. Any new Playwright scenario (or agent-driven UI test) that needs to pre-seed `localStorage` before a fresh load should use this helper rather than reimplementing evaluate-then-reload.

8. **No engine compute on the main thread from components.** Components never call `src/engine/` compute functions directly — everything goes through the worker (`src/worker/pipeline.worker.ts` via `src/worker/client.ts`). The one existing main-thread engine call (`MetadataEditor`'s `buildPlaceholderChunkIndex`) froze the tab once; it's grandfathered in and cap-gated, not a precedent to extend. New previews that need engine output should subscribe to a worker stage payload instead of duplicating the compute inline.
