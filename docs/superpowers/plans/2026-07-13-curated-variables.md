# Curated Variables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the schema-wide dataset mechanism with per-variable curated sources: `Variable.source` refs, tile/crop value fill, a per-row source dropdown, preset-carried provenance, and deletion of the dataset state/lock/seeding machinery.

**Architecture:** Per the approved spec `docs/superpowers/specs/2026-07-13-curated-variables-design.md`. Two additive tasks land the pure engine fill and the static curated catalog first; one large atomic task performs the swap (state, worker, compute, UI, presets) because deleting `state.dataset` cascades through every layer within a single tsc compile unit (the pre-commit hook runs `tsc -b`); a final task reworks the Playwright scenario and docs.

**Tech Stack:** React + TypeScript + Vite, vitest (`tests/unit/`), Playwright scenarios (`tests/ui/scenario-*.mjs`), Pyodide codecs (browser-validated preset round-trips).

## Global Constraints

- The spec (`docs/superpowers/specs/2026-07-13-curated-variables-design.md`) is the contract; where this plan and the spec disagree, the spec governs.
- `Variable.source?: { datasetId: DatasetId; variableName: string }` — absent = custom/generated. Binding is by this ref ONLY; never by variable name or id prefix.
- Tile/crop rule (one code path): `value(coords) = source[coords % naturalShape]` per dimension, aligned from the trailing dims; extra leading schema dims broadcast; when the schema has fewer dims than the source, unmatched leading source dims are fixed at 0.
- No locks except: a curated row's `logicalType` (including generation mode) is manifest-owned and locked; name, color, typeAssignment, codecs, shape, add/remove are always editable.
- Provenance is preset-carried only (ordinary `metadata.customEntries` baked by `scripts/gen-presets.ts`); the app derives/seeds/removes nothing.
- Deleted outright: `state.dataset`, `seededEntries`, `DATASET_LOCKED_ACTIONS`, `APPLY_DATASET`, `SET_DATASET_CUSTOM`, `isDatasetVariable`, `buildDatasetApplication`, the Schema dataset picker (testids `dataset-select`, `dataset-attribution`, `dataset-loading`, `dataset-error`).
- Every commit must compile (pre-commit runs eslint + `tsc -b`) and pass `npx vitest run` in full.
- Engine work is tested before dependent UI (unit tests in `tests/unit/`); scenarios seed localStorage only via `seedStateAndReload` (`tests/ui/scenario-helpers.mjs`); dev server `npm run dev` → `http://localhost:5173/0x00c0dec5/` (dataset files served by the vite data-dev middleware from `data-branch-work/` then `tests/fixtures/`).
- Styling: inline styles from `src/theme.ts`; new testids follow CLAUDE.md conventions and CLAUDE.md is updated in the same task that changes them. No new dependencies.
- Commit per task, conventional-commit style.

---

### Task 1: `fillFromSource` — pure tile/crop engine fill

**Files:**
- Create: `src/engine/sourceFill.ts`
- Test: `tests/unit/engine/sourceFill.test.ts`

**Interfaces:**
- Consumes: `ValueArray` (`Float64Array` for numeric, `string[]` for text — see `src/engine` value types).
- Produces: `fillFromSource(source: ValueArray, naturalShape: number[], shape: number[]): ValueArray` — later tasks call this from `computeValuesStage`. Output length = product of `shape`; output kind (numeric/text) matches `source`.

