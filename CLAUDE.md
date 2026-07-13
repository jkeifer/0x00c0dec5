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
node tests/ui/scenario-dataset-presets.mjs
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
- `hover-bar` — the cross-stage hover info bar
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
- `runtime-banner` — the Pyodide load-progress strip rendered under the Header; narrates loading (`runtime-banner-step-{id}` per step, ids from `RUNTIME_STEP_ORDER` in `src/engine/pyodideRuntime.ts`, prefix text "Loading compression runtime:") and, on failure, becomes a dismissible error (`runtime-banner-dismiss`) with text prefixed `Compression codecs unavailable:`. Unmounts entirely (not just hidden) once the runtime is ready or the error is dismissed.
- `linearization-select` — the Chunk section's element-traversal-order picker (C order / Fortran order / Morton), rendered only for the array model with `shape.length > 1`
- `byte-order-toggle` — the Chunk section's little/big-endian select, visible for both data models at every ndim (unlike `linearization-select`, not gated on array/multi-dim)
- `footer-locator-toggle` — D1 footer locator radio (trailer/none), shown only when metadata placement is footer
- `include-schema-toggle`, `include-layout-toggle`, `include-codecs-toggle`, `include-chunk-index-toggle`, `include-descriptive-toggle`, `include-endianness-toggle` — the Metadata section's six granular include-group toggles (`MetadataIncludeConfig`), each gating a specific set of metadata keys. The first five starve a specific, named Read step when off (`include-chunk-index-toggle` is D3's chunk index group specifically). `include-endianness-toggle` is semantically different: omitting it doesn't fail the read at all — the reader silently assumes the host's byte order and proceeds, so a big-endian file written with it off reads successfully with wrong values rather than failing honestly (the other five toggles' hard-fail-a-named-step behavior does not apply to it).
- `include-metadata-toggle` — the read-extension's "Include metadata" toggle in Write
- `magic-input` — the Write section's magic-number hex input
- `read-status` — the sidebar's Read section status display
- `read-status-progress` — the sidebar Read section's step-progress line above the status message ("8/8 steps", or "N/8 steps · failed at: {label}" on failure)
- `read-process-view` — the Read stage pane's "Process" view mode, rendering the reader's narrated 8-step log; `read-step-{id}` — individual step rows within it (ids per `READ_STEP_ORDER` in `src/engine/read.ts`)
- `file-explorer` — the output file list container; `file-entry-{i}` — individual file rows
- `shape-input` (tabular) / `shape-input-{d}` (array) — dataset shape inputs
- `add-variable` — the Schema section's "add variable" button
- `variable-row-{index}`, `variable-name-{index}` — per-variable Schema editor rows and name inputs
- `variable-color-{index}` — per-variable Schema editor color dot (a button; always enabled, even when the dataset lock disables name/logicalType). Clicking opens a popover: `variable-color-swatch-{i}` — the 10 palette swatches (click commits immediately), `variable-color-custom` — opens the native OS color dialog, which commits exactly once on dialog close (DOM `change` event, never per-drag `input` events — every color commit triggers a full worker recompute)
- `about-button` — Header's ⓘ button that opens the About modal
- `about-modal` — the About modal's panel container
- `about-performance-toggle` — the About modal's collapsed-by-default Performance section toggle
- `about-blog-link-{i}` — the About modal's "Further reading" list of all five `BLOG_POSTS` entries (`src/components/guide/steps.ts`), rendered after the GitHub link with the same anchor styling
- `guide-link-{i}` — the GuidePanel's per-step "Further reading" list (`GuideStep.links`, a subset/full slice of `BLOG_POSTS`), rendered after the "Try it" box; present on `intro` (all five), `chunk` (the two Chunks and Chunkability posts), `codecs` (the raster-compression post), and `metadata` (the metadata post) — omitted elsewhere
- `grid-canvas` — GridView's canvas render, used above `MAX_CELLS` (10,000 cells) in place of the DOM grid; `grid-canvas-status` — its hover status line (`variable[row,col] = value`). `grid-hover-cell` / `grid-hover-chunk` — the canvas mode's absolutely-positioned overlay divs for the hovered value (filled `var(--hover-strong)`) and its containing chunk (filled `var(--hover-weak)`, plus a 1px `var(--chunk-outline)` edge); both can render simultaneously (same value+chunk-mate convention as the DOM-mode grid and every other viewer). Scale for their positioning is derived from the canvas element's own rendered width, not the padded scroll container, so they stay pixel-aligned with the mouse at any scroll position.
- `grid-stretch-select` — GridView's per-pane contrast-stretch picker ("stretch: 2–98%" / "stretch: min–max") for the numeric value→color ramp; defaults to percentile (not persisted AppState — a per-session view knob like the selected-variable tab). Hidden for text variables (ordinal colorValues are uniform by construction) and while diff coloring is active (its own diverging maxAbsDiff scale isn't affected by the stretch).
- `hex-overview` — HexView's FileMapStrip, shown for windowed sections above `WINDOWED_SECTION_ROWS` (262,144 rows); click-to-jump. `hex-offset-input` — the paired offset-jump text input (accepts hex like `0x100000`, Enter to jump)
- `element-cap-warning` — the Schema section's advisory banner when total values (shape product × variable count) exceed `SOFT_ELEMENT_CAP` (8,000,000); does not block anything
- `dataset-select` — the Schema section's dataset preset picker (real-data samples per model + "Custom (generated)" last); `dataset-attribution` — provenance line shown while a dataset is active; `dataset-loading` / `dataset-error` — manifest fetch states. Selecting a dataset applies **SCHEMA + METADATA ONLY**: shape, variables (new ids `{datasetId}-{name}`, name/logicalType/color from the manifest, `typeAssignment` defaulted from the data's own natural storage dtype — number→`{storageDtype: mv.dtype}`, string→`char16`), empty field pipelines for the new ids, chunkShape RECONCILED to the new shape (shared `reconcileChunkShape` helper in `src/types/state.ts`, used by SET_SHAPE too), and provenance metadata (source/source_url/retrieved/license) **APPENDED** to `metadata.customEntries` (preserving the user's own entries). It does NOT touch interleaving/linearization/byteOrder/chunkPipeline/write. The seeded entries are recorded in `state.dataset.seededEntries`; deselecting (or re-applying a different dataset) REMOVES only the still-unmodified seeded entries (matched key AND value) — edited entries survive. While a dataset is active the schema lock is partial (composition is allowed): **shape stays dataset-owned** (`SET_SHAPE` is a no-op — the sole entry left in `DATASET_LOCKED_ACTIONS` at the top of the reducer), but you can **add and remove variables** — a custom variable added alongside the dataset generates values like any other, and removing a dataset-backed variable is fine (re-applying the dataset restores its full set). Binding of real vs. generated values is by variable-id PREFIX, never by name: `isDatasetVariable(datasetId, v)` (`src/types/state.ts` — single source of truth for reducer, SchemaEditor, and `computeValuesStage`) is true iff `v.id.startsWith(datasetId + '-')`, so a custom variable the user names identically to a dataset one is NOT handed the dataset's values. `UPDATE_VARIABLE`'s name/logicalType freeze applies only to dataset-backed rows (via that helper); custom rows are fully editable, and `typeAssignment`/`color` stay editable for everyone. In `computeValuesStage`, dataset-backed variables MUST get their preset array (fail loud, scoped per-variable, if the name is missing or the length mismatches); everyone else generates. Everything downstream (typeAssignment, codecs, chunking, metadata, write) stays editable. Dataset values are fetched by the worker from the orphan `data` branch (dev: vite `data-dev` middleware serving `data-branch-work/` then `tests/fixtures/`). The curated codec/chunking/write configs that datasets used to apply now live in the top-level FORMAT presets (Header `preset-select`: Parquet-adjacent + Avro-esque for tabular, GeoTIFFesque + Zarrish for array), each a full AppState snapshot carrying a `dataset` ref of its own (so loading one fetches real data). All four use a Pyodide-backed codec (deflate/zstd), so their round-trip is validated in-browser by `scenario-dataset-presets.mjs`, not in the node vitest suite.

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
- Keep the total element count reasonable (soft warn above `SOFT_ELEMENT_CAP` = 8,000,000 total values, `src/components/config/SchemaEditor.tsx` — advisory only, does not block).

### Error handling

Do not crash on invalid user input. Degenerate states (zero variables, empty codecs, etc.) should produce empty but valid pipeline outputs. See the Edge Cases table in the design doc.

## Common Pitfalls

Based on earlier prototyping (and a full remediation pass — see `docs/remediation-plan.md`), these are the things most likely to go wrong:

1. **Byte tracing through size-changing codecs.** RLE and LZ change the byte count, breaking 1:1 trace mapping. After these codecs, traces must degrade to chunk-level. Do not try to maintain per-value tracing through entropy codecs. Every other stage — including the Typed stage, where a variable's dtype actually changes (e.g. float64 logical values → int16 storage bytes) — keeps perfect per-value tracing, because a dtype change alone doesn't change whether the mapping from source value to its bytes is one-to-one. Only entropy codecs (the only size-changing steps left in the codec registry) force the degradation. As of the perf plan's Task 10, no `ByteTrace[]` is materialized anywhere in production: every trace is computed on demand from a stage's `StageLayout` via `traceAt`/`byteRangesForTrace` (`src/engine/layout.ts`) — the semantics above are unchanged (per-value everywhere, chunk-level after entropy codecs), only the representation moved from arrays to O(1)/O(log n) lookups against layout regions. The pre-Task-10 array-building code survives only as a frozen, test-only reference implementation (`tests/unit/helpers/referenceTraces.ts`) that the layout equivalence tests pin against.

2. **Virtual scrolling + hover state interaction.** Virtual scrolling unmounts rows that scroll out of view. Hover state must not depend on mounted elements — use data indices, not DOM refs. The `@tanstack/react-virtual` library handles this correctly if you key rows by data index. (GridView's hover currently uses `querySelector` as a DOM-ref-shaped exception — see `docs/remediation-plan.md` UI-19 — because it isn't virtualized; don't copy that pattern into a view that is.)

3. **Type-assignment and codec dtype flow are two separate mechanisms — don't conflate them.** Scale/offset and bit-rounding are **not codecs**; they live on `Variable.typeAssignment` and are applied once, in the Typed stage (`src/engine/typeAssign.ts`'s `assignType`), converting a variable's logical values directly to its `storageDtype`. The **codec pipeline** (Delta, Byte Shuffle, RLE, LZ — `src/engine/codecs.ts`) runs afterward, entirely within that fixed storage dtype (or `uint8` after an entropy codec): each step's `encode()` input dtype is the previous step's `outputDtype`, and `outputDtypeFor(codec, inputDtype)` is the single source of truth for that flow (entropy codecs → `uint8`, everything else preserves dtype) — call it rather than re-deriving the rule locally. If you need to reverse either direction, `reverseCodecPipeline` (`src/engine/decode.ts`) walks the codec pipeline backward first, and only then does `reverseTypeAssignment` (`src/engine/typeAssign.ts`) undo the type assignment — they are sequential phases, not interleaved steps of one pipeline. Test the dtype flow explicitly at both boundaries: within the codec pipeline itself, and at the handoff where the fully-reversed codec pipeline's output dtype must equal the variable's `typeAssignment.storageDtype` before `reverseTypeAssignment` runs.

4. **Interleaving mode switches.** When switching from column to row interleaving, per-field codec pipelines (`fieldPipelines`, keyed by `Variable.id`) become inactive (but are preserved in state — `SET_INTERLEAVING` never touches them). When switching back, they reactivate unchanged. The codec section UI (`CodecSection.tsx`) must reflect this correctly.

5. **Resizable panels breaking layout.** The app is `height: 100vh` with no page scroll. Resizable panels must respect min/max constraints and not cause overflow. Test at various viewport sizes.

6. **Hex view alignment.** Each row must show exactly 16 bytes (or fewer for the last row). The offset column, hex bytes, gap at byte 8, and ASCII column must align across all rows regardless of content — including the last, short row, where padding columns must not receive their own separators (an earlier bug shifted the ASCII column on any byte count not a multiple of 16). Use monospace font and fixed-width spans.

7. **Seeding localStorage for agents/tests: use `seedStateAndReload`, not a bare `evaluate` + `reload`.** The app's normal 500ms debounced save is also flushed synchronously on `pagehide` (see `docs/design.md`'s State Management section) so last-second edits aren't lost when a tab closes or navigates away. That flush fires on the *outgoing* document during navigation and will silently clobber anything written via `page.evaluate(() => localStorage.setItem(...))` immediately before `page.reload()` — the seed appears to "not take" for no visible reason. `tests/ui/scenario-helpers.mjs`'s `seedStateAndReload(page, entries)` avoids this by using `page.context().addInitScript(...)` to set the values on the *incoming* document before any app code runs, guaranteeing the seed always wins regardless of the outgoing page's flush timing. Any new Playwright scenario (or agent-driven UI test) that needs to pre-seed `localStorage` before a fresh load should use this helper rather than reimplementing evaluate-then-reload.
