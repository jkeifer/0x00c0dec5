# Review Items Implementation Plan (grid fixes, collapse, blog links, 2D smooth, dataset composition, GeoTIFFesque rework, guide accuracy)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land seven user-reviewed improvements: fix GridView canvas hover misalignment and low-contrast highlights, add collapsible sidebar/panes, link blog posts from the guide and About modal, make the `smooth` generator genuinely 2D, allow composing generated variables alongside an active dataset, rework GeoTIFFesque into a multi-band row-interleaved preset with binary metadata, and re-verify guide content accuracy.

**Architecture:** All engine changes (generator, values-stage composition) land with vitest tests first, per the project's engine-before-UI rule. UI changes are verified with Playwright against the dev server and extend the standing `tests/ui/scenario-*.mjs` harness. Tasks 1–4 are independent; Task 5 unblocks Task 6; Task 7 (guide accuracy) runs last because Tasks 5–6 change user-visible behavior the guide describes.

**Tech Stack:** React + TypeScript + Vite, vitest (unit, in `tests/unit/`), Playwright scenarios (`tests/ui/scenario-*.mjs` + `scenario-helpers.mjs`), `react-resizable-panels` v4 (already installed).

## Global Constraints

- Styling: inline styles from `src/theme.ts`; CSS custom properties only in `src/index.css`. No CSS-in-JS, no Tailwind, no new dependencies.
- Every new interactive element gets a `data-testid` following CLAUDE.md conventions, and CLAUDE.md's testid list is updated in the same task that adds one.
- Engine layer (`src/engine/`) must be tested and correct before dependent UI work. Unit tests go in `tests/unit/` (NOT `src/__tests__`).
- Dev server for scenarios: `npm run dev` serves `http://localhost:5173/0x00c0dec5/`. Seed localStorage in scenarios only via `seedStateAndReload` from `tests/ui/scenario-helpers.mjs`.
- Run `npx vitest run` for unit suites; run touched scenario files individually with `node tests/ui/scenario-<name>.mjs` against a running dev server.
- Hover highlight convention (from `src/index.css:31-37`): strong emphasis = filled `var(--hover-strong)`, weak/secondary = filled `var(--hover-weak)`. GridView must adopt this, not thin monochrome outlines.
- Do not crash on invalid user input; degenerate states produce empty-but-valid pipeline output.
- Presets in `src/presets/*.json` are full AppState snapshots. Before hand-editing one, check `scripts/` for the preset generation/regeneration flow used by prior projects (ledger notes "presets regenerated" in tasks R1, DP-3) and use it if it exists.
- Commit per task with conventional-commit style messages matching recent `git log`.

---

### Task 1: GridCanvas overlay alignment fix + grid hover symbology

**Files:**
- Modify: `src/components/viewers/GridCanvas.tsx` (scale computation ~line 52; hover/chunk overlay divs ~lines 222-252; `chunkPixelBounds` ~lines 171-181)
- Modify: `src/components/viewers/GridView.tsx` (DOM-mode cell highlight styles ~lines 361-377)
- Modify: `tests/ui/scenario-hover-linking.mjs` (add grid-canvas alignment + visibility checks)

**Interfaces:**
- Consumes: existing `coordsFromEvent` (`GridCanvas.tsx:77-85`, correct — do not change its use of `getBoundingClientRect` on the canvas), `hoverHighlightFor` (`src/components/viewers/hoverHighlight.ts`), CSS vars `--hover-strong`/`--hover-weak` (`src/index.css:36-37,89-90`).
- Produces: nothing new consumed by later tasks.

**Background — the two defects:**

1. **Overlay misalignment (canvas mode only).** `GridCanvas.tsx:52` computes `scale = containerRef.current.clientWidth / cols`, but `containerRef` is the scrollable wrapper with `padding: spacing.sm` (8px per side, line ~204) while the canvas fills only the content box. The hover overlay and chunk rect (`left/top = col*scale`) therefore drift right/down progressively. Hit-testing (`coordsFromEvent`) measures the canvas element directly and is correct — only the overlay math is wrong.
2. **Low-contrast highlights (both modes).** Hovered cell = `outline: 2px solid ${colors.textPrimary}`; chunk-mates/chunk rect = `outline: 1px solid var(--chunk-outline)`. Both are near-invisible over low-value cells (the value ramp lerps to `rgb(20,20,20)`, `gridImage.ts:31-47`). Every other viewer (FlatView.tsx:136, TableView.tsx:315, HexRowRenderer.tsx:121,156) uses filled `var(--hover-strong)`/`var(--hover-weak)` overlays designed to read over any background. Do NOT change the value ramp itself (`gridImage.ts` `valueToRGB` stays as-is; its `ponytail:` comment about the dark floor stands — the complaint is about the highlight, not the ramp).

