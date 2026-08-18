# Overhaul Plan

## Status log

- **2026-08-17 — EXECUTED.** All phases complete via the agent fix loop (Part 5 protocol). Every work item P1.1–P6.4 plus F31 (codec enable toggle) and F32 (GridCanvas transparent draw) landed and verified: final evaluation green across `npx tsc -b`, 1200/1200 unit tests, and all 13 harness scenarios (plus flatview-stages/theme-toggle/guide/codec-warnings/presets). Four fixer agents (P3.4, P4.1, P4.2, P5.2) completed their work but died before reporting — each was verified after the fact (F32's paint fix confirmed by in-browser pixel check on both preset families). P2.4/F19 needed no change: P2.1–P2.3's banner already covered it. Notable follow-through during execution: P1.2's re-keying had an unlisted consumer (`metadata.ts` wrote stats keyed by id into the name-oriented file format) — fixed at the serialization boundary; this validated the escalate-don't-expand rule and the checker re-grep requirement now baked into F31's spec.

Status: audit deliverable, 2026-08-17. This is the document to drive an agent fix-loop from. It is self-contained: Part 3 is the finding inventory, Part 4 is the ordered execution plan with verification gates, Part 5 is the loop protocol. Severity labels reflect adversarial verification (some seed-audit "high" labels were downgraded by the verifier — the adjusted severity is what's used here).

---

## Part 0 — Verdict: is the foundation sound?

**Yes. The foundation is the right shape to iterate on. Nothing structural needs a rewrite before fixes can land.** The core architectural bet this app makes is correct and holds up under adversarial reading: one-way state flow (external loads → `REPLACE_STATE` → reducer → worker → stamped `PipelineResult` → context → views), a pure engine layer with no UI/state imports, and layout-driven tracing (every cross-pane hover resolves through O(regions) `traceAt`/`byteRangesForTrace` binary search, not materialized per-element arrays). The audit found **no state cycles** — nothing feeds worker output back into dispatch — and **no genuine global-access violations**: every module-level singleton (`manifestCache`, `sourceValuesCache`, `permutationCache`, Pyodide's `initPromise`) is a correctly-scoped, promise-cached, evict-on-failure cache with a sane lifetime, one of them explicitly capped. That is the load-bearing good news: the tree is a tree, and the fixes below are leaf edits, not surgery on the trunk.

The one architectural pattern that is genuinely broken — and it recurs, so it is worth naming as a class rather than a bug list — is **the stale-view snapshot discipline being applied inconsistently.** `App.tsx` correctly established the rule that while a newer edit is computing, panes must render from `result.computedFrom` (the config snapshot the shown result was actually computed from), not live `state`, because live state can describe bytes that don't exist yet. `StagePane` follows this. But two consumers — `PipelineStrip`'s Encoded-stage warning icon and `TypeAssignConfig`'s per-row lossy stats — zip *live* `AppState.variables` against the *stale* pipeline output, reintroducing exactly the drift `computedFrom` was built to kill, one layer up. `TypeAssignConfig` compounds it by looking up stats **by variable name** against a map that should have been keyed by the stable `Variable.id` everything else uses. These are the "structural" fixes: not because they crash, but because the same mistake will keep getting made until `computedFrom` carries everything a result-derived view needs and stats are id-keyed like the rest of the state model.

The second theme is **failure and hang invisibility**, which matters disproportionately because this is a live-demo/conference tool. After the first successful compute, a later `ok:false` or an indefinitely-wedged compute is invisible everywhere except the About modal, which nobody opens mid-talk. The watchdog deliberately leaves an in-flight-with-nothing-queued compute alone forever. Neither is a correctness bug; both are the exact "fragile and confusing in the corners" symptom the owner reported, and both have near-zero-risk fixes reusing machinery that already exists (`lastError` is already tracked and cleared; `handleCrash` already has the repost-in-flight fallback).

The third theme is **viewers that scale by dataset size instead of by layout-region count**, which breaks at the 144K–1M element scale the shipped FORMAT presets actually use — GridCanvas renders a sub-pixel-tall strip for 1D presets, FlatView hands the virtualizer an unbounded row count past the browser's scroll-height cap, TableView's chunk-hover fallback is an O(rows×cols) scan that visibly freezes on drag. These are reachable in one click on the flagship presets. None of them is architectural; each is a bounded viewer fix. **Net: iterate in place. Fix the snapshot-discipline class first (Phase 1) so later fixes don't have to reason around a moving target, then work the severity list.**

---

## Part 1 — Data-flow map

### Current tree (verbatim from audit)

```
localStorage (0x00c0dec5-state-{tabular,array}, -active-model, -checkpoint, -preset-custom-{model}, -ui-prefs)
share URL hash (#s=...)
built-in preset JSON (src/presets/*.json)
        │
        ▼  (getInitialState / switchDataModel / loadPreset / restoreCheckpoint / clearConfig — src/state/useAppState.ts)
   AppState  ◄──────────────── sidebar config editors dispatch (SchemaEditor, ChunkConfig,
        │                       CodecPipelineEditor/CodecSection, MetadataEditor, WriteConfig,
        │                       TypeAssignConfig — all read live `state`, write via dispatch)
        │  useReducer + debounced saveState (500ms) + pagehide flush
        │
        ├──► saveState/saveCustomPreset/saveCheckpoint (localStorage)   [one-way, no read-back mid-render]
        │
        ▼  useWorkerPipeline (src/hooks/useWorkerPipeline.ts) — deps: pipeline-relevant slices only
   PipelineWorkerClient (src/worker/client.ts) — latest-wins coalescing, watchdog, respawn
        │  postMessage(state, knownKeys)
        ▼
   pipeline.worker.ts ── resolveSourceValues (sourceValuesCache, worker-lifetime Map)
        │                 ── loadManifest (registry.ts manifestCache, promise-cached)
        │                 ── initPyodideRuntime (pyodideRuntime.ts module singleton)
        ▼
   createPipelineComputer() (src/engine/pipelineCompute.ts) — per-stage memoized compute
        │  values → typed → linearized → encoded → metadata → write → read
        ▼
   PipelineDelta (stage payloads, transferred/detached) ──► applyDelta merges into
   PipelineWorkerClient.payloads ──► assemblePipelineResult ──► PipelineResult
        │  .computedFrom = { shape, chunkShape, variables, interleaving }  (stamped in client.ts)
        ▼
   App.tsx: result (stale-view) ──► viewConfig = result.computedFrom ?? live state
        │
        ├──► StagePane (left/right): variables/shape/chunkShape/interleaving from viewConfig (correct)
        │       └─► HexView/FlatView/TableView/GridView/ReadProcessView — all via stageSources/layout (O(1)/O(log n) traceAt)
        │
        ├──► PipelineProvider → PipelineContext (stages/files/readResult/variableStats/
        │       logicalValues/typedValues/stageSources/originalValues/computing/runtimeStatus)
        │       ├─► HoverBar — stages+stageSources only (self-consistent)
        │       ├─► FileExplorer — files only (self-consistent)
        │       ├─► Sidebar Read/Write sections — readResult/files (self-consistent, live state used only for config)
        │       ├─► PipelineStripConnected — stages/readResult/variableStats FROM CONTEXT (stale)
        │       │       + variables/fieldPipelines/chunkPipeline/interleaving FROM LIVE state.* (App.tsx props)
        │       │       ⚠ mismatched snapshot (finding F1)
        │       └─► TypeAssignConfig — variables FROM LIVE state.variables (Sidebar)
        │               + variableStats FROM CONTEXT (stale), keyed by v.name
        │               ⚠ mismatched snapshot + name-keying (finding F2)
        │
        └──► GuideContext (src/state/GuideContext.tsx) — fully separate side channel,
                localStorage ui-prefs only, never touches AppState/PipelineContext (no cycle)

ErrorBoundary.tsx — hardcodes RESET_STORAGE_KEYS = ['0x00c0dec5-state-tabular','0x00c0dec5-state-array'],
   a second copy of persistence.ts's STORAGE_KEYS (drift risk, not yet diverged)
```

### Violations found

| # | Kind | Location | Note |
|---|------|----------|------|
| 1 | Snapshot mismatch | `App.tsx:173-178` → `PipelineStrip.tsx:63-79` | Encoded-stage warning icon uses live `state.*` codec config against stale stage stats (F1) |
| 2 | Snapshot mismatch + name-keying | `TypeAssignConfig.tsx:15,22-23`; `pipelineCompute.ts:216` (`variableStats.set(v.name,…)`) | Per-row stats looked up by name against stale map; renames desync/collide (F2) |
| 3 | Duplicated constant (drift risk) | `ErrorBoundary.tsx:13` vs `persistence.ts:12-15` | Hardcoded copy of `STORAGE_KEYS` (F13) |
| 4 | Stale doc comment | `registry.ts:138-141` | Claims a main-thread `loadManifest` caller that no longer exists (F14) |
| 5 | Main-thread engine call (known, contained) | `MetadataEditor.tsx` `buildPlaceholderChunkIndex` | Only main-thread engine-shaped duplicate compute; froze the tab once, now cap-gated. Pattern policy in Part 2. |

**Cycles found: none. Global-access violations: none genuine** (all module-level caches are correctly scoped). The only structural issues are the two snapshot mismatches (rows 1–2), which Part 2 addresses.

---

## Part 2 — Target shape (minimal structural changes)

Four changes. None is a rewrite. Together they restore the "result-derived views read only from the result snapshot; state is id-keyed everywhere" invariants the codebase already mostly follows.

### S1 — Extend `computedFrom` (or move warnings into the worker) so `PipelineStrip` stops zipping live state against stale stats

- **What:** Either add `fieldPipelines`/`chunkPipeline` to `PipelineResult.computedFrom`'s `Pick<>` (`pipelineCompute.ts:478`, stamped `worker/client.ts:158-163`) and feed `PipelineStripConnected` from `viewConfig`-equivalent data, **or** compute `codecWarnings` inside the worker as part of the Encoded stage payload so it's never a second main-thread recompute. Prefer the latter — it deletes the drift class rather than widening the snapshot.
- **Why:** `App.tsx` already proved views must render from the snapshot the shown result was computed from; `PipelineStrip` bypasses it (F1).
- **Unblocks:** F1 fix, and removes the "warning doesn't match the node next to it" demo symptom.

### S2 — Re-key `variableStats` by `Variable.id`

- **What:** `pipelineCompute.ts:216` `variableStats.set(v.id, result.stats)`; `TypeAssignConfig.tsx:23` `variableStats.get(v.id)`. Pure rename — ids are unique and stable where names aren't. Re-check `PipelineStrip.tsx:74` (`Array.from(variableStats.values())`) is unaffected (it is — values, not keys).
- **Why:** Name-keying + live/stale cross-source makes a mid-compute rename either drop or swap a row's stats (F2). This mirrors the existing id-keyed `fieldPipelines` convention (CLAUDE.md pitfall D5).
- **Unblocks:** F2; makes stats robust to renames permanently.

### S3 — Enforce the `Variable.id` uniqueness invariant that everything already assumes

- **What:** One guard in `ADD_VARIABLE` (`useAppState.ts:96`): `if (draft.variables.some(v => v.id === action.variable.id)) return;` mirroring `REMOVE_VARIABLE`'s existing `if (idx === -1) return;`. Optionally a dedup pass in `validateState` so a corrupted persisted save self-heals like every other invariant it enforces.
- **Why:** `fieldPipelines` keying, hover-trace ids, and React list keys all depend on id uniqueness, but nothing enforces it. `var_${Date.now()}` can collide on a rapid double-add; a hand-merged save can duplicate. Result is silent: wrong row edited, a sibling's codec pipeline deleted (F3).
- **Unblocks:** F3; closes the one load-bearing invariant the state model assumes but never checks.

### S4 — Policy: no engine compute on the main thread from components

- **What:** State the rule explicitly in the plan and CLAUDE.md: **components never call `src/engine/` compute functions directly** — everything goes through the worker. `MetadataEditor`'s `buildPlaceholderChunkIndex` is the one grandfathered exception (cap-gated). New previews that need engine output subscribe to a worker stage payload instead.
- **Why:** The one existing main-thread engine call froze the tab once. This is a pattern policy, not a bug — it prevents the class from recurring.
- **Unblocks:** nothing directly; it's a guardrail that keeps Part 0's worker-isolation property from eroding.

These four are Phase 1. Everything else in Part 4 is a leaf fix that can proceed once (or in parallel with) Phase 1, since none of them depend on the snapshot/keying shape.

---

## Part 3 — Findings inventory

Severity reflects verifier adjustments. `verify:` gives the exact gate. Full descriptions follow the table.

| ID | Sev | Kind | Area | One-line | Fix | Verify |
|----|-----|------|------|----------|-----|--------|
| **F1** | med* | bug | data-flow | PipelineStrip warning icon = live codec config vs stale stage stats | S1: warnings in worker payload, or extend `computedFrom` | `scenario-worker-pipeline.mjs`, `scenario-real-codecs.mjs` |
| **F2** | med* | bug | data-flow | `variableStats` name-keyed + stale; rename drops/swaps a row's stats | S2: re-key by `Variable.id` | `npx vitest run`, `scenario-curated-variables.mjs` |
| **F3** | high | bug | state | Variable id collisions never prevented/detected → silent data loss | S3: `ADD_VARIABLE` id-exists guard + optional validateState dedup | `npx vitest run tests/unit/state/reducer.test.ts` |
| **F4** | high | ux | engine-worker | Mid-session `ok:false` invisible outside About modal | Lift `result===null` gate → dismissible error banner | `scenario-real-codecs.mjs` |
| **F5** | high | ux | engine-worker | Hung compute with nothing queued never recovers, no signal | Fire watchdog crash/respawn on timeout regardless of `queued` | `npx vitest run tests/unit/worker/client.test.ts` |
| **F6** | high | ux | config-ui | Restore-checkpoint button can be enabled yet silently no-op | Surface `restoreCheckpoint` failure via existing label pattern | `scenario-share-checkpoint.mjs` |
| **F7** | high | ux | config-ui | Schema min/max & scale/offset commit per keystroke (full recompute) | Add `commitOnBlur` to those `NumberInput`s | manual + `scenario-worker-pipeline.mjs` |
| **F8** | crit | bug | viewers | GridCanvas sub-pixel-tall for 1D presets (both tabular FORMAT presets) | Explicit CSS px height instead of `height:auto` from 1×cols ratio | `scenario-flatview-stages.mjs` + manual grid check |
| **F9** | high | bug | viewers | FlatView unwindowed → exceeds browser scroll-height cap on array presets | Reuse HexView `WINDOWED_SECTION_ROWS` windowing | `scenario-flatview-stages.mjs`, `scenario-large-array.mjs` |
| **F10** | high | perf | viewers | TableView chunk-hover fallback O(rows×cols) scan freezes at 1M scale | Parse chunkId, compute target row directly (chunkIdForElement inverse) | `scenario-hover-linking.mjs` |
| **F11** | high | ux | ux-coherence | Sidebar/guide order (Chunk/Interleave before Type Assignment) contradicts engine order | Reorder `SECTIONS` + `STEPS`; Typed before Chunk/Interleave | `scenario-guide.mjs`, `scenario-talk-arc.mjs` |
| **F12** | med* | bug | ux-coherence | Delta-on-float32 shows no warning; stale test still asserts one | Restore advisory warning OR downgrade test to knownFail + reconcile | `scenario-codec-warnings.mjs` |
| **F13** | low | drift | data-flow | ErrorBoundary hardcodes a 2nd copy of storage keys | Import `STORAGE_KEYS` from persistence.ts | `npx tsc -b` |
| **F14** | low | drift | data-flow | `loadManifest` comment claims a removed main-thread caller | Fix comment to worker-only | (doc) |
| **F15** | med | drift | state | `useWorkerPipeline` recompute deps are a hand-maintained field list (went stale once) | Derive from `state` minus `ui`, or add a subset-assertion test | `npx vitest run` |
| **F16** | low | drift | state | `metadata.customEntries` never structurally validated | Add filter to `validateState` like sibling array fields | `npx vitest run tests/unit/state/persistence.test.ts` |
| **F17** | low | drift | state | Theme logic duplicated (index.html script vs `resolveTheme`), no pin | Snapshot/contains test over index.html script | `scenario-theme-toggle.mjs` |
| **F18** | med | ux | engine-worker | `respawnCount` tracked but never surfaced → silent crash-loop | Trigger F4 banner on respawn threshold | `npx vitest run tests/unit/worker/client.test.ts` |
| **F19** | low | perf | engine-worker | Evict-on-send makes post-respawn recompute pay full cost, no signal | (No code change) surface timings in F4 banner after respawn | — |
| **F20** | med | bug | config-ui | `keepBits` bare input bypasses clamp → unclamped bitround shift | Use shared `NumberInput` + `clampParamValue` (min 1, max 23/52) | `npx vitest run` + manual |
| **F21** | med | ux | config-ui | Row-mode hides per-field codec pipelines with no "preserved" note | One-line count note in CodecSection/InterleaveConfig | manual |
| **F22** | med | drift | viewers | (Dup of F1, viewers framing) PipelineStrip codec warning from live state | Covered by S1 | see F1 |
| **F23** | med | drift | ux-coherence | Guide wrap-up says GeoTIFFesque has 3 bands; preset ships 1 | Edit wrap-up body | `scenario-guide.mjs` |
| **F24** | med | drift | ux-coherence | Guide schema step describes removed "Data picker"/"dataset presets" | Rewrite to per-variable Source dropdown | `scenario-guide.mjs` |
| **F25** | med | ux | ux-coherence | Codec editor shows bare unlabeled output dtype (no arrow/in/out) | Prefix `→` per design doc example | `scenario-codec-warnings.mjs` (text) |
| **F26** | med* | drift | drift-tests | `design.md` says presets & WASM codecs "not yet built" — both shipped | Update Presets section, remove roadmap bullets | (doc) |
| **F27** | high | drift | drift-tests | `scenario-presets.mjs` targets deleted 3-preset era, fails immediately | Rewrite to 4-preset PRESET_OPTIONS | `node tests/ui/scenario-presets.mjs` |
| **F28** | med | drift | drift-tests | `design.md` cap description ("advisory only") contradicts hard cap | Document HARD_ELEMENT_CAP/HARD_CHUNK_CAP tiers | (doc) |
| **F29** | med | test-gap | drift-tests | No UI proof the hard cap stops the crash-loop end-to-end | Add seeded-oversized check to `scenario-crash-inputs.mjs` | `node tests/ui/scenario-crash-inputs.mjs` |
| **F30** | low | drift | drift-tests | `remediation-plan.md` D10 names stale single-slot custom-preset key | One-line amendment to per-model key scheme | (doc) |
| **F31** | high | ux | config-ui | (Owner request) No way to toggle a codec step's effect on/off for demos — only delete/re-add, losing params | `CodecStep.enabled?: boolean` + `activeSteps()` filter at engine boundaries + step toggle UI | `npx vitest run`, `scenario-real-codecs.mjs` |
| **F32** | high | bug | viewers | GridCanvas paints an all-transparent (zero-alpha) buffer for large tabular arrays — canvas sizes correctly (post-F8) but shows nothing | Root-cause the values/colorValues flow into GridCanvas's putImageData for the >MAX_CELLS tabular case | manual grid check on Parquet-adjacent preset |

`*` = verifier-downgraded from the seed audit's "high"/"critical". F22 is the viewers-area restatement of F1 — fix once via S1.

### Full descriptions

**F1 — PipelineStrip warning icon uses live config against stale stats.** `App.tsx:173-178` feeds `PipelineStripConnected` `variables/fieldPipelines/chunkPipeline/interleaving` from live `state.*`, while `PipelineStrip.tsx:63-79` draws `stages/variableStats` from the stale context `result`. During an in-flight compute (Pyodide codecs "can take seconds") the Encoded ⚠ can describe a codec pipeline not in the shown Encoded stage. `computedFrom` (`client.ts:156-163`) exists precisely to prevent this but omits `fieldPipelines`/`chunkPipeline`. *Blast radius:* the warning icon + tooltip only; self-corrects on next result; no data corruption. **Fix via S1.**

**F2 — `variableStats` name-keyed + stale.** `TypeAssignConfig.tsx:22-23` iterates live `variables` (prop) and does `variableStats.get(v.name)` against the stale context map set by name at `pipelineCompute.ts:216`. Renaming a variable mid-compute makes its row's stats vanish; a rename that collides with another row's old name shows that other row's stats. Name has no uniqueness constraint; the input dispatches per keystroke. *Blast radius:* the advisory clipped/rounded hint text only; self-heals next compute. **Fix via S2** (id-keying, matching `fieldPipelines`).

**F3 — Variable id collisions unprevented.** `Sidebar.tsx:88` mints `var_${Date.now()}` (ms resolution, no check). `ADD_VARIABLE` (`useAppState.ts:96-108`) pushes unconditionally; `REMOVE_VARIABLE` does `delete draft.fieldPipelines[action.id]` for *all* rows sharing that id; `UPDATE_VARIABLE` `.find()`s the first match. `validateState` has no id-dedup (unlike its careful fieldPipelines re-keying at `persistence.ts:340-361`). `SchemaEditor.tsx:215` `key={v.id}` mis-renders duplicates. `pipelineCompute.ts:303` `?? []` silently degrades a missing pipeline to empty. Reachable via rapid double-click of `add-variable` (no debounce/disable) or a hand-merged save. *Blast radius:* silent codec-pipeline data loss + wrong-row edits. **Fix via S3.**

**F4 — Mid-session `ok:false` invisible.** `App.tsx:312` `bootError = result===null ? diagnostics.lastError : null` — dead after the first successful compute (within ~1s of load). Later failures (`client.ts:169-171` sets `lastError` only; test `client.test.ts:123-132` pins `onResult` not called, status→idle) show only in the About modal (`AboutModal.tsx:156-158`), two clicks deep, no error badge on the `about-button`. Spinner clears identically for success and failure, so the pane silently freezes on last-good data. *Fix:* lift the `result===null` gate so any non-null `lastError` renders a small dismissible banner (mirror RuntimeBanner); `lastError` is already cleared on next success (`client.ts:166`). UI-only.

**F5 — Hung compute with nothing queued never recovers.** `client.ts:114-122` `armWatchdog` only calls `handleCrash` when `queued !== null` — deliberate per the brief, but an unqueued wedge (a Pyodide WASM call that never returns on flaky network, `pipeline.worker.ts:97`) stays `computing` forever with only the generic `pipeline-computing-indicator` (`PipelineStrip.tsx:192`) as signal. *Fix:* fire the crash/respawn on timeout regardless of `queued`; `handleCrash`'s `repost = this.queued ?? this.inFlight?.state ?? null` already reposts the in-flight state. Turns a permanent hang into a bounded one. Guard-condition-only change.

**F6 — Restore button enabled yet no-op.** `hasCheckpoint` (`share.ts:29-35`) only checks key presence; `loadCheckpoint` (`share.ts:44-54`) additionally validates and returns null on failure; `restoreCheckpoint` (`useAppState.ts:418-435`) only `console.error`s on null. `canRestore` (`Header.tsx:85`) never reflects the stricter validation, so a stale/corrupt checkpoint (exactly what recent commit `001cbf1`'s drop-don't-migrate policy produces) leaves the button clickable and silent. No toast infra exists in the app. *Fix:* thread a boolean/reason back into a Header label, mirroring the existing `checkpointLabel`/`shareLabel` timed-message pattern in the same file.

**F7 — Per-keystroke commit on min/max & scale/offset.** Shape/chunk-shape got `commitOnBlur` (`NumberInput.tsx:13-19` doc comment: a large committed value can hang the worker mid-keystroke) but `SchemaEditor.tsx:372-410` (min/max/decimalPlaces/significantFigures) and `TypeAssignConfig.tsx:86-98` (scale/offset) did not — min/max reseeds `generateValues` over the whole array (full pipeline rerun), scale/offset reruns `assignType`. Typing `-1000000` fires a compute per digit; the view visibly flickers through throwaway values. *Fix:* add `commitOnBlur` to those inputs, matching the sibling shape inputs.

**F8 — GridCanvas invisible for 1D presets (CRITICAL).** `GridView.tsx:112-118` uses canvas when `values.length > MAX_CELLS` (10k) with no 1D exemption; for 1D it computes `rows=1, cols=shape[0]`. `GridCanvas.tsx:214-228` sets intrinsic `width=cols height=rows` and CSS `height:auto`, so a 144,769-wide, 1-tall canvas at a 900px pane renders ~0.006px tall — rounded away. Both tabular presets are `[144769]`. Switching either to Grid view (one click) shows a blank strip. *Fix:* set explicit CSS pixel height instead of `height:auto` (e.g. clamp `containerWidth/cols*rows` to a minimum). Does not affect 2D array presets.

**F9 — FlatView unwindowed.** `FlatView.tsx:41-48` hands `flatGroupCount(layout)` straight to the virtualizer with no cap. HexView was explicitly windowed (`useHexData.ts:56-70`, `WINDOWED_SECTION_ROWS=262_144`, comment cites Firefox's ~17.9M px scroll cap). Values/Typed stage of a `[1024,1024]` array preset = ~1,048,576 rows × 22px ≈ 23M px — over the cap. Flat is offered on every stage incl. Values/Typed. *Fix:* apply the same windowing bound (reuse `useHexData` constants).

**F10 — TableView chunk-hover O(rows×cols) scan.** `TableView.tsx:125-133` nested-loops over every (variable,row) calling `elementInChunk` (`layout.ts:607-627`, per-call string split/parse) when a cross-pane hover carries only a chunkId. At 144,769×5 ≈ 724K calls per mouseenter, dragging across a hex/flat pane freezes (benchmarked ~86-90ms per scan, ~1.7s over a 20-event drag). `scenario-hover-linking.mjs` only exercises 40k cells. *Fix:* parse the chunkId once and compute the target row's flat index directly (chunkIdForElement inverse) instead of scanning; at minimum break out on the no-match-in-this-variable path.

**F11 — Sidebar/guide order contradicts engine order.** Engine computes Typed (`pipelineCompute.ts:188,212`) before Linearized (=Chunk+Interleave, `:264`); the guide intro (`steps.ts:74`) states "Values → Typed → Linearized → Encoded". But `Sidebar.tsx:16` `SECTIONS` puts Chunk/Interleave *before* Type Assignment, and the guide "walks top to bottom." A presenter narrating the guide against the sidebar hits a contradiction. `ChunkConfig`/`InterleaveConfig` are dtype-agnostic (verified), so this is a pure reorder. *Fix:* `SECTIONS = ['Schema','Type Assignment','Chunk','Interleave','Codecs','Metadata','Write','Read']` and swap the matching `STEPS` entries.

**F12 — Delta-on-float32 no warning; stale test asserts one.** Delta's `applicableTo` is `()=>true` and `isLossy` `()=>false` (`codecs.ts`) by design (a shuffle makes the declared dtype unreliable). `stepWarnings` has no float-specific advisory, so Delta on the default float32 `temperature` shows nothing (same byte count → no size color either). `scenario-codec-warnings.mjs:62-90` still asserts a ⚠ and a "lossy" tooltip with plain `h.check` — it fails. **Verifier note:** design.md and the guide text were *already* updated to the new intentional behavior in this same working-tree change, so the only stale artifact is the orphaned test (not in CLAUDE.md's standing-harness list, not in CI). *Fix:* either restore a narrow float/char advisory in `stepWarnings` (keeping `applicableTo`=>true structurally), or downgrade the test's two asserts to `h.knownFail` with a tracked ID. Pick one direction; only one of {engine, guide, test} should move — and guide/design already moved.

**F13 — ErrorBoundary duplicated storage keys.** `ErrorBoundary.tsx:13` hardcodes the two keys `persistence.ts:12-15` also defines as `STORAGE_KEYS`. Currently in sync; persistence.ts churns, ErrorBoundary hasn't since Phase 0. The reset button is the last line of defense — a drifted key list means it silently does nothing. *Fix:* export `STORAGE_KEYS` and import it. One-line swap.

**F14 — `loadManifest` stale comment.** `registry.ts:138-141` claims main-thread + worker sharing; the only caller is `pipeline.worker.ts:34`. Doc-only.

**F15 — `useWorkerPipeline` hand-maintained deps.** `useWorkerPipeline.ts:74-79` destructures 11 named AppState fields with `eslint-disable exhaustive-deps`; the code's own comment (`:64-69`) records that `linearization`/`byteOrder` were once missing (fix `739de5e`), producing silently-stale results. Currently complete, but nothing structural stops the next added field from being omitted. *Fix:* derive from `state` minus `ui` (single object literal), or add a vitest asserting `Object.keys(DEFAULT_STATE)` minus `'ui'` ⊆ tracked deps so a future omission fails CI.

**F16 — `metadata.customEntries` unvalidated.** `validateState` (`persistence.ts:291-369`) guards every other collection but not `customEntries`; `metadata.ts:180` iterates it directly, so a non-array from corrupt storage/share throws inside the worker instead of being dropped cleanly. *Fix:* add an `Array.isArray` + `{key,value}` filter alongside the existing array-field guards.

**F17 — Theme logic duplicated.** `uiPrefs.ts:1-4` comment: keep in sync with index.html's blocking script (`index.html:12-25`). Currently agree; nothing pins them. *Fix:* small vitest asserting index.html's script contains the same key/matchMedia pattern, or snapshot the script body.

**F18 — `respawnCount` unsurfaced.** `client.ts:206` increments on every crash; only `AboutModal.tsx:153` reads it; `client.ts:209` resets runtime → re-streams ~12MB Pyodide each loop. A reliably-crashing state crash-loops silently. *Fix:* trigger the F4 banner once `respawnCount` crosses a small threshold. Reuses F4's banner.

**F19 — Evict-on-send post-respawn cost.** `pipelineCompute.ts:792-796` deletes cache on every emitted stage (deliberate, transfer-detaches-buffers). Post-respawn the empty cache treats the next compute as a full miss — a second multi-second freeze after a crash, only a generic spinner. No code change required; surface timings in the F4 banner after respawn so it reads "recovering" not "frozen again."

**F20 — `keepBits` unclamped.** `TypeAssignConfig.tsx:106-117` is a raw `<input type=number>`; HTML min/max don't constrain typed/pasted input. `typeAssign.ts:228-234` does `mask = 0xffffffff << (23 - keepBits)` with no bounds check — a large negative shift is taken mod 32, producing garbage values, no warning. `clampParamValue` already exists (`CodecPipelineEditor.tsx:50-63`, added for exactly this class, "UI-15"). *Fix:* use shared `NumberInput` + `clampParamValue` (min 1, max `outDtype==='float64'?52:23`).

**F21 — Row-mode hides field pipelines with no note.** `CodecSection.tsx:30-121` row branch never references `fieldPipelines` (state preserves them per pitfall 4, but the UI gives no indication). Toggling Interleave makes per-field codecs appear discarded, reappear unexplained. *Fix:* one-line count note ("N per-field pipelines preserved, inactive in row mode") in the row-mode banner.

**F22 — (viewers restatement of F1).** Same wiring gap, viewers framing (`App.tsx:102-107` viewConfig used only for StagePane; `PipelineStrip` fed raw `state.*`). Covered by **S1**; don't fix twice.

**F23 — Guide wrap-up 3 bands.** Wrap-up body says GeoTIFFesque is 3 bands (elevation + generated slope + hillshade); `geotiffesque.json` ships one `elevation` variable. *Fix:* edit the clause to a single band (match zarrish's single-sst framing already in the paragraph).

**F24 — Guide schema step "Data picker".** Schema step body describes a schema-wide "Data picker" and "dataset presets" — both removed (CLAUDE.md migration note); sourcing is now per-variable `variable-source-{index}` (`SchemaEditor.tsx:266-296`). *Fix:* rewrite to describe the per-row Source dropdown and that FORMAT presets carry sources pre-wired.

**F25 — Codec editor bare dtype.** `CodecPipelineEditor.tsx:181-186` renders `{codec.label}` then the step's *output* dtype string with no arrow/label — the only unlabeled value in the sidebar. For a dtype-collapsing codec it reads as "Byte Shuffle operates on uint8" rather than "produced uint8." Plausible root of the reported "working through codecs is confusing." design.md's own example uses `→int16`. *Fix:* prefix `→` before the dtype span.

**F26 — design.md says presets/WASM codecs unbuilt.** `design.md:628-636` ("Presets (v2) … Not yet built") and `:930,:933` (v2 Roadmap lists Presets + "WASM codecs: zstd, deflate" as deferred) — both shipped (`presets.ts:20-37`, `codecs.ts:470-491` Pyodide-backed). *Fix:* update the Presets section to point at `presets.ts`/`src/presets/*.json`; remove the two roadmap bullets.

**F27 — `scenario-presets.mjs` stale (3-preset era).** Asserts `tabularOptions[0]==='basically-parquet'` (`:64`) and array `['basically-geotiff','basically-zarr']` length 2 (`:112-115`); current `PRESET_OPTIONS` (`presets.ts:25-30`) is 4 presets, 2 per model (`parquet-adjacent`/`avroesque`, `geotiffesque`/`zarrish`). Reproduced: first assert fails, then `selectOption('basically-parquet')` hangs 30s and throws, exit 2. Only fully-drifted scenario file. *Fix:* rewrite keys/labels/counts to the 4 presets; add coverage for the second preset per model.

**F28 — design.md cap "advisory only".** `design.md:829,:845` say the cap is advisory and nothing blocks; `pipelineCapError` (`pipelineCompute.ts:59-75`, `HARD_ELEMENT_CAP=32M`, `HARD_CHUNK_CAP=1,048,576`) hard-refuses at three call sites. *Fix:* document both tiers (soft banner vs hard refuse) near `:829` and update the Edge Cases row at `:845`.

**F29 — No UI proof the hard cap stops the crash-loop.** `pipelineCapError` is unit-tested (`pipeline.integration.test.ts:284-303`) but `scenario-crash-inputs.mjs` (the "Stop the crashes" file) has no cap check. *Fix:* add one check — `seedStateAndReload` with a shape/var count over `HARD_ELEMENT_CAP`, assert no ErrorBoundary crash and the `pipelineCapError` message shows user-visibly (uses the helper per CLAUDE.md pitfall 7).

**F30 — remediation-plan D10 stale key.** `remediation-plan.md:344` names single-slot `0x00c0dec5-preset-custom`; real key is per-model `customPresetKey(model)` (`presets.ts:39-51`, old key kept as read-only fallback). *Fix:* one-line amendment.

**F32 — GridCanvas draws a fully transparent buffer for large tabular arrays (found during P3.1, 2026-08-17).** While fixing F8's sub-pixel height, the fixer verified in-browser that the canvas now sizes correctly (pane width × 24px) on the Parquet-adjacent preset's Grid view but `putImageData` paints an all-zero-alpha buffer — nothing visible. Confirmed pre-existing via `git stash` (reproduces with the F8 patch fully removed). DOM-mode grid (<10k cells, i.e. below `MAX_CELLS`) colors correctly, so the defect is specific to the canvas draw path's input data for large arrays — likely in the values/colorValues flow into `GridCanvas`, not the height/scale logic. *Fix:* root-cause the color-buffer population for the >MAX_CELLS tabular case (start where GridView builds the canvas-mode color data). *Blast radius:* GridCanvas draw path only; F8's height fix stands regardless. Slot into Phase 3 follow-up (P3.4).

**F31 — Per-step codec enable toggle (owner feature request, 2026-08-17).** For live demos, the presenter needs to flip a codec's effect on/off to show the before/after in the viewers; today the only path is deleting and re-adding the step, losing its params. *Design (minimal):* add optional `CodecStep.enabled?: boolean` (`src/types/codecs.ts`) where **absent = enabled** — zero migration, every existing save/preset/share-link unchanged. Add a single engine helper `activeSteps(steps: CodecStep[]): CodecStep[]` (filter `s.enabled !== false`) and apply it at every pipeline consumption boundary: `runCodecPipeline` call sites in `computeEncodedStage`, `reverseCodecPipeline` (`decode.ts`), `encodedChunkMeta`/traceMode folding (`layout.ts`), metadata codec collection (`metadata.ts` — the written file must list only ACTIVE codecs so the read round-trip stays honest), `isPipelineLossy`, and the step-warning/dtype-flow chain in `CodecPipelineEditor` (a disabled step's output dtype must not affect the next step's input — per CLAUDE.md pitfall 3, keep `outputDtypeFor` flowing across only active steps). UI: per-step on/off toggle in `CodecPipelineEditor` (testid `codec-enabled-{variable}-{index}`), step rendered dimmed when off, params preserved; recompute is free since pipelines are already memo-key inputs. *Tests:* unit — a pipeline with a disabled step encodes/decodes/serializes metadata identically to the pipeline without that step; toggle round-trips through persistence. *Blast radius:* codec flow surfaces listed above; risk is a missed consumption boundary silently treating a disabled step as active (grep all `fieldPipelines`/`chunkPipeline` reads to enumerate boundaries first). *Possible follow-up (not in scope):* same affordance for typeAssignment's scale/offset/bitround.

---

## Part 4 — Execution plan

Each item is sized for one focused agent session. **Regression protocol, every item:** after implementing, `npx tsc -b` and `npx vitest run` must both pass. **After any UI item**, run the named scenarios against a dev server (`npm run dev` at `http://localhost:5173/0x00c0dec5/`, then the `node tests/ui/scenario-*.mjs` files listed) and they must be `PASS`/`KNOWN-FAIL` (never `FAIL`/`UNEXPECTED`). A scenario file exits nonzero on any `FAIL`.

### Phase 1 — Structural (Part 2). Do these first; F1/F2/F3 unblock clean iteration.

**P1.1 — S1: kill the PipelineStrip live/stale zip (F1, F22).**
Files: `src/engine/pipelineCompute.ts` (Encoded stage payload), `src/worker/client.ts`, `src/components/layout/PipelineStrip.tsx`, `src/components/layout/App.tsx:173-178`. Prefer moving `codecWarnings` into the worker Encoded payload (deletes the drift class). Verify: `npx vitest run`, then `scenario-worker-pipeline.mjs` + `scenario-real-codecs.mjs`. Blocks nothing; unblocked.

**P1.2 — S2: re-key `variableStats` by id (F2).**
Files: `src/engine/pipelineCompute.ts:216`, `src/components/config/TypeAssignConfig.tsx:23`; re-check `PipelineStrip.tsx:74`. Verify: `npx vitest run`, `scenario-curated-variables.mjs`. Unblocked.

**P1.3 — S3: variable id uniqueness guard (F3).**
Files: `src/state/useAppState.ts` (`ADD_VARIABLE`), optionally `src/state/persistence.ts` (`validateState` dedup). Add a reducer test for the collision case (currently zero coverage). Verify: `npx vitest run tests/unit/state/reducer.test.ts`, then full `npx vitest run`. Unblocked.

**P1.4 — S4: main-thread engine-call policy.**
Files: `docs/overhaul-plan.md` (this doc, already states it), `CLAUDE.md` (add to Common Pitfalls). No code change. Verify: `npx tsc -b`. Documentation guardrail.

### Phase 2 — Failure/hang visibility (the demo-killer class). F4 is the shared banner; F18/F19 ride it.

**P2.1 — F4: mid-session error banner.**
Files: `src/components/layout/App.tsx:312`, a small banner component reusing RuntimeBanner's style/testid conventions. Verify: `scenario-real-codecs.mjs`, `npx vitest run tests/unit/worker/client.test.ts`. **Blocks P2.3 (F18), P2.4 (F19).**

**P2.2 — F5: watchdog recovers unqueued hangs.**
Files: `src/worker/client.ts:114-122`. Add a vitest for the unqueued-hang case. Verify: `npx vitest run tests/unit/worker/client.test.ts`. Unblocked.

**P2.3 — F18: surface `respawnCount` via the F4 banner.** Depends on P2.1. Files: `src/worker/client.ts`, banner from P2.1. Verify: `npx vitest run tests/unit/worker/client.test.ts`.

**P2.4 — F19: post-respawn timings in the banner (optional).** Depends on P2.1. Files: banner + diagnostics wiring. No compute-semantics change. Verify: `npx vitest run`.

### Phase 3 — Viewer scale bugs (reachable in one click on shipped presets).

**P3.1 — F8: GridCanvas explicit height (CRITICAL).** Files: `src/components/viewers/GridCanvas.tsx:214-228`. Verify: `scenario-flatview-stages.mjs` + manual grid-view check on a tabular preset. Unblocked.

**P3.2 — F9: FlatView windowing.** Files: `src/components/viewers/FlatView.tsx:41-48`, reuse `src/components/viewers/useHexData.ts` windowing constants. Verify: `scenario-flatview-stages.mjs`, `scenario-large-array.mjs`. Unblocked.

**P3.3 — F10: TableView chunk-hover direct lookup.** Files: `src/components/viewers/TableView.tsx:125-133` (parse chunkId, compute row directly). Verify: `scenario-hover-linking.mjs`. Unblocked.

### Phase 4 — Config-UI papercuts.

**P4.1 — F7: commitOnBlur on min/max & scale/offset.** Files: `src/components/config/SchemaEditor.tsx:372-410`, `src/components/config/TypeAssignConfig.tsx:86-98`. Verify: `npx vitest run`, manual. Unblocked.
**P4.2 — F20: keepBits shared NumberInput + clamp.** Files: `src/components/config/TypeAssignConfig.tsx:106-117`. Verify: `npx vitest run`, manual. Unblocked.
**P4.3 — F6: restore-checkpoint failure surfaced.** Files: `src/state/useAppState.ts:418-435` (return a reason), `src/components/layout/Header.tsx`. Verify: `scenario-share-checkpoint.mjs`. Unblocked.
**P4.4 — F21: row-mode preserved-pipelines note.** Files: `src/components/config/CodecSection.tsx`. Verify: manual. Unblocked.

**P4.5 — F31: per-step codec enable toggle (owner request — run FIRST after the Phase 1–3 loop lands, before Phase 4's other items).** Files: `src/types/codecs.ts`, `src/engine/codecs.ts`, `src/engine/pipelineCompute.ts`, `src/engine/decode.ts`, `src/engine/layout.ts`, `src/engine/metadata.ts`, `src/components/config/CodecPipelineEditor.tsx`, plus unit tests (`tests/unit/engine/codecs.test.ts`, `tests/unit/engine/pipeline.integration.test.ts`, `tests/unit/state/persistence.test.ts`). Sequenced after the loop because it touches the same engine files P1.1/P1.2 are editing. Verify: `npx vitest run`, `scenario-real-codecs.mjs`, `scenario-worker-pipeline.mjs`. Note: this item's file list is wider than most — the checker should hold the "enumerate all consumption boundaries first" line from F31's description rather than flagging breadth as scope creep.

### Phase 5 — UX-coherence + guide/doc content.

**P5.1 — F11: reorder SECTIONS + STEPS (Typed before Chunk/Interleave).** Files: `src/components/layout/Sidebar.tsx:16`, `src/components/guide/steps.ts`. Verify: `scenario-guide.mjs`, `scenario-talk-arc.mjs`. Unblocked.
**P5.2 — F12: reconcile Delta-warning (engine vs test).** Files: `src/engine/codecs.ts` (if restoring) OR `tests/ui/scenario-codec-warnings.mjs` (if downgrading). Verify: `scenario-codec-warnings.mjs`. Unblocked.
**P5.3 — F25: codec editor `→` dtype label.** Files: `src/components/config/CodecPipelineEditor.tsx:181-186`. Verify: `scenario-codec-warnings.mjs` (text). Unblocked.
**P5.4 — F23 + F24: guide content (bands, Data picker).** Files: `src/components/guide/steps.ts`. Verify: `scenario-guide.mjs`. Unblocked.

### Phase 6 — Drift, tests, docs (lowest risk, do in one or two sessions).

**P6.1 — F27: rewrite `scenario-presets.mjs` to 4 presets.** Files: `tests/ui/scenario-presets.mjs`. Verify: `node tests/ui/scenario-presets.mjs` exits 0. Unblocked.
**P6.2 — F29: hard-cap crash-loop UI check.** Files: `tests/ui/scenario-crash-inputs.mjs`. Verify: `node tests/ui/scenario-crash-inputs.mjs`. Unblocked.
**P6.3 — F13/F15/F16/F17: state/persistence robustness batch.** Files: `src/components/shared/ErrorBoundary.tsx` + `src/state/persistence.ts` (export keys); `src/hooks/useWorkerPipeline.ts` (derived deps or subset test); `src/state/persistence.ts` (customEntries filter); theme pin test. Verify: `npx vitest run`, `scenario-theme-toggle.mjs`. Unblocked.
**P6.4 — F14/F26/F28/F30: doc-only fixes.** Files: `src/datasets/registry.ts` (comment), `docs/design.md`, `docs/remediation-plan.md`. Verify: `npx tsc -b` (comment change) + read-through. Unblocked.

---

## Part 5 — Loop protocol

1. **Pick the next unblocked item** in Phase order (Phase 1 first, always). Within a phase, order by severity. Never start an item whose "blocks" dependency isn't done.
2. **One fixer agent** implements the item, touching **only the files listed for it**, and runs the item's verification gate plus the standing regression protocol: `npx tsc -b` and `npx vitest run` must pass; for UI items the named scenarios must be `PASS`/`KNOWN-FAIL` (no `FAIL`/`UNEXPECTED`).
3. **One independent checker agent** re-runs the same gates from a clean state and `git diff`s the change against the item's file list, checking for scope creep (files touched beyond the list, unrelated edits, new abstractions). Checker confirms the fix addresses the finding's root cause, not just the named symptom.
4. **Item done, or bounced back once.** If the checker rejects (gate fails, scope creep, wrong root cause), the fixer gets exactly one revision pass. A second rejection escalates to the owner rather than looping.
5. **Every 3–4 items, full re-evaluation:** `npx tsc -b` + full `npx vitest run` + the entire `tests/ui/scenario-*.mjs` suite against a dev server, to catch cross-item regressions (especially after Phase 1's snapshot/keying changes and Phase 2's shared banner, which multiple later items build on).
6. **Escalation rule (hard):** any fix that requires touching **more files than its listed set** stops and escalates to the owner with the reason — it is not silently expanded. A finding whose real fix is bigger than its blast-radius estimate is new information the owner needs, not a license to grow the diff.
7. **Scenario hygiene:** if a `KNOWN-FAIL` flips to passing (`UNEXPECTED`), that's the signal the underlying finding is fixed — convert the check to a normal `check` and close the finding in the same item. Don't leave a passing `knownFail` in place.

---

## Appendix — Rejected findings

None. The verifier rejected no candidate findings this pass; the only adjustments were severity downgrades (F1, F2, F12, F26 from high/critical to medium), which are reflected in Part 3. Re-audits should not re-surface these as new: they are known and inventoried above.