**Algorithm (the spec's modulo rule, row-major):**

```ts
import type { ValueArray } from './values'; // adapt to the real ValueArray home

export function fillFromSource(
  source: ValueArray,
  naturalShape: number[],
  shape: number[],
): ValueArray {
  const total = shape.reduce((a, b) => a * b, 1);
  const srcTotal = naturalShape.reduce((a, b) => a * b, 1);
  if (srcTotal !== source.length) {
    throw new Error(
      `fillFromSource: source length ${source.length} != natural shape product ${srcTotal}`,
    );
  }
  const out: ValueArray =
    typeof (source as unknown[])[0] === 'string' || Array.isArray(source)
      ? new Array<string>(total)
      : new Float64Array(total);
  if (total === 0 || srcTotal === 0) return out; // degenerate: empty but valid

  // Align trailing dims: schema dim (shape.length-1-k) maps to source dim
  // (naturalShape.length-1-k); unmatched leading schema dims broadcast (repeat);
  // unmatched leading source dims are fixed at index 0.
  const sStrides = strides(naturalShape); // row-major strides
  for (let flat = 0; flat < total; flat++) {
    let rem = flat;
    let srcIndex = 0;
    for (let d = shape.length - 1, k = 0; d >= 0; d--, k++) {
      const dim = shape[d];
      const coord = rem % dim;
      rem = Math.floor(rem / dim);
      const sd = naturalShape.length - 1 - k;
      if (sd >= 0) srcIndex += (coord % naturalShape[sd]) * sStrides[sd];
      // sd < 0: broadcast — leading schema dim contributes nothing
    }
    (out as unknown[])[flat] = (source as unknown[])[srcIndex];
  }
  return out;
}

function strides(shape: number[]): number[] {
  const s = new Array<number>(shape.length);
  let acc = 1;
  for (let d = shape.length - 1; d >= 0; d--) { s[d] = acc; acc *= shape[d]; }
  return s;
}
```

Adapt typing to the codebase's actual `ValueArray` definition (`Float64Array | string[]`) — the text branch should preserve `string[]`, numeric should return `Float64Array` (writing via typed-array indexing, not the `unknown[]` cast shown, if cleaner). The inner loop walks flat indices without allocating coord arrays — keep it allocation-free per element (this runs on up to 8M elements in the worker).

- [ ] **Step 1: Write failing tests** covering, with small handmade fixtures where expected outputs are written out literally:
  - exact fit: source `[1,2,3,4]` shape `[2,2]` → schema `[2,2]` returns the same values;
  - crop: source 4×4 (values 0..15), schema `[2,2]` → `[0,1,4,5]`;
  - tile 1-D: source `[7,8,9]` shape `[3]`, schema `[7]` → `[7,8,9,7,8,9,7]`;
  - tile 2-D: source 2×2 `[a,b,c,d]`, schema `[3,3]` → `[a,b,a, c,d,c, a,b,a]`;
  - broadcast leading dim: source 2×2, schema `[2,2,2]` → the 2×2 block twice;
  - fewer schema dims: source 2×3 (values 0..5), schema `[2]` → `[0,1]` (row 0);
  - text values: source `['x','y']` shape `[2]`, schema `[5]` → `['x','y','x','y','x']` and result is a plain array of strings;
  - degenerate: schema with a zero dim → empty output, no throw;
  - length-mismatch guard: source length ≠ naturalShape product → throws.
- [ ] **Step 2: Run → FAIL** (module missing): `npx vitest run tests/unit/engine/sourceFill.test.ts`.
- [ ] **Step 3: Implement**, **Step 4: focused tests PASS**, then full `npx vitest run` PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: fillFromSource tile/crop engine fill for curated variables"`

---

### Task 2: `Variable.source` type + static curated-variable catalog

**Files:**
- Modify: `src/types/state.ts` (add optional `source` field to `Variable`; do NOT delete anything yet)
- Modify: `src/datasets/registry.ts` (curated catalog)
- Test: `tests/unit/datasets/catalog.test.ts` (create)

**Interfaces:**
- Consumes: `DatasetId`, `LogicalTypeConfig`, `NumericBinDtype` from `src/datasets/types.ts` / `src/types/state.ts`; the fixture manifests in `tests/fixtures/datasets/*/manifest.json`.
- Produces (used verbatim by Tasks 3–4):

```ts
// src/types/state.ts
export interface VariableSource { datasetId: DatasetId; variableName: string }
export interface Variable { /* existing fields */; source?: VariableSource }

// src/datasets/registry.ts
export interface CuratedVariable {
  datasetId: DatasetId;
  name: string;              // manifest variable name
  label: string;             // dropdown label, e.g. 'GHCN Daily › tmax'
  dataModel: AppState['dataModel'];
  kind: 'number' | 'string';
  dtype?: NumericBinDtype;   // numeric only — natural storage dtype
  logicalType: LogicalTypeConfig; // static copy of the manifest's
  attribution: string;       // short dataset-level attribution line for the row hint
}
export const CURATED_VARIABLES: CuratedVariable[];
export function curatedVariable(ref: VariableSource): CuratedVariable | undefined;
```

**Why a static catalog:** the per-row dropdown and the reducer need variable names, logicalTypes, and natural dtypes *synchronously*; manifests are async-fetched. The catalog is a small static copy (7 variables across 3 datasets: etopo-dem/elevation; sst-field/sst; ghcn-daily/date,tmax,tmin,prcp,station). The manifest stays the source of truth for the DATA; the catalog is pinned against the fixture manifests by test so it cannot drift silently. Copy each variable's `logicalType`, `kind`, and numeric `dtype` from `tests/fixtures/datasets/{id}/manifest.json` exactly; `attribution` is a short human line derived from the manifest's `attribution.source` (e.g. "NOAA ETOPO 2022").

- [ ] **Step 1: Write failing test** (`tests/unit/datasets/catalog.test.ts`): for each fixture manifest under `tests/fixtures/datasets/*/manifest.json`, every manifest variable appears in `CURATED_VARIABLES` with identical `name`, `kind`, `dtype` (numeric), and deep-equal `logicalType`; every catalog entry's `dataModel` matches its dataset's registry `dataModel`; `curatedVariable({datasetId, variableName})` resolves each and returns `undefined` for unknown refs. Run → FAIL.
- [ ] **Step 2: Implement** the type + catalog. `Variable.source` is additive — nothing else changes behavior yet.
- [ ] **Step 3: Full `npx vitest run` PASS** (the presets round-trip test must be unaffected — `source` is optional and absent everywhere today).
- [ ] **Step 4: Commit.** `git commit -m "feat: Variable.source type + static curated-variable catalog"`

---

### Task 3: The swap — per-variable sources through state, worker, compute, and Schema UI

This is deliberately one atomic task: deleting `state.dataset` breaks every consumer in the same tsc compile unit, so the reducer/persistence, worker/compute, provider/SchemaEditor, and preset regeneration must land in one commit. It is the big task of this plan.

**Files:**
- Modify: `src/types/state.ts` (DELETE `dataset` field from AppState + `isDatasetVariable`; keep `VariableSource`)
- Modify: `src/state/useAppState.ts` (delete `DATASET_LOCKED_ACTIONS`, `APPLY_DATASET`, `SET_DATASET_CUSTOM` cases, `applyDataset`/`selectCustomDataset` provider callbacks and their context fields; new UPDATE_VARIABLE source semantics)
- Modify: `src/state/persistence.ts` (migration + validation)
- Modify: `src/datasets/apply.ts` (delete `buildDatasetApplication`; delete the file if nothing else remains)
- Modify: `src/datasets/assets.ts` (add per-variable fetch)
- Modify: `src/worker/pipeline.worker.ts` (per-ref cache)
- Modify: `src/engine/pipelineCompute.ts` (`computeValuesStage` + memo + computer guard)
- Modify: `src/components/config/SchemaEditor.tsx` (+ its container/parent wiring) — per-row source select, dataset picker removed
- Modify: `scripts/gen-presets.ts` + regenerate all four `src/presets/*.json`
- Tests: update `tests/unit/state/presets.test.ts`, reducer/persistence/compute test files (locate the existing ones covering UPDATE_VARIABLE locks, `computeValuesStage` dataset values, and `migrateState`), plus new migration fixture test

**Interfaces:**
- Consumes: `fillFromSource` (Task 1), `CURATED_VARIABLES`/`curatedVariable`/`VariableSource` (Task 2), existing `loadManifest`/`datasetById` (registry), `decodeNumericBin`/`decodeStringColumn` internals of `fetchDatasetValues`.
- Produces: the final architecture; Task 4 relies on all behavior below being live.

**3a — Reducer/state semantics:**
- `UPDATE_VARIABLE` gains source handling: when an update sets `source` to a ref, the reducer also sets that row's `logicalType` (deep copy from `curatedVariable(ref).logicalType`) and defaults `typeAssignment` from the catalog's natural dtype (numeric → `{ storageDtype: dtype }`-shaped assignment exactly as `buildDatasetApplication` did; string → the same `char16` default it used). When an update clears `source` (sets it undefined/null), the row keeps its current `logicalType` and becomes fully editable.
- While `v.source` is set, `UPDATE_VARIABLE` ignores `logicalType` changes for that row (single enforcement point in the reducer, mirroring the old per-field freeze — but scoped to logicalType only; name is now freely editable).
- `SET_SHAPE`, `ADD_VARIABLE`, `REMOVE_VARIABLE` have no dataset conditions left at all. `ADD_VARIABLE` mints custom rows exactly as today (`var_${Date.now()}` — unchanged).
- Delete `DATASET_LOCKED_ACTIONS` and both dataset action cases; remove the actions from the `AppAction` union.

**3b — Persistence:**
- `migrateState`: detect `raw.dataset` (old shape). For each raw variable whose `id` starts with `${raw.dataset.id}-`, set `source = { datasetId: raw.dataset.id, variableName: variable.name }`. Then delete `raw.dataset`. Seeded metadata entries need no handling (they already live in `customEntries`).
- `validateState`: delete the dataset-degradation branch; add `source` validation — a variable's `source` is dropped (row degrades to custom, keep everything else) unless `curatedVariable(source)` resolves AND its `dataModel` matches `state.dataModel`. `isValidVariable` must accept the optional `source` object shape.
- Migration fixture test: build a raw pre-change state literal (variables with `etopo-dem-elevation`-style ids + `dataset: {id:'etopo-dem', attribution:'…', seededEntries:[…]}`), run it through `loadFromRaw`/the public load path, assert: the prefixed variable gained the right `source`, `dataset` is gone from the result, custom variables untouched, `customEntries` preserved verbatim.

**3c — Fetch/worker:**
- `src/datasets/assets.ts`: add `fetchDatasetVariable(manifest, variableName, urlFor, fetchFn?) → Promise<ValueArray>` by extracting the per-variable branch of `fetchDatasetValues` (numeric bin / dict+codes). Keep `fetchDatasetValues` only if something still uses it (scripts/tests) — otherwise delete it; check callers.
- `src/worker/pipeline.worker.ts`: replace `datasetValuesCache` with `sourceValuesCache = Map<string, Promise<{ values: ValueArray; naturalShape: number[] }>>` keyed `${datasetId}/${variableName}`. On each compute request: collect the distinct `source` refs from `msg.state.variables`, ensure each is cached (manifest via existing promise-cached `loadManifest`; `naturalShape` = `manifest.shape`), build `sourceValues: Map<string, {values, naturalShape}>` with the same keys, pass to compute. Evict a cache entry on fetch failure (same pattern as today, line ~34). Preserve the existing copy-on-injection discipline: `computeValuesStage` must go on `.slice()`ing numeric arrays before storing so worker cache buffers are never aliased into transferable results (the DP-4 Critical — keep the existing comment and the real-detach regression test passing).
- `computeDelta`/`createPipelineComputer`/`computePipelineStages` signatures: `presetValues?: Map<string, ValueArray>` → `sourceValues?: Map<string, { values: ValueArray; naturalShape: number[] }>`. Delete the `state.dataset && !presetValues` guard; the per-variable throw below is the guard.

**3d — Compute:**
- `computeValuesStage(shape, variables, byteOrder, sourceValues?)` (datasetId param deleted): for each variable, if `v.source` — look up `sourceValues.get(`${v.source.datasetId}/${v.source.variableName}`)`; missing → throw (fail-loud, name the variable and ref); present → integrity-check `values.length === product(naturalShape)` (throw on mismatch) then `fillFromSource(values, naturalShape, shape)` (plus the existing `.slice()`/copy discipline for numeric outputs). No `v.source` → `generateValues(...)` exactly as today.
- Values memo deps: drop `datasetId` (the `variables` object already carries `source` refs, so ref changes bust the memo; values content was never keyed, unchanged).
- Compute tests: update the existing `computeValuesStage` dataset tests to the ref-keyed map: mixing (curated + custom row), fail-loud missing ref, integrity mismatch, and a tile case (schema larger than naturalShape → values repeat; assert a couple of modulo positions) proving `fillFromSource` is actually wired in.

**3e — Schema UI:**
- Remove the dataset picker block (`dataset-select` / `dataset-loading` / `dataset-error` / `dataset-attribution`) and the `dataset`/`datasetOptions`/`datasetStatus`/`onSelectDataset` props; fix the container that supplied them; remove the provider's `applyDataset`/`selectCustomDataset` and their `AppStateContextValue` fields (and the custom-preset-slot snapshot call inside `applyDataset` — preset loading keeps its own separate snapshot mechanics untouched).
- Each variable row gains a source `<select data-testid={`variable-source-${varIdx}`}>`: first option `Custom (generated)` (value `custom`), then `CURATED_VARIABLES` filtered to the active data model, grouped by dataset (use `<optgroup label={dataset label}>`), option value `${datasetId}/${name}`, option text the catalog `label`. Selecting dispatches UPDATE_VARIABLE with the source ref (or clearing it for `custom`).
- While a row has a source: render a small attribution hint line `data-testid={`variable-source-attribution-${varIdx}`}` showing the catalog `attribution` (tertiary text, purely informational); disable the logicalType select, wordset/min/max/decimalPlaces/sigfigs inputs, and generation-mode select (the same controls `rowLocked` disables today — reuse that disabled wiring but drive it from `Boolean(v.source)`); name input, color, remove stay enabled.
- `shape-input*` and Dim +/- buttons: remove `datasetLocked` gating entirely (always enabled/rendered).

**3f — Presets:**
- `scripts/gen-presets.ts`: delete the `*_DATASET` consts/`seededEntries`; dataset-backed variable entries get `source: { datasetId, variableName }` (ids can stay as-is — they're meaningless now); provenance entries move to plain `metadata.customEntries` literals per preset (same key/value strings as before). Delete any `dataset:` field from the generated AppState. Regenerate all four presets (`npx tsx scripts/gen-presets.ts`); `assertReads` inside the script must still pass (it computes the pipeline — needs `sourceValues` supplied the same way the worker builds it; the script already loads fixture data for that, adapt its plumbing).
- `tests/unit/state/presets.test.ts`: drop assertions (b) dataset-ref/seeded-entries and the (f) deselect-dataset flow; add: each dataset-backed preset variable carries the expected `source` ref; provenance keys present in `customEntries`; round-trip deep-equal still holds (this catches any stray `dataset` field left in a JSON).

- [ ] **Step 1 (TDD):** write/adjust the failing tests first across 3a/3b/3d/3f (reducer source semantics + logicalType freeze scoping, migration fixture, compute ref-map behaviors incl. tile-wired-in, presets source refs). Run → confirm the specific new-behavior failures.
- [ ] **Step 2:** implement 3a→3f (suggested order: types deletion last within the editing pass so intermediate greps still find consumers; commit only at the end).
- [ ] **Step 3:** `npx vitest run` full → PASS; `npx tsc -b` clean (hook will enforce).
- [ ] **Step 4:** manual smoke via dev server + Playwright: seed a state, set a row's source to `sst-field/sst` at shape `[200,200]`, confirm real values render in grid view and shape edits (e.g. `[2048,2048]`) recompute without error (tiling); load each of the four presets and confirm `read-status` success. (The standing scenario rework is Task 4 — this step is a smoke check, screenshots in the report.)
- [ ] **Step 5: Commit.** `git commit -m "feat!: per-variable curated sources replace the schema-wide dataset mechanism"`

---

### Task 4: Scenario rework + docs

**Files:**
- Modify: `tests/ui/scenario-dataset-presets.mjs` (rename to `scenario-curated-variables.mjs`)
- Modify: `CLAUDE.md` (testid list + the dataset paragraph at ~line 206 + the `variable-color-{index}` lock note at ~line 196 + scenario list name)
- Check (likely no-op): `src/components/guide/steps.ts` (grep found zero dataset mentions; verify the wrap-up step's preset claims still hold — presets' user-visible behavior is unchanged)

**Interfaces:** consumes everything Task 3 shipped; produces the standing regression coverage and accurate docs.

**Scenario rework (keep the existing check-group structure and helpers):**
1. Ad-hoc curated pick (replaces old picker checks 1/3): fresh tabular state → set a row's `variable-source-{i}` to `ghcn-daily/tmax` → attribution hint appears, logicalType select disabled, name input STILL ENABLED, shape inputs STILL ENABLED; table shows real values; read succeeds. Then back to `custom` → hint gone, logicalType re-enabled, pipeline recomputes with generated values.
2. Tile/crop behavior (new): array model, source `sst-field/sst`; at shape `[200,200]` read succeeds (crop); set shape `[1100,1100]` (larger than 1024 → tiles) — pipeline settles, read succeeds, no pageerror.
3. Persistence: seeded state with a source ref survives reload; worker refetches; values still real.
4. Failure path (replaces old check 6): block the manifest/data fetch route → pipeline surfaces an error (the existing worker-error surface — assert whatever the app shows today for a failed compute, e.g. the stale/error indicator), and recovery works after unblocking (trigger a recompute).
5. All four format presets load from `preset-select`, each reads successfully, GeoTIFFesque still shows 3 variables and Encoded < Typed (carry these checks over from old groups 2/7 largely as-is; drop all `dataset-select`/`dataset-attribution` assertions).
6. Zero pageerrors overall (keep).

**CLAUDE.md:** rewrite the dataset paragraph around: `variable-source-{index}` / `variable-source-attribution-{index}`, the catalog (`CURATED_VARIABLES`), ref-binding + tile/crop rule, per-row logicalType lock, preset-carried provenance, deleted testids/actions, and the migration note. Update the scenario filename in the run list. Fix the `variable-color-{index}` note ("even when the dataset lock disables name/logicalType" → reflect per-row source lock, name no longer locked).

- [ ] **Step 1:** rework the scenario; run against the dev server until all checks PASS (`node tests/ui/scenario-curated-variables.mjs`).
- [ ] **Step 2:** sweep: `npx vitest run` full + run the OTHER scenario files that touch schema/presets (`scenario-crash-inputs.mjs`, `scenario-placement-matrix.mjs`, `scenario-real-codecs.mjs`, `scenario-worker-pipeline.mjs`) to catch collateral breakage; fix anything found (root cause, not scenario patching — if an app bug surfaces, report it).
- [ ] **Step 3:** CLAUDE.md + guide check per above.
- [ ] **Step 4: Commit.** `git commit -m "test+docs: curated-variables scenario and doc rework"`