- [ ] **Step 1: Add failing scenario checks.** In `tests/ui/scenario-hover-linking.mjs`, add a grid-canvas section: seed a state (via `seedStateAndReload`) with an array-model shape large enough to trigger canvas mode (>10,000 cells, e.g. `[200, 200]`), switch a pane to grid view mode, `page.mouse.move()` to the center of a known cell far from the origin (e.g. the cell at row 150, col 150 — compute its expected pixel center from the canvas element's own `getBoundingClientRect()`), then assert:
  - the hover overlay div's bounding rect center is within 1 cell-width of the mouse position (this FAILS today because of the padding-based scale);
  - the hover overlay's computed `background-color` is non-transparent (alpha > 0) (FAILS today — outline only);
  - the chunk-rect overlay exists and its computed `background-color` is non-transparent (FAILS today).
  Give the overlay divs `data-testid="grid-hover-cell"` and `data-testid="grid-hover-chunk"` in Step 3 so the scenario can target them; write the scenario against those testids now.
- [ ] **Step 2: Run the scenario, confirm the new checks FAIL** (dev server running): `node tests/ui/scenario-hover-linking.mjs`.
- [ ] **Step 3: Fix.** In `GridCanvas.tsx`: derive `scale` from the canvas element's own rendered width (`canvasRef.current.clientWidth / cols`), keeping whatever resize-observation currently recomputes it (re-point the observer at the canvas if it observes the container). Change the hover overlay to `background: 'var(--hover-strong)'` and the chunk rect to `background: 'var(--hover-weak)'` (keep a 1px `var(--chunk-outline)` outline on the chunk rect for edge definition). Add the two testids. In `GridView.tsx` DOM mode: hovered cell gets a `var(--hover-strong)` fill layered over its value color (e.g. `backgroundImage: 'linear-gradient(var(--hover-strong), var(--hover-strong))'` on top of the existing `backgroundColor`), chunk-mates get the same treatment with `var(--hover-weak)`; drop the monochrome outlines.
- [ ] **Step 4: Run scenario, confirm all checks PASS**, and take a screenshot of the canvas grid with an active hover over a dark/low-value region to visually confirm the highlight reads clearly. Re-run the whole scenario file to confirm no existing checks regressed.
- [ ] **Step 5: Update CLAUDE.md testid list** (add `grid-hover-cell`, `grid-hover-chunk` under the grid entries).
- [ ] **Step 6: Commit.** `git add -A && git commit -m "fix: grid canvas hover alignment + adopt hover-strong/weak fills"`

---

### Task 2: Collapsible sidebar and comparison panes

**Files:**
- Modify: `src/components/layout/App.tsx` (`MainLayout`, lines ~59-140: `Panel` props, refs, collapsed-state tracking)
- Modify: `src/components/layout/Sidebar.tsx` (collapse button + collapsed rail rendering)
- Modify: `src/components/viewers/StagePane.tsx` (collapse button in pane chrome + collapsed rail rendering) — confirm actual path via the `pane-{paneId}` testid
- Modify: `tests/ui/scenario-pane-defaults.mjs` (collapse/expand checks)

**Interfaces:**
- Consumes: `react-resizable-panels` v4 `Panel` props `collapsible`, `collapsedSize`, and the imperative ref API `collapse()`/`expand()`/`isCollapsed()` (see `node_modules/react-resizable-panels/dist/react-resizable-panels.d.ts:205-266`). The existing `useDefaultLayout({id:'main-layout'})`/`({id:'panes-layout'})` persistence (App.tsx:67-68) already round-trips panel sizes including collapsed ones — do NOT add a parallel persistence mechanism (GuidePanel's `uiPrefs` collapse is a different, pre-existing pattern for a panel outside the group tree; don't copy it here).
- Produces: testids `sidebar-collapse-toggle`, `pane-collapse-left`, `pane-collapse-right` (same testid on the collapse button and the rail's expand button).

**Design:**
- All three `Panel`s (`sidebar`, `left-pane`, `right-pane`) get `collapsible` and `collapsedSize="36px"` plus a `panelRef`.
- Collapsed rendering follows the GuidePanel rail precedent (`GuidePanel.tsx:56-82`): a ~36px vertical rail containing only an expand button (chevron) with an `aria-label`. The child components need to know they're collapsed: track a `collapsed` boolean per panel in `MainLayout` state, updated from the panel callbacks (check the v4 d.ts for `onCollapse`/`onExpand`-style callbacks; if absent, derive from `onLayoutChanged` sizes) and from the toggle handlers, and pass it down as a prop (`collapsed` + `onToggleCollapse`).
- Collapse buttons live in the owning component's existing header/chrome row (Sidebar top; StagePane's dropdown row), styled like existing small icon buttons there.
- Guard: the two comparison panes must never both be collapsed — when collapsing one while the other is already collapsed, expand the other first.
- Dragging a collapsed panel's separator outward should expand it (library default behavior for `collapsible` — verify, don't fight it).

- [ ] **Step 1: Add failing scenario checks** in `tests/ui/scenario-pane-defaults.mjs`: (a) `pane-collapse-left` exists; click it → `pane-left` container width ≤ 40px and `pane-right` grows; (b) click again (the rail's expand button) → width restored above 200px; (c) collapse left, then click `pane-collapse-right` → left auto-expands (both-collapsed guard); (d) `sidebar-collapse-toggle` collapses/expands the sidebar the same way.
- [ ] **Step 2: Run scenario, confirm new checks FAIL.**
- [ ] **Step 3: Implement** per the design above.
- [ ] **Step 4: Run scenario, confirm PASS; re-run the whole file for regressions.** Also screenshot collapsed states (sidebar collapsed; left pane collapsed) to verify no layout overflow at default viewport, since the app is `height: 100vh` with no page scroll.
- [ ] **Step 5: Update CLAUDE.md testid list.**
- [ ] **Step 6: Commit.** `git commit -m "feat: collapsible sidebar and comparison panes"`

---

### Task 3: Blog post links — guide steps + About modal

**Files:**
- Modify: `src/components/guide/steps.ts` (`GuideStep` type + step data + exported post list)
- Modify: `src/components/guide/GuidePanel.tsx` (render links)
- Modify: `src/components/layout/AboutModal.tsx` (Further reading section)
- Test: extend the existing guide/steps unit test if one exists in `tests/unit/` (check first), else add `tests/unit/guideLinks.test.ts`

**Interfaces:**
- Consumes: the app's sole external-link pattern (`AboutModal.tsx:103`): `<a href={url} target="_blank" rel="noreferrer" style={{ color: colors.accent }}>`.
- Produces: `links?: GuideLink[]` field on `GuideStep`; exported `BLOG_POSTS` const.

**The posts (exact URLs, use verbatim):**

```ts
export interface GuideLink { label: string; url: string }

export const BLOG_POSTS: GuideLink[] = [
  { label: 'Chunks and Chunkability: An Origin Story', url: 'https://element84.com/software-engineering/chunks-and-chunkability-an-origin-story/' },
  { label: 'Chunks and Chunkability: Tyranny of the Chunk', url: 'https://element84.com/software-engineering/chunks-and-chunkability-tyranny-of-the-chunk/' },
  { label: 'Beyond the Default: A Modern Guide to Raster Compression', url: 'https://element84.com/software-engineering/beyond-the-default-a-modern-guide-to-raster-compression/' },
  { label: 'Metadata Makes the Data: Format Metadata Storage and Representation Across Array Formats', url: 'https://element84.com/software-engineering/metadata-makes-the-data-format-metadata-storage-and-representation-across-array-formats/' },
  { label: 'Is Zarr the New COG?', url: 'https://element84.com/software-engineering/is-zarr-the-new-cog/' },
];
```

Use the posts' real titles as labels (verify each title by fetching the URL if network access is available; if a fetched title differs from the above, use the fetched one — do not invent "Part N" labels).

**Placement:**
- `intro` step: all five (`links: BLOG_POSTS`), introduced as further reading for the whole topic.
- `chunk` step: the two Chunks and Chunkability posts (reference `BLOG_POSTS` entries by slice/filter — do not duplicate the URL strings).
- `codecs` step: the raster-compression post.
- `metadata` step: the metadata post.
- About modal: a "Further reading" list of all five, placed after the GitHub link, same anchor styling, each link with `data-testid="about-blog-link-{i}"`.

- [ ] **Step 1: Write the failing unit test**: every entry in `BLOG_POSTS` has an `https://element84.com/` URL and non-empty label; the `chunk`, `codecs`, `metadata`, and `intro` steps have the expected `links` (assert by URL substring, e.g. `chunk` step's links include both `chunks-and-chunkability` URLs). Run `npx vitest run tests/unit/<file>` → FAIL.
- [ ] **Step 2: Implement**: type + data in `steps.ts`; in `GuidePanel.tsx` render a compact "Further reading" list after the step body using the anchor pattern above (each link `data-testid="guide-link-{i}"`); in `AboutModal.tsx` add the section.
- [ ] **Step 3: Run unit tests → PASS.** Typecheck/build must stay clean (`npx tsc --noEmit` or the project's lint/build command per package.json).
- [ ] **Step 4: Playwright spot-check** (throwaway script or manual via existing scenario style): open guide to the chunk step and the About modal; screenshot both; confirm links render and don't break the panel layout (long titles must wrap, not overflow).
- [ ] **Step 5: Update CLAUDE.md testid list** (`guide-link-{i}`, `about-blog-link-{i}`).
- [ ] **Step 6: Commit.** `git commit -m "feat: blog post links in guide steps and About modal"`

---

### Task 4: 2D smooth generator (value noise on trailing two dims)

**Files:**
- Modify: `src/engine/generate.ts` (`generateValues` ~line 147, `generateUniform01` ~line 233, the `'smooth'` case ~lines 237-246)
- Modify: `src/engine/pipelineCompute.ts` (pass `shape` at both `generateValues` call sites, lines ~107 and ~130)
- Test: the existing generate unit test file in `tests/unit/` (find it; extend it)

**Interfaces:**
- Consumes: existing seeded `rng` stream and `UPPER_BOUND` clamp semantics in `generate.ts`.
- Produces: `generateValues(variableName, logicalType, count, globalSeed, shape?: number[])` — new optional trailing param, so existing callers/tests stay valid. `generateUniform01(rng, mode, count, shape?)` likewise. Task 6 relies on smooth producing organic 2D fields for `[H, W]` shapes.

**Behavior spec:**
- `shape` absent or `shape.length < 2`: current 1D bounded random walk, byte-for-byte unchanged (existing tests must pass untouched).
- `shape.length >= 2` and mode `'smooth'`: value noise over the trailing two dims. With `H = shape[n-2]`, `W = shape[n-1]`, `slices = count / (H*W)`:

```ts
case 'smooth': {
  if (!shape || shape.length < 2) { /* existing 1D walk, unchanged */ break; }
  const W = shape[shape.length - 1];
  const H = shape[shape.length - 2];
  const sliceSize = H * W;
  const slices = sliceSize > 0 ? Math.floor(count / sliceSize) : 0;
  const CELL = 16; // lattice spacing in elements
  const gridW = Math.max(2, Math.ceil(W / CELL) + 1);
  const gridH = Math.max(2, Math.ceil(H / CELL) + 1);
  let base = 0;
  for (let s = 0; s < slices; s++) {
    // fresh lattice per slice: slices are independent, smooth within themselves
    const lattice = new Float64Array(gridH * gridW);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rng();
    for (let y = 0; y < H; y++) {
      const gy = Math.min(y / CELL, gridH - 1 - 1e-9);
      const y0 = Math.floor(gy), ty = gy - y0;
      for (let x = 0; x < W; x++) {
        const gx = Math.min(x / CELL, gridW - 1 - 1e-9);
        const x0 = Math.floor(gx), tx = gx - x0;
        const v00 = lattice[y0 * gridW + x0];
        const v01 = lattice[y0 * gridW + x0 + 1];
        const v10 = lattice[(y0 + 1) * gridW + x0];
        const v11 = lattice[(y0 + 1) * gridW + x0 + 1];
        const v = (v00 * (1 - tx) + v01 * tx) * (1 - ty)
                + (v10 * (1 - tx) + v11 * tx) * ty;
        out[base + y * W + x] = v * UPPER_BOUND;
      }
    }
    base += sliceSize;
  }
  // ponytail: any tail elements beyond slices*sliceSize (count not divisible
  // by H*W shouldn't happen — count is the shape product) fall back to rng()
  for (let i = base; i < count; i++) out[i] = rng() * UPPER_BOUND;
  break;
}
```

Adapt the snippet to the file's actual local names (`out`, `UPPER_BOUND`, bounds semantics — if the existing walk clamps to `[0, UPPER_BOUND]` where `UPPER_BOUND < 1`, keep the same output range). Determinism must hold: all randomness comes from the existing `rng` stream in a fixed draw order.

- [ ] **Step 1: Write failing tests** in the generate unit test file:
  - determinism: same `(variableName, globalSeed, shape)` → identical arrays across two calls;
  - 2D smoothness for shape `[64, 64]`: mean absolute adjacent difference along rows AND along columns each `< 0.05 * <output range>` (today the column direction fails — the 1D walk gives mean column diffs comparable to the walk's full drift across a row);
  - no row-seam artifact: values at `[y][0]` vs `[y-1][0]` (vertically adjacent) have small mean diff (covered by the column assertion);
  - range: all values within the existing smooth output bounds;
  - 3D shape `[3, 32, 32]`: each 32×32 slice internally smooth (column-diff assertion per slice), and at least two slices differ from each other;
  - 1D/`shape`-absent behavior unchanged: pin an exact expected array for a small count against the current implementation's output (generate it from the CURRENT code before changing anything).
- [ ] **Step 2: Run → new tests FAIL** (column smoothness), 1D pin PASSES.
- [ ] **Step 3: Implement** the value-noise branch and thread `shape` through `pipelineCompute.ts` (both call sites, lines ~107/~130 — `shape` is already in scope there). Grep for any other `generateValues(` callers and update them (optional param, so only callers that should pass shape need touching).
- [ ] **Step 4: Run the full unit suite → PASS** (`npx vitest run`).
- [ ] **Step 5: Visual sanity**: dev server + Playwright: array model, shape `[200, 200]`, a smooth variable, grid view — screenshot; the field must look like organic 2D blobs, no horizontal banding/seams.
- [ ] **Step 6: Commit.** `git commit -m "feat: smooth generator produces true 2D value noise on trailing dims"`

---

### Task 5: Dataset composition — generated variables alongside an active dataset

**Files:**
- Modify: `src/engine/pipelineCompute.ts` (`computeValuesStage`, lines ~101-132)
- Modify: `src/state/useAppState.ts` (`DATASET_LOCKED_ACTIONS` ~line 75; `UPDATE_VARIABLE` per-field lock ~lines 130-145)
- Modify: `src/types/state.ts` (or the most natural shared home): add `isDatasetVariable` helper
- Modify: `src/components/config/SchemaEditor.tsx` (lock UI becomes per-row)
- Modify: `tests/ui/scenario-dataset-presets.mjs` (lock-behavior assertions)
- Modify: `CLAUDE.md` (the `dataset-select` paragraph describing the schema lock — rewrite to match new semantics)
- Test: existing reducer tests + `computeValuesStage`/pipelineCompute tests in `tests/unit/` (find and extend)

**Interfaces:**
- Consumes: dataset-applied variable ids have the form `{datasetId}-{name}` (set by `buildDatasetApplication`, `src/datasets/apply.ts:44-73`); preset values arrive in compute as `Map<string, ValueArray>` keyed by variable NAME (`presetValues`); `generateValues` from Task 4 (pass `shape`).
- Produces: `isDatasetVariable(datasetId: string | null | undefined, variable: { id: string }): boolean` — single source of truth (`datasetId != null && variable.id.startsWith(datasetId + '-')`), used by reducer, SchemaEditor, and compute. Task 6's preset relies on: a state with an active dataset plus non-dataset variables computes cleanly (dataset vars get real values, others generate).

**Semantics (the "middle rung" — deliberately NOT full per-variable provenance):**
- Shape stays dataset-owned: `SET_SHAPE` remains locked while a dataset is active.
- `ADD_VARIABLE` and `REMOVE_VARIABLE` become allowed while a dataset is active (remove `DATASET_LOCKED_ACTIONS` entries; keep the mechanism for `SET_SHAPE`). Removing a dataset-backed variable is allowed (re-applying the dataset restores the full set).
- `UPDATE_VARIABLE`'s name/logicalType freeze applies only to dataset-backed variables (via `isDatasetVariable`); custom variables are fully editable. `typeAssignment`/`color` stay editable for everyone (unchanged).
- `computeValuesStage`: for each variable, if `isDatasetVariable(datasetId, v)` → `presetValues.get(v.name)` MUST exist with matching length, else throw (fail-loud stays, scoped per-variable); otherwise → `generateValues(...)` even when a dataset is active. Critical guard this buys: a custom variable the user names identically to a dataset variable must NOT be handed dataset values — binding is by id prefix, not name. `computeValuesStage` will need the active `datasetId` — thread it through the compute input alongside `presetValues` (check `src/worker/pipeline.worker.ts:21-35` / the compute request shape for where dataset id already flows).
- SchemaEditor: `add-variable` enabled while a dataset is active; per-row `disabled` on name/logicalType only for dataset-backed rows; remove buttons enabled on all rows; the shape inputs stay disabled; `dataset-attribution` line unchanged. Keep the existing hide-vs-disable idiom the component already uses for locked controls.

- [ ] **Step 1: Write failing unit tests:**
  - reducer: with `state.dataset` set — `ADD_VARIABLE` appends (currently no-ops), `REMOVE_VARIABLE` removes (currently no-ops), `SET_SHAPE` still no-ops, `UPDATE_VARIABLE` rename is rejected/ignored for a dataset-backed variable but applied for a custom one (currently ignored for both);
  - compute: `computeValuesStage` with `presetValues = Map{ 'sst' → data }`, datasetId `'sst-field'`, variables `[{id:'sst-field-sst', name:'sst',…}, {id:'var-custom', name:'noise',…}]` → sst gets the preset array, noise gets generated values of the right length (currently throws "not present in the loaded dataset");
  - hijack guard: custom variable `{id:'var-custom', name:'sst'}` alongside the real one does NOT receive the preset array (its values differ from `presetValues.get('sst')`);
  - fail-loud retained: dataset-backed variable whose name is missing from the map still throws.
- [ ] **Step 2: Run → FAIL** for the new behaviors.
- [ ] **Step 3: Implement** (helper, reducer, compute, then SchemaEditor). Delete or rewrite the all-or-nothing comment at `pipelineCompute.ts:112-115` to state the new per-variable contract.
- [ ] **Step 4: Full unit suite → PASS.**
- [ ] **Step 5: Update `tests/ui/scenario-dataset-presets.mjs`:** find the existing lock assertions (add/remove/rename disabled while dataset active) and flip them to the new contract; add a check that adds a custom variable while a dataset is active and waits for the pipeline to settle without error (reuse the file's existing settle/idle helpers). Run the scenario → all PASS.
- [ ] **Step 6: Rewrite the CLAUDE.md `dataset-select` lock paragraph** to match (shape locked; add/remove allowed; name/logicalType locked only on dataset-backed rows; values bound by id prefix, not name).
- [ ] **Step 7: Commit.** `git commit -m "feat: compose generated variables alongside an active dataset"`

---

### Task 6: GeoTIFFesque preset — multi-band, row-interleaved, binary metadata

**Files:**
- Modify: `src/presets/geotiffesque.json` (via the preset regeneration flow if `scripts/` has one — check first; hand-edit only if none exists)
- Modify: `tests/ui/scenario-dataset-presets.mjs` (GeoTIFFesque expectations)

**Interfaces:**
- Consumes: Task 4 (2D smooth) and Task 5 (dataset+generated composition — the preset will contain both kinds of variables). Existing binary metadata serializer (`serializeMetadataBinary`, `src/engine/metadata.ts:223-257`) — no new serialization code. `deserializeMetadata` auto-detects binary (first byte ≠ `{`).
- Produces: the reworked preset; no code interfaces.

**Preset changes (GeoTIFFesque only — Zarrish, Parquet-adjacent, Avro-esque untouched):**
- `metadata.serialization`: `"json"` → `"binary"` (TIFF metadata is binary; this exercises the existing generic length-prefixed format — an IFD-realistic serialization is explicitly out of scope).
- `interleaving`: → `"row"` (pixel-interleaved, i.e. TIFF `PlanarConfiguration=1`, the TIFF default — this is what makes interleaving demonstrable, and it's the authentic GeoTIFF story; band-interleaved `column` is the toggle users can flip to see the difference).
- Variables: keep the dataset-backed `elevation` unchanged; add TWO generated variables, e.g. `slope` and `hillshade` (float logical type whose generator mode is `smooth` — check how logicalType maps to generator mode in `src/engine/generate.ts` and pick the one that yields `smooth`), with ids that do NOT carry the dataset-id prefix (e.g. `gen-slope`, `gen-hillshade` — they must generate, not bind to the dataset), distinct palette colors, and a `typeAssignment` mirroring elevation's pattern (or plain float32 storage if elevation's scale/offset doesn't transfer sensibly).
- `fieldPipelines`: entries for the new ids (empty arrays are fine — with `row` interleaving the chunk-level pipeline governs). Keep the existing chunk pipeline (deflate) as-is.
- Any other AppState fields the preset snapshot format requires for new variables (check against another preset's variable entries for the full required key set).

- [ ] **Step 1: Update scenario expectations first** in `scenario-dataset-presets.mjs`: GeoTIFFesque now has 3 variables (assert the two generated names present), metadata serialization binary (assert however the scenario currently verifies serialization — if it doesn't, assert the round-trip/read still completes, which is the load-bearing check), read round-trip still green. Run → FAIL (preset not yet changed).
- [ ] **Step 2: Rework the preset** per spec (regeneration flow if available).
- [ ] **Step 3: Run `node tests/ui/scenario-dataset-presets.mjs` → all PASS.** This is the critical gate: the preset uses a Pyodide codec, so its round-trip is browser-validated here, not in vitest. Also visually screenshot: load GeoTIFFesque, grid view per band (smooth bands must look organic per Task 4), and hex view showing row-interleaved chunk bytes.
- [ ] **Step 4: Run full unit suite** (presets are imported by unit tests in places — e.g. preset-shape validation tests must still pass; regenerate/fix as needed).
- [ ] **Step 5: Commit.** `git commit -m "feat!: GeoTIFFesque preset — three bands, pixel-interleaved, binary metadata"`

---

### Task 7: Guide content accuracy review + revision

**Files:**
- Modify: `src/components/guide/steps.ts` (content revisions)
- Modify: `docs/design.md` (only where steps.ts mirrors it and both are stale — steps.ts:1-8 declares the sync obligation)
- Test: existing guide unit tests must stay green; typecheck clean

**Interfaces:**
- Consumes: everything — this task audits prose against the live app. Recent behavior changes the guide may not reflect: linearization (C/Fortran/Morton) + byte-order controls (CL project), granular metadata include toggles + narrated 8-step read process (R project), Pyodide-backed real codecs (deflate/zstd/lz4...) (P4 project), dataset presets + format presets split (DP project), dataset composition semantics JUST changed in Task 5 (add/remove now allowed while a dataset is active; only dataset-backed rows are name-locked), GeoTIFFesque is now 3-band/row-interleaved/binary-metadata per Task 6.
- Produces: accurate guide content; a written list of every divergence found (in the task report).

- [ ] **Step 1: Audit.** For each of the 10 steps in `steps.ts` (`intro`, `schema`, `chunk`, `interleave`, `typing`, `codecs`, `metadata`, `write`, `read`, `wrap-up`): read the step's `decision`/`options`/`body`/`tryIt`, then verify every factual claim against the current source (control names and locations, option lists, behaviors, defaults, preset names/contents). `tryIt` instructions must be executable against today's UI — verify control labels/sections exist (grep for the testids/labels referenced). Record each divergence.
- [ ] **Step 2: Revise** `steps.ts` content to match reality (tone and structure preserved; this is a correctness pass, not a rewrite). Where `docs/design.md` is the stale source being mirrored, fix it too.
- [ ] **Step 3: Verify.** `npx vitest run` (guide tests + steps structure tests) green; `npx tsc --noEmit` (or project lint command) clean. Playwright: step through the full guide in the browser (next through all 10 steps), screenshot each, confirm rendering (including Task 3's links) and no layout breakage.
- [ ] **Step 4: Commit.** `git commit -m "docs: guide content accuracy pass against current implementation"`
