# 0x00C0DEC5 — Remediation Plan

> **Status**: findings from a full-codebase review (2026-07-01). Four review passes were run:
> engine correctness, state/pipeline wiring, UI components, and a live Playwright smoke test.
> All findings marked "verified" were reproduced by executing the actual code path or observing
> the running app — they are not speculation.
>
> **For the implementer**: execute the phases in order. Each phase is a coherent,
> independently-shippable chunk with acceptance criteria. Do not skip Phase 1 (honest tests)
> to get to the "real" fixes — the tests are what make every later phase verifiable.
> Check off items as they are completed. Design decisions in Part 2 are **pinned** —
> implement them as written and cite decision IDs (D1…D10) in commits; do not re-litigate
> them. If you hit an ambiguity not covered by a decision ID, stop and surface it rather
> than improvising.

## Executive Summary

The project does **not** need a rewrite. The architecture is sound: the engine/UI separation
is real, hover tracing works, the codec pipeline works, and most day-to-day interactions are
clean. The problems are:

1. **The 314 green tests almost exclusively cover 1-D, single-chunk, codec-free, header+JSON
   configurations.** Nearly every serious bug lives just outside that box. The headline
   feature — encode → write → read → decode with codecs — has zero end-to-end coverage.
2. **Complexity is concentrated, not pervasive**: one overbuilt file (`src/engine/read.ts`),
   substantial duplication (hex views, byte-layout decoding, traceId handling, `concatBytes`,
   `hexToBytes`), and a monolithic pipeline recomputation.
3. **The design docs are stale.** Scale/offset and bitround are no longer codecs — they became
   the "logical type + type assignment" concept and a "Typed" pipeline stage that
   `docs/design.md` and `CLAUDE.md` do not describe. Anyone working from the docs fights the code.

---

## Part 1: Findings

Severity legend: **CRITICAL** = crash or silent data corruption; **MAJOR** = feature broken or
spec violated in a user-visible way; **MINOR** = defect with limited blast radius or latent hazard.

> **Locating code**: all `file:line` references below are pinned to commit `4d09954` and will
> drift as phases land. Locate code by the named symbol and the described behavior; treat line
> numbers as historical hints, never as edit targets.

### 1.1 Crashes (all verified)

| ID | Severity | Finding |
|----|----------|---------|
| CR-1 | CRITICAL | **Odd-length magic number white-screens the app.** `hexToBytes` at `src/engine/write.ts:8-16` throws on odd-length hex. `SET_WRITE_MAGIC` (`src/state/useAppState.ts:186-189`) stores raw input unvalidated; `usePipeline` has no try/catch; there is **no ErrorBoundary anywhere** (`src/main.tsx`). Backspacing one character in the magic field mid-edit blanks the page (verified live; stack: `hexToBytes → assembleFiles → computePipelineStages → MainLayout`). Note `src/engine/read.ts:209-217` has its own *tolerant* `hexToBytes` — the safe variant exists on the wrong side. Related: even-length non-hex input (`GGGG`) silently becomes `00` bytes via `parseInt → NaN` (verified). |
| CR-2 | CRITICAL | **Zero-variables edge case crashes any Grid pane.** `src/components/viewers/GridView.tsx:67-73` returns early before `useMemo` (:79) and `useEffect` (:111) — a rules-of-hooks violation (confirmed by ESLint). Delete all variables (a spec'd edge case), then add one back → "Rendered more hooks than during the previous render" → React unmounts the tree. |
| CR-3 | CRITICAL | **Stale localStorage can permanently white-screen the app.** `migrateState` (`src/state/persistence.ts:11-59`) handles exactly one historical migration and otherwise returns parsed JSON cast to `AppState` with no validation and no merge against `DEFAULT_STATE`. A persisted state missing a structural field throws inside `computePipelineStages` on **every** load until the user manually clears localStorage. The try/catch in `loadState` covers only `JSON.parse`. Missing newer fields (`write.includeMetadata`, `ui.showDiff`) silently flow in as `undefined`. |
| CR-4 | MINOR | **Chunk shape 0 hangs the app.** `computeChunkGrid` (`src/engine/chunk.ts:12`) yields `Infinity` for `chunkShape[d] = 0` and `enumerateChunkCoords` loops forever. The UI clamps (`ChunkConfig.tsx:38`) but `SET_CHUNK_SHAPE` (`useAppState.ts:139-142`) has no guard (unlike `SET_SHAPE` at :84-88), so corrupted/hand-edited localStorage reaches the engine. |

### 1.2 Silent data corruption (all verified)

| ID | Severity | Finding |
|----|----------|---------|
| DC-1 | CRITICAL | **Multi-chunk read reassembly ignores chunk geometry.** `reconstructValues` (`src/engine/read.ts:307-386`) and `reconstructFromChunkFiles` (:417-481) receive `_chunkShape`/`_shape` and never use them. Decoded chunk streams are concatenated in file order and treated as the flat row-major array, but chunks contain chunk-local row-major values. Verified: shape `[4,4]`, chunkShape `[2,2]`, column mode, no codecs → `success: true` with values in chunk-concatenation order. Works only for 1-D or single-chunk configs — exactly what the tests cover. The diff view misattributes the corruption to "precision loss." Column-major `chunkOrder` scrambles further since the reader never consults `chunk_index` coords. |
| DC-2 | CRITICAL | **Delta codec is irreversible on unsigned dtypes.** Encode (`src/engine/codecs.ts:33-39`) and decode (:56-62) round-and-clamp diffs/cumsums to the dtype range, so any negative diff on an unsigned dtype clamps to 0. Verified: `uint16 [57,12,90,3]` → round-trip → `[57,57,147,147]`, **on the default `humidity` variable**, and `lossyVariables` does not flag it (the extension spec's `lossy: boolean` on `CodecDefinition` was never implemented). Removing the clamp fixes it: typed-array writes wrap mod 2^N, making the round-trip exact. Delta on float32 is also subtly lossy (diffs re-rounded to float32 at `codecs.ts:41`), unflagged. |
| DC-3 | MAJOR | **Per-chunk file ordering uses only the last number in the filename.** `extractChunkIndexFromName` (`src/engine/read.ts:483-489`) returns `nums[nums.length-1]`, so 2-D files sort `[0_0, 1_0, 0_1, 1_1]`. The reader also ignores the sidecar's `chunk_index` in per-chunk mode (`_chunkIndex` unused, :425). Verified: shape `[4,4]`, chunkShape `[2,2]`, per-chunk + sidecar → success reported, values scrambled (compounds DC-1). |
| DC-4 | MINOR | **Header-offset convergence gives up unverified.** `src/engine/write.ts:104-141` runs three copy-pasted passes; if metadata size still changes after pass three (offset digit-count oscillation), `chunk_index` offsets are stale and reads mis-slice, silently. |
| DC-5 | MINOR | **Custom metadata keys silently shadow auto keys.** JSON serialization (`src/engine/metadata.ts:98-105`) collapses entries into an object, last wins. A custom entry keyed `shape` or `schema` corrupts the file's self-description and breaks read with no warning. |
| DC-6 | MINOR | **float64 bitround broken at exactly keepBits=20.** `src/engine/typeAssign.ts:157`: `0xffffffff << 32` wraps to `<< 0` in JS, so `maskLow` keeps all 32 low mantissa bits. Verified with π. Fix: boundary at :156 should be `> 20`, not `>=`. |

### 1.3 Read-path feature gaps (verified)

| ID | Severity | Finding |
|----|----------|---------|
| RP-1 | MAJOR | **Binary metadata + footer placement is unreadable.** The footer branch of `tryParseEmbeddedMetadata` (`src/engine/read.ts:270-299`) only searches for JSON braces; no binary path exists. Verified live: footer+binary+includeMetadata → "Cannot read file … no metadata" (misleading — metadata IS in the file). All other placement×format combos work. Tests cover binary+header only (`read.test.ts:292`). |
| RP-2 | MAJOR | **Header JSON locator's brace counting ignores string literals.** `src/engine/read.ts:238-255` — a custom metadata value containing an unbalanced brace (e.g. `note = "weird { value"`) makes the scanner pick the wrong end offset; read fails despite valid metadata. Directly relevant to the geo use case (WKT/PROJJSON values). The backward footer scan can also match a balanced `{...}` fragment *inside* a binary blob's JSON-encoded values. |
| RP-3 | MINOR | **All read errors report "no metadata."** `src/engine/read.ts:191-194` swallows every exception into the pedagogical failure message. Related crash source: `src/engine/elements.ts:26` throws `RangeError` on fractional element counts, reachable via `deinterleaveRow`'s short tail slice (`read.ts:407-410`). |
| RP-4 | MINOR | **Reader config leakage; magic never verified.** `usePipeline.ts:221` passes `state.write.magicNumber` into `readFile`; `stripMagic` (`read.ts:219-225`) blindly removes that many bytes from both ends without comparing. The extension spec says the reader operates only on file contents. Also misses the pedagogical "verify the magic" lesson. |

### 1.4 State & wiring

| ID | Severity | Finding |
|----|----------|---------|
| SW-1 | MAJOR | **`fieldPipelines` keyed by mutable, non-unique variable name** (`src/types/state.ts:35`; `useAppState.ts:110,119,131-134`). Verified failure paths: (a) adding two unnamed variables wipes the first's codecs (`draft.fieldPipelines[''] = []`); (b) renaming A to existing B's name overwrites B's pipeline, renaming away deletes it; (c) `usePipeline.ts:57-58,71` also keys values and traceIds by name, so duplicate names show one variable's data in two columns. |
| SW-2 | MAJOR | **Default right pane is the Read failure state with a lying dropdown.** `rightPaneStage: -1` (`src/types/state.ts:102`); `StagePane.tsx:75` resolves -1 → last stage (Read) for rendering but passes raw -1 to `<select value>` (:182), which matches no option so the browser shows "Values". Verified live. Side effect: selecting "Values" (already displayed) fires no change event. Design says default right = **Write**; -1 pointed at Write before the Read stage was appended. |
| SW-3 | MAJOR | **Monolithic pipeline memo.** `usePipeline.ts:262-276` — one `useMemo` spans generation → typing → chunking → codecs → metadata → write → read. Typing a character in a metadata field or the magic input re-runs everything and reallocates one `ByteTrace` object **per byte per stage** (~1.7M objects/keystroke at the warned 10K-element limit). Violates the design's explicit memoization requirement. |
| SW-4 | MINOR | **Side effects in the reducer.** `SET_DATA_MODEL` (`useAppState.ts:50-58`) calls `saveState`/`loadState` inside the reducer; StrictMode double-invokes reducers (idempotent today, fragile). Loaded state's `dataModel` is trusted, not forced to `action.model`. |
| SW-5 | MINOR | **Last-active data model not restored on reload.** `getInitialState` (`useAppState.ts:228-231`) always loads tabular. |
| SW-6 | MINOR | **Persisted pane-stage indices don't survive stage-list changes.** The stage list grew twice (Typed, Read); an old save's `rightPaneStage: 4` (then Write) now shows Metadata. Symptom of persisting stage indices; stage *names* are robust. |
| SW-7 | MINOR | **Shuffle `elementSize` not auto-defaulted to input dtype size and goes stale on dtype change.** `CodecPipelineEditor.tsx:74-82` uses the static default (4) despite receiving `inputDtype`; `UPDATE_VARIABLE` never touches codec params. Design: "auto-defaulted." No warning surfaces the mismatch either (see UI-4). |
| SW-8 | MINOR | **Dead state/actions.** `ui.sidebarWidth`, `ui.leftPaneRatio` (`state.ts:53-54,105-106`) never read/written (panel layout persists via `useDefaultLayout`'s own storage); `LOAD_STATE` action never dispatched. |
| SW-9 | MINOR | **No debounce flush on `beforeunload`** — edits in the last 500ms before tab close are lost. |
| SW-10 | MINOR | **Inconsistent stage identity.** `StagePane.tsx:77-80` resolves Values/Typed by index, Read/Write by name; strip/hover bar use names; persistence uses indices. The split convention is what produced SW-2 and SW-6. |

### 1.5 UI components

| ID | Severity | Finding |
|----|----------|---------|
| UI-1 | MAJOR | **Last hex row misaligns the ASCII column** (CLAUDE.md pitfall 6). `HexRowRenderer.tsx:63-104` — padding columns render 3 chars but the `.reduce` separator (:98-104) also inserts separators after them, so padding columns occupy 4-5 chars vs 3 for real bytes. Any stage byte count not a multiple of 16 shifts the final row's ASCII column right, plus a doubled mid-row gap. |
| UI-2 | MAJOR | **Cross-pane chunk linking broken from Hex/Flat views of Values/Typed/Read stages.** `traceChunkMap` is plumbed into HexView (:20), WriteHexView (:161), FlatView (:33) and explicitly discarded (ESLint-confirmed unused). Those stages' traces have `chunkId: ''` (`usePipeline.ts:81,124,246`), so hovering a Typed hex byte highlights nothing in an Encoded (post-RLE) pane and the HoverBar omits later byte counts. TableView/GridView work because they use the map (`TableView.tsx:219`). The unused prop is exactly the missing fix. |
| UI-3 | MAJOR | **Chunk-level traceIds parsed as element coordinates.** `TableView.tsx:72-83` splits traceId on `:` without checking `isChunkLevelTrace`; `chunk:1` parses as coords `[1]` → auto-scrolls to row 1 instead of the chunk's first element. The chunk fallback at :94-102 is unreachable because parsing "succeeds". |
| UI-4 | MAJOR | **Codec applicability warnings can never fire.** Every codec declares `applicableTo: () => true` (`src/engine/codecs.ts:18,78,137,185`), so the spec'd ⚠ icon system (`CodecPipelineEditor.tsx:105`) is dead code. The pipeline-strip warning icon from the same spec section is also unimplemented. |
| UI-5 | MAJOR | **O(n²) diff computation in GridView.** `GridView.tsx:216-218` recomputes `maxAbsDiff` with a full reduce **per cell**, unmemoized; hover re-renders make a 100×100 diff grid ~10⁸ ops/render. Also `values[j]` shorter than `origVarVals` → `NaN` → invalid `rgb(NaN,…)` colors. |
| UI-6 | MAJOR | **View-mode lists deviate from spec.** `StagePane.tsx:12-37` — Linearized/Encoded/Write panes are hex-only (spec requires Hex **and Flat** for all non-Values stages); `VALUES_VIEW_MODES` omits Hex; `READ_VIEW_MODES` omits hex and flat (extension doc implies they exist). |
| UI-7 | MAJOR | **Metadata sidebar double-counts custom entries and understates real size.** `MetadataEditor.tsx:37-42` concatenates custom entries onto `collectMetadata()`'s output which already includes them (`engine/metadata.ts:87-92`); preview omits `chunk_index`, so shown size never matches what Write embeds. Also unmemoized — serializes on every sidebar render. |
| UI-8 | MINOR | **Stale `selectedVarIdx` after variable removal in GridView** (:63-66) — data falls back to `variables[0]` but no tab renders active; heatmap silently shows a different variable than the highlighted tab. |
| UI-9 | MINOR | **Engine work inline in App.tsx** (:22-42) — `originalValues` re-decodes Values-stage bytes that `computePipelineStages` had as plain arrays (`variableValues`). Third copy of the byte-layout decoder (others: `TableView.tsx:40-56,271-282`; `GridView.tsx:79-102,250-258`). |
| UI-10 | MINOR | **Dead code**: `fileToStage` (`viewerUtils.ts:173`); `void (isValueHovered \|\| isChunkHovered)` (`FlatView.tsx:112`); `FileData.chunkRegions` (`WriteHexView.tsx:25`) stored never read. |
| UI-11 | MINOR | **Byte-size formatting ×4**: `viewerUtils.formatFileSize`, `FileExplorer.tsx:8`, `PipelineStrip.tsx:4`, `HoverBar.tsx:12`. |
| UI-12 | MINOR | **Theme token misuse**: `colors.paneAccentRight` used as the warning color in SchemaEditor:133,190, ChunkConfig:57, WriteConfig:65, MetadataEditor:106, CodecSection:95; success/error hardcoded as `'#98c379'`/`'#e06c75'` in PipelineStrip:77, ReadStatus:16,43, StagePane:133, TypeAssignConfig:131. |
| UI-13 | MINOR | **Zero `data-testid` attributes exist in `src/`** despite CLAUDE.md mandating conventions. The project's own Playwright strategy is untargetable (the smoke test had to select by text/structure). |
| UI-14 | MINOR | **Diff correctness edges**: `val !== origVal` (`TableView.tsx:224`) flags NaN↔NaN as a diff; GridView diff tooltip (:223) shows unformatted values; neither view implements the spec'd per-variable summary stats (count / max / mean abs error). |
| UI-15 | MINOR | **`computeRunningDtype` re-implements the engine dtype-flow rule** (`CodecPipelineEditor.tsx:34-46`) instead of deriving from the registry — silently wrong the day a dtype-changing codec is added. Param inputs use `parseFloat(v) \|\| 0` (:180), so clearing a field sets 0 even when min is 1. |
| UI-16 | MINOR | **HoverBar renders empty labels for structural traces** (`HoverBar.tsx:110-113`) — `magic:start`/`metadata` traces have `variableName: ''` → blank label/colorless dot. |
| UI-17 | MINOR | **Sidebar min is 15%** (`App.tsx:50`), not the spec's ~200px — at 900px window the sidebar shrinks to 135px and config rows wrap badly. |
| UI-18 | MINOR | **WriteHexView multi-file sticky headers all stick at `top: 0`** (:87) — previous headers stack beneath the current one; works visually only by accident of opacity/height. File sections keyed by index. |
| UI-19 | MINOR | **GridView hover uses `querySelector('[data-cell-idx]')`** (:124) — the DOM-ref pattern CLAUDE.md pitfall 2 warns against; works only because GridView is not virtualized; silently fails past the 10K cap. |

### 1.6 Dead code masking design gaps

- `trace.ts:23-40` (size-changing dtype trace propagation) and `typeAssign.ts:119-140`
  (`reverseTypeAssignment`) are unreachable — no dtype-changing codecs exist anymore, and
  `read.ts:161-184` re-implements the reversal inline instead of calling the export.
- Metadata omits `chunkOrder` and `partitioning`; recoverable in principle from `chunk_index`
  coords / file count, but the reader ignores coords (DC-1).

### 1.7 Test coverage gaps (behaviors with zero coverage)

1. **Read round-trip with any codec in the pipeline** — every `read.test.ts` round-trip uses
   empty pipelines. The headline feature is untested end-to-end.
2. Any ≥2-D multi-chunk read; column-major `chunkOrder` round-trip; per-chunk mode with 2-D coords.
3. Delta on unsigned dtypes, decreasing values, near-range values, order=3, empty input.
4. Binary metadata with footer or sidecar placement.
5. Invalid magic-number input (odd length, non-hex) through the pipeline.
6. Adversarial custom metadata: braces in values, keys shadowing auto keys, unicode through read.
7. float64 `keepBits` (only float32 tested); NaN inputs to `assignType`.
8. LZ back-references with offset > 255; LZ output-larger-than-input case.
9. Shuffle with `elementSize` ≠ dtype size (the intentional "garbled" lesson) round-trip.
10. `src/state/persistence.ts` has **zero tests**: no migration, corrupt-JSON, missing-field,
    or per-model-key tests — despite holding the app's only migration logic.
11. `reducer.test.ts` omits `SET_DATA_MODEL`, `LOAD_STATE`, duplicate-name and rename-collision cases.
12. Degenerate engine inputs: zero variables, `shape []`, `chunkShape [0]`.

### 1.8 Complexity assessment

Where the ~11K lines are overweight:

- **`read.ts` (500 lines): simultaneously overbuilt and under-functional.** Three redundant
  chunk-location strategies (chunk_index — ignored; filename parsing — buggy; raw-offset
  fallback) plus heuristic metadata scanning (brace counting, `count < 1000` guessing).
  Trusting `chunk_index` (which already carries `coords`/`offset`/`size`) as the single source
  and reassembling via coords deletes ~150 lines and fixes DC-1/DC-3 together.
- **Duplication**: `concatBytes` ×4 (`linearize.ts:101`, `read.ts:491`, `write.ts` inline,
  `usePipeline.ts:19`); `hexToBytes` ×2 with conflicting semantics (write throws, read
  tolerates — directly implicated in CR-1); byte-layout→values decoding ×3 (UI-9); traceId
  construction/parsing ×5 (`usePipeline.ts` ×3, `TableView.tsx`, `GridView.tsx`); byte-size
  formatting ×4 (UI-11); metadata-trace builders ×2 (`write.ts:289`, `usePipeline.ts:201`);
  scale/offset reversal ×2 (dead export + inline copy); WriteHexView re-implements ~200 lines
  of HexView; ~30-line Values/Read trace-building blocks duplicated in `usePipeline.ts`
  (:62-89 vs :224-253); 6 near-identical `inputStyle` constants across config files.
- **Reducer**: 24 actions, ~15 of which are one-field setters wrapped in `produce`.
- **Right-sized as-is**: `generate`, `elements`, `chunk`, `linearize`, `trace`, `metadata`
  engine modules; StagePane, Sidebar, CodecSection, Radio, config editors, PipelineStrip,
  HoverBar. The debt is concentrated in `read.ts`, `viewers/`, and App-level plumbing.

Estimated removable duplication: **500–700 lines**.

### 1.9 Spec/docs divergence

- Scale/offset and bitround were removed as codecs (the `mapping` category is gone from
  `types/codecs.ts:14`; `codecs.test.ts:27` asserts their absence) and folded into the Type
  Assignment stage (`logicalType` + `typeAssignment` on `Variable`, a "Typed" pipeline stage).
  `docs/design.md` and `CLAUDE.md` still describe the old model.
- The extension spec's `lossy: boolean` on `CodecDefinition` was never implemented (why DC-2
  goes unflagged).
- The stage list is now 7 stages (Values, Typed, Linearized, Encoded, Metadata, Write, Read);
  the design doc describes neither Typed nor the exact list.

### 1.10 Verified working (do not "fix")

- Hover state keyed by traceId/data indices, not DOM refs (except GridView, UI-19).
- Interleave column↔row preserves per-field pipelines; CodecSection swaps editors with the
  mixed-dtype callout.
- Shape dimensionality changes clamp/pad chunkShape correctly.
- Chunk-level trace degradation after entropy codecs (engine + HoverBar).
- Hex alignment for full rows; 16 bytes/row with mid-gap and ASCII column.
- Resizable panels, 100vh layout, no overflow at 1600×950 / 1100×700 / 800×600.
- Debounced 500ms persistence; per-model storage slots.
- Codec add/reorder/remove with correct dtype-flow annotations; multi-file per-chunk write view.
- Diff view flags lossy float32 type assignments.

### 1.11 Post-review findings (discovered during phase execution)

| ID | Severity | Finding | Status |
|----|----------|---------|--------|
| NF-1 | MAJOR | **Phase 0's persistence fallbacks aliased `DEFAULT_STATE`.** `validateState`'s invalid-shape fallback shallow-spread `DEFAULT_STATE`, and `deepMergeDefaults`' dict-key/missing-field branches returned default values by reference — mutating a loaded state could permanently corrupt the compiled-in defaults for the session (verified: pushing to a loaded `variables` array grew `DEFAULT_STATE.variables`). | **Fixed in Phase 1** (`structuredClone` at all three fallback sites; regression tests in `persistence.test.ts`). |
| NF-2 | MINOR | **NaN poisons `assignType` min/max tracking silently.** Comparisons with NaN are always false, so `min`/`max` stay at their ±Infinity sentinels while `mean` goes NaN — `variable_statistics` metadata is corrupt for any NaN-bearing dataset. `src/engine/typeAssign.ts` stats loop. | `it.fails` in `typeassign-edges.test.ts`; fix in task 2.14. |
| NF-3 | MINOR | **NaN spuriously flagged as "rounded" for float dtypes.** `readBack[i] !== expected` is always true for NaN↔NaN, so losslessly-stored NaN marks the variable lossy. | `it.fails` in `typeassign-edges.test.ts`; fix in task 2.14. |
| NF-4 | MINOR | **NaN silently becomes 0 for integer storage dtypes.** `DataView.setInt32(NaN)` stores 0 without error — indistinguishable from a real zero, with no signal of what happened. | `it.fails` in `typeassign-edges.test.ts`; fix in task 2.14. |

---

## Part 2: Pinned Design Decisions & Interface Contracts

These decisions are settled (with the project owner, 2026-07-01). Implement as written; cite
the decision ID in commit messages. They exist so that independent implementers/agents cannot
make divergent choices.

### D1 — Footer discovery is a user-facing format choice

New Write option `footerLocator: 'trailer' | 'none'` (default `'trailer'`), shown in the Write
sidebar section only when `metadataPlacement === 'footer'`. This follows the tool's philosophy:
the user makes the format decision and the Read step shows the consequence.

- **`trailer`**: file layout is `[magic][chunks][metadata][u32 LE metadata-length][magic]`
  (Parquet-style — Parquet is literally `[footer][len]['PAR1']`; say so in the UI help text).
  Reader seeks to `end − magicLen − 4`, reads the length, slices the metadata exactly. Works
  identically for JSON and binary serialization.
- **`none`**: layout stays `[magic][chunks][metadata][magic]`. The reader falls back to
  best-effort backward scanning (JSON: string-literal-aware brace scan; binary: entry-count
  plausibility scan). Scanning MAY fail — that is the lesson, not a bug. On failure the read
  reports reason `metadata-not-found` (D4) with a message explaining why real formats use a
  length trailer, naming the Footer locator option.
- The scanner is kept honest but deliberately best-effort: fix RP-2 (string-aware), add the
  binary backward scan, and stop there. No further heuristics.

### D2 — The reader knows the format's magic number

`readFile(files, formatSpec: { magic: Uint8Array })`. The configured magic is the "format
definition" the reader was built for — exactly as a Parquet reader knows `PAR1` or a TIFF
reader knows `II*\0`. The reader **verifies** the leading magic (and the trailing magic when
D1's trailer applies); a mismatch is failure reason `bad-magic`: "File does not begin with the
expected magic number — this reader only understands files it was built for." This
deliberately supersedes the extension doc's "reader has no config access" *for magic only*;
document the rationale in design.md (task 4.8). The blind `stripMagic` is deleted.

### D3 — Chunk index is a user-facing metadata choice

New Metadata option `includeChunkIndex: boolean` (default `true`) in the Metadata sidebar
section.

- **`true`**: current behavior — `chunk_index` entries with `coords`/`offset`/`size`.
- **`false`**: `chunk_index` is omitted from metadata. The reader attempts **computed
  offsets**, possible only when every codec pipeline is size-preserving (delta, shuffle — NOT
  rle/lz), so encoded chunk sizes are derivable from chunkShape × dtype. With any size-changing
  codec present, read fails with reason `no-chunk-index`: "The chunks have variable size after
  compression and nothing in the file records where each one starts. Re-enable the chunk index,
  or remove the size-changing codecs." This is arguably the tool's best lesson: *why* indexes
  exist.
- Reassembly (task 2.1) always keys on chunk coords — taken from index entries when present,
  else from the computed row-major layout.

### D4 — Read failure taxonomy

```typescript
type ReadFailureReason =
  | 'no-metadata'        // metadata genuinely absent (includeMetadata = false)
  | 'metadata-not-found' // metadata present but the locator/scanner failed (D1 'none')
  | 'bad-magic'          // magic mismatch (D2)
  | 'corrupt-metadata'   // located but failed to parse
  | 'no-chunk-index'     // variable-size chunks with no index (D3)
  | 'decode-error';      // codec reversal / deinterleave / reassembly failed

// ReadFileResult failure shape:
{ success: false; reason: ReadFailureReason; message: string; byteCount: number }
```

Each reason has its own educational message; only `no-metadata` keeps the existing
"enable Include metadata" text. `ReadStatus` and the pane failure display render
`message` verbatim.

### D5 — State schema additions & keying (final shape)

```typescript
write.footerLocator: 'trailer' | 'none';        // Phase 2 — default 'trailer'
metadata.includeChunkIndex: boolean;             // Phase 2 — default true
fieldPipelines: Record<string, CodecStep[]>;     // Phase 3.1 — keyed by Variable.id
ui.leftPaneStage: StageName;                     // Phase 3.8 — names, not indices
ui.rightPaneStage: StageName;                    //   default: 'write' (fixes SW-2)

type StageName = 'values' | 'typed' | 'linearized' | 'encoded'
               | 'metadata' | 'write' | 'read';  // fixed order; single source of truth
```

Migrations (all through the Phase 0.4 validate/merge loader): missing new fields → defaults;
old numeric pane-stage indices → map via the fixed order above, out-of-range → default;
name-keyed `fieldPipelines` → re-key by matching `Variable.name → Variable.id`, dropping
unmatched keys.

### D6 — Post-Phase-3 `PipelineResult` contract

```typescript
interface PipelineResult {
  stages: PipelineStage[];                 // fixed order per StageName
  files: VirtualFile[];
  chunkTraceMap: Map<string, Set<string>>;
  traceChunkMap: Map<string, string>;
  readResult: ReadFileResult;
  variableStats: Map<string, VariableStats>;
  logicalValues: Map<string, number[]>;    // NEW — Values-stage source arrays
  typedValues: Map<string, number[]>;      // NEW — Typed-stage source arrays
}
```

Viewers consume `logicalValues` / `typedValues` / `readResult.reconstructedValues` and are
**forbidden** from decoding stage bytes themselves (deletes the three byte-slicing copies).

### D7 — Byte utilities module (`src/engine/bytes.ts`)

```typescript
concatBytes(arrays: Uint8Array[]): Uint8Array;
hexToBytes(hex: string): Uint8Array;  // tolerant: strips non-hex chars, drops trailing nibble
bytesToHex(bytes: Uint8Array): string;
formatByteCount(n: number): string;   // "1.5 KB" — the single formatting authority
```

Replaces all 4 `concatBytes` copies, both `hexToBytes` variants, and all 4 size formatters.

### D8 — TraceId helpers (in `src/engine/trace.ts`)

```typescript
makeTraceId(variableName: string, coords: number[]): string;  // `${name}:${coords.join(',')}`
makeChunkTraceId(chunkId: string): string;                    // `chunk:${chunkId}`
parseTraceId(id: string):
  | { kind: 'value'; variableName: string; coords: number[] }
  | { kind: 'chunk'; chunkId: string };
```

All construction and parsing goes through these (5 inline copies today). `isChunkLevelTrace`
remains and is implemented via `parseTraceId`.

### D9 — Generation modes (Phase 6.1)

`LogicalTypeConfig.generation: 'random' | 'smooth' | 'sorted' | 'stepped'`. All modes are
deterministic from the existing seed scheme (variable name + global seed) and post-processed
by the logicalType's rounding rules.

- **`random`**: current uniform behavior (kept as the "why won't this compress?" contrast case).
- **`smooth`**: random walk — `v[0] = (min+max)/2`; `v[i] = clamp(v[i-1] + (rng()−0.5) × (max−min)/16, min, max)`.
- **`sorted`**: draw n uniform positives, prefix-sum, rescale to `[min, max]` (monotonic non-decreasing).
- **`stepped`**: `k = max(3, floor(n/8))` segments with PRNG-chosen boundaries; each segment a
  single uniform-random constant.

Starter-variable defaults: temperature → `smooth`, pressure → `sorted`, humidity → `stepped`.
Migration: missing `generation` → `'random'`. Required tests (compressibility signatures):
sorted + delta + RLE shrinks vs raw; stepped + RLE shrinks; random + RLE inflates (warning path).

### D10 — Presets (Phase 6.2)

Built-ins are checked-in JSON files at `src/presets/*.json` conforming to the persisted
`AppState` shape, loaded through the Phase 0.4 validate/merge loader — they double as loader
regression fixtures. Custom slot at localStorage key `0x00c0dec5-preset-custom`; loading any
built-in first snapshots current state to the custom slot. Presets never touch the other data
model's saved state.

---

## Part 3: Implementation Plan

Seven phases: 0–4 reach *fully functional* (the v1 + read-extension spec, working correctly);
Phase 5 is optional performance headroom; Phase 6 reaches *compelling* (the Talk Workflow the
design doc describes). Each is a coherent, shippable unit sized for one focused session.

**Cardinal rule (unchanged from CLAUDE.md): engine fixes get failing tests first, then the fix,
then green.**

### Agent execution playbook

How to run these phases with subagents (Sonnet-class is sufficient everywhere except where a
phase's Execution note says otherwise):

1. **Locate by symbol, never by line number** (see the Part 1 note — references are pinned to
   commit `4d09954`).
2. **Engine tasks**: failing test → fix → green, per task. **UI tasks**: implement → Playwright
   scenario → look at the screenshot.
3. **Implementer ≠ verifier.** Every phase ends with an independent review pass that re-runs
   the gates and reads the diff against this document's acceptance criteria. The implementer's
   own green report is not acceptance.
4. **Phase gate (run all of it, every phase):**
   ```bash
   npx vitest run
   npx tsc --noEmit -p tsconfig.app.json
   npm run dev &   # then: node tests/ui/scenario-*.mjs ; kill the server
   ```
5. **Parallelism**: each phase carries an *Execution* note marking parallel-safe task groups
   (disjoint files) vs serial chains (shared interfaces). Parallel agents that mutate files
   need worktree isolation. Phase 3 is the interface reshuffle — run it serially (one agent or
   the main loop); do not fan it out.
6. **Ambiguity rule**: anything not covered by a task description or a decision ID gets
   surfaced, not improvised.

### Phase 0 — Stop the crashes

Small, immediate, no behavioral redesign. After this phase, no user input or stale storage can
blank or hang the app.

- [x] **0.1 Add an ErrorBoundary.** New `src/components/shared/ErrorBoundary.tsx`; wrap
      `MainLayout` in `App.tsx`. Render the error message + a "Reset saved state" button that
      clears both storage keys and reloads. (Addresses the *symptom* class of CR-1/CR-3.)
- [x] **0.2 Unify `hexToBytes`.** Single tolerant implementation in `src/engine/elements.ts`
      (or new `src/engine/bytes.ts`, see 3.6): strips non-hex chars, tolerates odd length
      (ignore trailing nibble), returns `Uint8Array`. Replace `write.ts:8-16` and
      `read.ts:209-217`. `WriteConfig.tsx` keeps its warning-border UX for invalid input;
      add inline warning for non-hex chars (Bug CR-1 note). Tests: odd length, non-hex,
      empty, mixed case. Fixes CR-1.
- [x] **0.3 Fix GridView hooks order.** Move the `!selectedVar` early return *below* all hook
      calls in `GridView.tsx` (hooks tolerate empty inputs; return early only at render time).
      While there, fix the stale `selectedVarIdx` fallback (UI-8): clamp
      `selectedVarIdx` to `variables.length - 1` in an effect or derive it. Fixes CR-2.
- [x] **0.4 Validate + default-merge persisted state.** In `persistence.ts`: after parse and
      migrate, deep-merge over `DEFAULT_STATE` (missing fields get defaults), then validate
      structurally (variables is array with required fields; shape/chunkShape are arrays of
      positive ints with matching length — clamp/pad chunkShape like `SET_SHAPE` does; pane
      stage indices within range or reset). Return `null` (→ defaults) on anything
      unrecoverable. Fixes CR-3, SW-6's crash variant, and the `undefined`-field class.
- [x] **0.5 Guard `SET_CHUNK_SHAPE`** in the reducer: reject empty/non-positive/wrong-length
      chunk shapes (mirror `SET_SHAPE`). Fixes CR-4.
- [x] **0.6 Tests**: new `src/__tests__/state/persistence.test.ts` (corrupt JSON, v1
      dtype-variable migration, missing `write.includeMetadata`/`ui.showDiff`, wrong-length
      chunkShape, per-model keys, out-of-range pane stages); reducer cases for invalid chunk
      shape.

**Execution**: 0.1, 0.2, 0.3 are parallel-safe (disjoint files). 0.4 → 0.5 → 0.6 run as one
serial unit (shared persistence/reducer surface).

**Acceptance gate**: full test suite green including `persistence.test.ts`; a Playwright
script that types `ZZZ` then `0` into the magic field, seeds legacy-shaped localStorage and
reloads, and sets `chunkShape [0]` via storage — no blank screen, no hang, ErrorBoundary
never rendered for these inputs (it exists but these paths are handled before it).

### Phase 1 — Make the test suite honest

Write the missing tests **before** fixing engine bugs, so DC-1, DC-2, DC-3, RP-1, RP-2 are
captured as failing tests (mark with `.fails` or `todo` until Phase 2 lands, so CI stays
meaningful). This inverts the current situation where 314 green tests certify a broken app.

- [x] **1.1 End-to-end round-trip matrix** (new `src/__tests__/engine/roundtrip.matrix.test.ts`):
      programmatically run generate → typeAssign → chunk → linearize → encode → metadata →
      write → read → compare across the matrix:
      - shapes: `[7]`, `[4,4]`, `[3,5]` (non-square, non-power-of-2)
      - chunkShapes: full-shape, `[2,2]`, `[3,3]` (non-dividing → ragged edge chunks)
      - interleaving: column, row
      - codec pipelines: empty, `[delta]`, `[shuffle]`, `[delta, shuffle, rle]`, `[lz]`
      - dtypes: at least one uint (humidity default), one float32, one float64 variable
      - metadata: JSON/binary × header/footer/sidecar; chunkOrder row/column-major;
        partitioning single/per-chunk
      - footer locator: trailer / none (D1 — `none` × binary asserts the *expected failure
        reason* `metadata-not-found` when scanning legitimately can't find it)
      - chunk index: on / off (D3 — off × size-preserving pipeline round-trips; off × RLE
        asserts failure reason `no-chunk-index`)
      The last two axes target Phase 2 state fields — write these tests against the D1/D3/D4
      contracts and mark them `.fails`/`todo` until Phase 2 lands.
      Don't run the full cross-product (~thousands); cover each axis against a base config
      plus ~10 hand-picked nasty combinations. Assert exact equality for lossless configs,
      bounded error for lossy ones, and that `lossyVariables` is truthful.
- [x] **1.2 Targeted engine gap tests**: delta unsigned/decreasing/near-range/order-3/empty;
      float64 keepBits 19/20/21; LZ offset > 255 and incompressible input; shuffle with
      mismatched elementSize round-trip; NaN through `assignType`; custom metadata with
      braces-in-values, auto-key shadowing, unicode keys through **read** (not just the
      serializer); magic number odd/non-hex/empty through the pipeline.
- [x] **1.3 Reducer/persistence gap tests**: `SET_DATA_MODEL` (with mocked storage),
      duplicate variable names, rename-to-collision (captures SW-1 as failing).
- [x] **1.4 Add `data-testid` attributes** per CLAUDE.md conventions to: viewer containers,
      table cells, hex bytes, hover bar, pipeline stage nodes, pane containers + dropdowns,
      view-mode radios, sidebar sections, codec steps + warning icons. (UI-13)
- [x] **1.5 Promote the smoke test to a regression harness.** The review left scripts in
      `tests/ui/smoke*.mjs` and screenshots in `tests/ui/screenshots/`. Rework them onto the
      new testids as named scenario files — `tests/ui/scenario-crash-inputs.mjs`,
      `scenario-placement-matrix.mjs`, `scenario-hover-linking.mjs`,
      `scenario-pane-defaults.mjs` — and document the run command in CLAUDE.md. Add
      `tests/ui/screenshots/` to `.gitignore`.

**Execution**: all tasks parallel-safe (disjoint test files), EXCEPT 1.4 (touches most
components) — run 1.4 alone, then 1.5 after it.

**Acceptance gate**: the new engine tests fail exactly where Part 1 predicts (DC-1/2/3,
RP-1/2, SW-1) and pass elsewhere — a new failure *not* predicted by Part 1 is a finding to
add, not to silence; the four scenario scripts run green against Phase 0's build except for
items explicitly marked Phase 2+.

### Phase 2 — Fix the read path by simplifying it

The theme: `read.ts` gets *smaller* and correct at the same time. Target ≤ ~350 lines.

- [x] **2.1 Rewrite chunk reassembly around `chunk_index` as the single source of truth.**
      The index already carries `coords`, `offset`, `size` per chunk (and per-variable info in
      column mode). Reassemble by mapping each decoded chunk element to its global position
      derived from `coords` × `chunkShape` × `shape` (chunk-local row-major → global row-major).
      Delete the filename-number sort (`extractChunkIndexFromName`) and the raw-offset
      fallback; per-chunk mode matches files to index entries by name/coords. Fixes DC-1, DC-3.
- [x] **2.2 Add `chunkOrder` and `partitioning` to auto-collected metadata**
      (`engine/metadata.ts`) so the reader needs no inference. (§1.6)
- [x] **2.3 Footer locator option (D1).** Add `write.footerLocator` to state (+ reducer patch
      action, default via the 0.4 loader), the Write-sidebar control (visible only when
      placement=footer, with the Parquet comparison in its help text), the trailer emit in
      `write.ts`, and the trailer read path in `read.ts`. Fixes RP-1 for the trailer path.
- [x] **2.4 Best-effort scanner as the `none` fallback (D1).** String-literal-aware brace
      scanning for JSON (fixes RP-2's false positive); backward entry-count plausibility scan
      for binary; on failure, reason `metadata-not-found` with the trailer-lesson message.
      No further heuristics — fragility here is intentional and documented.
- [x] **2.5 Remove the delta clamp** in encode and decode (`codecs.ts:33-39,56-62`) — let
      typed-array wrap-around provide exact modular round-trips. Keep float delta as-is but
      flag it (2.6). Fixes DC-2.
- [x] **2.6 Implement `lossy` on `CodecDefinition`** per the extension spec; mark float-dtype
      delta lossy-capable; surface codec lossiness in `readResult.lossyVariables` alongside
      typeAssign lossiness. Fixes the "diff view lies" half of DC-2.
- [x] **2.7 Fix keepBits=20 mask** (`typeAssign.ts:156-157`, boundary `>= 20` → `> 20`). DC-6.
- [x] **2.8 Verified write-offset convergence.** Replace the three copy-pasted passes
      (`write.ts:104-141`) with a bounded loop (max ~6) that exits only when serialized
      length is stable; if unstable, pad metadata with whitespace (JSON) to a stable length.
      Fixes DC-4.
- [x] **2.9 Differentiated read errors (D4).** Implement the `ReadFailureReason` taxonomy
      exactly as specified in D4; `ReadStatus` and the pane failure display render each
      reason's message. Guard the fractional-count `RangeError` (`bytesToValues` in
      `elements.ts`) so it surfaces as `decode-error`, not an exception. Fixes RP-3.
- [x] **2.10 Magic verification (D2).** `readFile(files, formatSpec: { magic })`; verify
      leading (and, with a trailer, trailing) magic; mismatch → `bad-magic`. Delete the blind
      `stripMagic`. Fixes RP-4 and adds the missing lesson.
- [x] **2.11 Warn on custom-metadata key shadowing** (`metadata.ts`): custom entries that
      collide with auto keys get a warning in MetadataEditor and are suffixed or rejected at
      serialization. Fixes DC-5.
- [x] **2.12 Delete dead code**: `reverseTypeAssignment` inline copy (call the export from
      `read.ts` or delete the export), the unreachable size-changing trace propagation in
      `trace.ts` if still unreachable.
- [x] **2.14 NaN handling in `assignType` (NF-2/3/4).** Track min/max with NaN-aware
      comparisons (skip NaN, count it separately); use `Number.isNaN`-aware comparison for
      rounded-detection so float-stored NaN isn't flagged lossy; count NaN→0 integer-storage
      conversions explicitly in `VariableStats` (`nanCount`) so the UI can surface it. Flip
      the three `it.fails` in `typeassign-edges.test.ts`.
- [x] **2.13 Chunk index toggle (D3).** Add `metadata.includeChunkIndex` to state (+ reducer
      patch action, default via the 0.4 loader) and the Metadata-sidebar control; omit
      `chunk_index` from collected metadata when off; implement the computed-offsets fallback
      in `read.ts` (size-preserving pipelines only — determine from the metadata's codec
      specs, not app config); size-changing codec present → `no-chunk-index` failure with the
      why-indexes-exist message.

**Execution**: serial chain on `read.ts`/`write.ts`: 2.1 → 2.2 → 2.13 → 2.3 → 2.4 → 2.9 →
2.10. Parallel-safe alongside that chain: {2.5+2.6} (codecs + lossy flag), {2.7+2.14} (typeAssign),
{2.8} (write convergence — coordinate with the chain owner), {2.11} (metadata editor), {2.12}.

**Acceptance gate**: the Phase 1 matrix passes fully, including the D1/D3 axes — every
lossless config round-trips exactly, every lossy config is flagged, all placement×format×
locator combos behave per contract (success or the *specified* failure reason), 2-D
multi-chunk and column-major order reconstruct exact values. `read.ts` ends at ≤ ~550 lines
with one chunk-location strategy (coords from index or computed layout). Playwright
`scenario-placement-matrix.mjs` extended with footerLocator and chunk-index cases, green.
*(Line target revised during execution — outcome: ~900 lines accepted. The original ~350
predates D1/D3 being added to scope; the trailer path, three honest scanners, and the
computed-chunk-index fallback are legitimate new logic. A dedicated behavior-preserving
simplification pass decomposed the 241-line `readFile` into a ~50-line pipeline over
locateMetadata → parseStructure → reconstruct and cut narration comments; what remains is
dense decision-reference material. The qualitative gate — ONE chunk-location strategy, no
heuristic soup, taxonomy visible at top level — is met; the number was its proxy.)*

### Phase 3 — Structural consolidation

Complexity reduction. No user-visible behavior change except performance; the test suite and
Playwright harness from Phase 1 are the safety net.

- [x] **3.1 Key `fieldPipelines` by variable `id` (D5).** Change `AppState.fieldPipelines` to
      id-keyed; delete the rename re-keying in `UPDATE_VARIABLE`; translate id→name only at
      metadata serialization. Persistence migration per D5. Fixes SW-1 wholesale.
- [x] **3.2 Split the pipeline memo.** Restructure `usePipeline` into chained `useMemo`s with
      real dependency boundaries: values(shape, variables·logicalType) → typed(+typeAssignment)
      → linearized(+chunkShape, interleaving) → encoded(+pipelines) → metadata(+metadata
      config) → files(+write config) → read(files). Metadata keystrokes must not re-run
      generation/chunking/encoding. Keep `computePipelineStages` as a pure composition of the
      same stage functions for tests. Fixes SW-3.
- [x] **3.3 Return value arrays from the pipeline (D6).** `PipelineResult` gains
      `logicalValues` and `typedValues` per the D6 contract. Delete the three byte-slicing
      decoders (in `App.tsx`, `TableView.tsx`, `GridView.tsx` — locate by the
      `bytesToValues`-over-stage-bytes pattern). Fixes UI-9 and removes the implicit layout
      contract.
- [x] **3.4 Centralize traceId handling (D8).** Implement the D8 helpers in
      `engine/trace.ts`; replace the five inline construction/parsing copies. Fixes UI-3 as a
      side effect (the parser handles chunk-level ids). Extract the duplicated Values/Read
      trace-building blocks in `usePipeline.ts` into one helper.
- [x] **3.5 Merge the hex views.** Extract `useHexStageData(bytes, traces, bytesPerRow)`;
      make `HexView` accept `sections: {header?, bytes, traces}[]` so `WriteHexView` becomes a
      thin wrapper (or disappears). Fix the sticky-header stacking (UI-18) and last-row
      padding (UI-1 — no separators after padding columns) in the one remaining renderer.
- [x] **3.6 One byte-utility module (D7)**: `src/engine/bytes.ts` per the D7 signatures.
      Replace the 4 `concatBytes` and 4 size-formatting copies. (With 0.2 this file may
      already exist.)
- [x] **3.7 Collapse the reducer.** Keep semantic actions (SET_SHAPE, variable CRUD,
      SET_DATA_MODEL); replace the ~15 one-field setters with `UPDATE_WRITE`/`UPDATE_UI`/
      `UPDATE_METADATA_CONFIG` patch actions. Move `SET_DATA_MODEL`'s storage I/O out of the
      reducer into a dispatch wrapper; force `dataModel` on the loaded state; store the
      active model in a third storage key and restore it in `getInitialState`. Delete dead
      `ui.sidebarWidth`/`leftPaneRatio` fields and the `LOAD_STATE` action. Fixes SW-4, SW-5, SW-8.
- [x] **3.8 Stage identity by name (D5).** Persist pane stages as `StageName`, resolve to
      index at render; migration maps old indices per D5; default `rightPaneStage: 'write'`
      lands here (or in 4.1 — whichever ships first; don't do it twice). `StagePane`
      view-mode selection keys off the name. Fixes SW-6, SW-10, and the fragility behind SW-2.
- [x] **3.9 Introduce a `PipelineContext`** carrying `stages`, `files`, `chunkTraceMap`,
      `traceChunkMap`, `readResult`, `originalValues`, `showDiff` — removing ~10 drilled
      props per pane. Viewers consume what they need.
- [x] **3.10 Shared `inputStyle`/control styles in `theme.ts`**; fix token misuse (UI-12):
      warning color from `colors.warning`, add `colors.success`/`colors.error` tokens.

**Execution**: SERIAL — this is the interface reshuffle. One agent (or the main loop), in
task order: 3.1 → 3.2 → 3.3 → 3.4, then 3.5–3.10 may interleave (3.9 depends on 3.3; 3.8
depends on nothing after 3.2). Do not fan this phase out to parallel agents.

**Acceptance gate**: all tests green, plus a new
`src/__tests__/hooks/usePipeline.memo.test.tsx` using `renderHook`: rerender with a changed
`metadata.customEntries` → assert `stages[valuesIdx].bytes` and `stages[linearizedIdx].bytes`
are the **same object references** (`===`) as before; rerender with a changed codec param →
chunk/linearize outputs referentially stable. Playwright harness green. Net LOC reduction in
`src/` of ≥ 400 lines (`git diff --stat` against the phase-start commit). Rename-to-collision
reducer test now passes (SW-1 closed).
*(LOC outcome, measured at completion: src/ excluding tests landed at net +155, not −400.
Every duplication target was eliminated — WriteHexView deleted (−281), formatters 4→1,
concatBytes 4→1, inputStyle 6→1, reducer setters 13→3, byte-slicing decoders 3→0 — but the
phase's own mandated additions (staged-memo split with exported pure stage functions,
PipelineContext, D5 stage-name + id-key migrations) are new infrastructure the estimate
didn't account for. The qualitative gate — zero remaining duplication targets, wiring that
fits in one head — is met; the number was its proxy.)*

### Phase 4 — Correctness polish + docs

- [x] **4.1 Fix the default right pane.** Replace `-1` sentinel: default `rightPaneStage` to
      `'write'` (per design) and bind the `<select>` to the resolved value. Fixes SW-2.
- [x] **4.2 Wire `traceChunkMap` into HexView/WriteHexView/FlatView** so hovering
      Values/Typed/Read hex bytes cross-highlights post-entropy panes and the HoverBar shows
      the full chain. Fixes UI-2.
- [x] **4.3 Real `applicableTo` predicates** (`engine/codecs.ts`): delta → numeric dtypes
      (warn on uint? no — wrap is now exact; warn on float), shuffle → warn when elementSize
      ≠ dtype size, bitround-equivalents live in typeAssign now, RLE/LZ → always applicable.
      Surface the ⚠ icon in `CodecPipelineEditor` (already built) and add it to the pipeline
      strip node per spec. Auto-default shuffle `elementSize` to the input dtype size on add
      (`CodecPipelineEditor.tsx:74-82` already receives `inputDtype`). Fixes UI-4, SW-7.
- [x] **4.4 View-mode lists per spec** (`StagePane.tsx:12-37`): Hex+Flat for all non-Values
      stages; Values gains Hex; Read gains Hex+Flat (diff applies only to Table/Grid). Fixes UI-6.
- [x] **4.5 GridView diff performance + correctness**: hoist `maxAbsDiff` into a `useMemo`
      keyed on values/originals; guard length mismatch (no NaN colors); `Object.is` for NaN
      diff equality in TableView; add the spec'd per-variable diff summary (count/max/mean
      abs error) to TableView header and GridView. Fixes UI-5, UI-14.
- [x] **4.6 MetadataEditor truthfulness**: stop double-appending custom entries; include
      `chunk_index` in the preview size (pass chunk offsets or show "≈ N B + chunk index");
      memoize the serialization. Fixes UI-7.
- [x] **4.7 Small fixes batch**: HoverBar labels for `magic`/`metadata` traces (UI-16);
      sidebar min-width in px via panel constraints (UI-17); `computeRunningDtype` derived
      from the registry, param inputs clamp to min instead of `|| 0` (UI-15); delete dead
      code (UI-10); GridView hover without querySelector (UI-19); debounce flush on
      `beforeunload` (SW-9); reader magic handling comment (RP-4 residue if any).
- [x] **4.8 Rewrite the docs to match reality.** `docs/design.md`: replace the codec-registry
      section (scale/offset + bitround → Type Assignment concept, logical types, the Typed
      stage, 7-stage list); update the AppState shape; update the Edge Cases table; document
      the new user-facing format choices and their read consequences (footer locator D1,
      reader-knows-magic rationale D2, chunk index D3). `CLAUDE.md`: update pitfalls
      (dtype-flow pitfall now lives in typeAssign + codecs), document the Playwright harness
      command, keep the testid conventions (now real). Add a short `docs/architecture.md`
      snapshot: stage functions, data flow, where each concern lives — the document you wish
      you'd had at the start of this review.

**Execution**: parallel groups — {4.1 + 4.4} (both edit StagePane), {4.2}, {4.3}, {4.5},
{4.6}, {4.7 as a single batch agent}; 4.8 runs last, serially, after all behavior has landed.

**Acceptance gate**: `scenario-pane-defaults.mjs` — fresh load shows Write in the right pane
with a truthful dropdown; `scenario-hover-linking.mjs` extended — hover from every view mode
of every stage cross-highlights in both directions, including hex→post-entropy;
`scenario-crash-inputs.mjs` still green; a codec-warning Playwright check (shuffle
elementSize≠dtype and float delta show ⚠ in the editor and the strip); docs describe the
shipped model (spot-check: design.md contains "Type Assignment", "footer locator",
"chunk index" toggles); full vitest + Playwright suites green.

### Phase 5 (optional) — Performance headroom

**SKIPPED (measured 2026-07-01)**: full `computePipelineStages` at the 10K-element warning
limit (3 variables, delta+shuffle+rle pipeline, metadata on) benchmarks at **~75ms**; with the
Phase 3.2 memo split, interactive edits recompute only a stage suffix. No user-visible jank at
the tool's design limits — the items below stay on file in case future features change the math.

Only if the tool still feels janky at large element counts after 3.2:

- [ ] Replace per-byte `ByteTrace` objects with columnar/interval representations
      (`traceIdRanges: {traceId, start, end}[]` per stage) — the single biggest allocation win.
- [ ] Move encode/read into a Web Worker if main-thread stalls persist at the 10K warning limit.

### Phase 6 — From functional to compelling

Phases 0–4 produce a *correct* app. This phase produces the app the design doc's Talk Workflow
actually needs. These are not bugs — they are missing substance, ordered by pedagogical leverage.

- [x] **6.1 Data generation modes (D9 — highest leverage, do this first).** Uniform random
      data is incompressible by construction: delta *widens* the distribution, RLE inflates,
      LZ finds no matches, entropy stays pinned near 8 bits/byte. The tool's core dramatic
      arc — watch structure get exploited into fewer bytes — cannot happen with the current
      generator (`src/engine/generate.ts`). Implement the four modes, algorithms,
      starter-variable defaults, migration, and compressibility-signature tests exactly per
      D9, plus a per-variable mode selector in SchemaEditor (with one-line descriptions —
      "smooth: like temperature over time").
- [x] **6.2 Presets (D10).** The Talk Workflow depends on them twice: recovery when audience
      choices go sideways, and the payoff moments ("what you just built is basically Parquet").
      Implement storage/loading per D10, with a Header dropdown UI. Built-ins:
      **"Basically Parquet"** (1-D, column-oriented, per-column codecs, footer metadata with
      the D1 trailer — the punchline writes itself), **"Basically GeoTIFF"** (2-D, tiled
      chunks, header metadata, CRS custom entries), **"Basically Zarr"** (2-D, per-chunk
      files, sidecar JSON metadata). Loading a built-in never destroys the custom slot.
- [x] **6.3 Export/download.** A "Download" button per file in the FileExplorer (Blob +
      object URL; zip via a tiny lib or sequential downloads for per-chunk mode). The audience
      watches bytes evolve and then *opens the actual file in a hex editor* — the credibility
      moment the whole tool builds toward. Small effort, disproportionate payoff.
- [x] **6.4 Checkpoint/restore (undo-lite).** Full undo/redo is v2; a live talk needs a safety
      net now. "Save checkpoint" / "Restore checkpoint" buttons (one slot, in-memory +
      localStorage). Combined with presets this covers demo recovery for ~10% of undo's cost.
- [x] **6.5 Shareable state URLs (optional).** Encode `AppState` into the URL hash
      (`persistence.ts` was explicitly designed for swappable backends). The presenter's final
      config becomes a link the audience takes home. Cheap; also makes bug reports reproducible.

**Execution**: 6.1 first, as one unit (engine + UI + tests). Then 6.2–6.5 are parallel-safe
with worktree isolation (6.2 and 6.4 both touch the Header UI and persistence — merge
carefully or serialize those two).

**Acceptance gate**: a new `tests/ui/scenario-talk-arc.mjs` that walks the full talk arc —
load defaults → add delta+RLE to **humidity (stepped uint16)** and assert the Encoded byte
count *drops* below Typed and strip entropy decreases → load "Basically Parquet" and assert
footer placement + trailer active → download a file and assert the blob's first bytes are the
magic → toggle include-metadata off/on and assert Read fail/success → save checkpoint, make
three config changes, restore, assert state round-trips — all without touching localStorage
devtools or reloading. Plus D9's compressibility-signature engine tests green.
*(Amended during execution: the original text said "the sorted variable", but pressure —
sorted per D9 — is float32-stored, and delta+RLE on IEEE-754 float diffs inflates rather than
compresses (verified at the engine level). That inflation is itself a documented lesson: floats
don't compress until quantized via type assignment. The clean compression beat uses humidity.)*

---

## Suggested working agreement

1. One phase per session/PR; run the full gate (`npx vitest run`, `tsc --noEmit`, Playwright
   harness) before merging.
2. Never fix an engine bug without a failing test first (Phase 1 pre-writes most of them).
3. When code and `docs/design.md` disagree after Phase 4, the docs are authoritative again —
   keep them updated in the same PR that changes behavior.

---

## Open finding (2026-07-10)

| ID | Severity | Finding | Status |
|----|----------|---------|--------|
| PERF-1 | MAJOR | **Pipeline stall at ~8.37–8.38M total values.** A fresh-boot seed at certain array shapes never settles — no error, `pipeline-booting` gate never clears. Bracketed to within ~8K values: `[2046,2046]`×2 vars = 8,372,232 values settles in ~22s; `[2047,2047]`×2 vars = 8,380,418 values times out (60s+); `[2049,2049]`×2 vars = 8,396,802 values still hasn't settled after 570s (9.5 min), zero pageerrors. `[2100,2000]`×2 vars = 8,400,000 values also hangs, confirming it isn't shape/aspect-ratio specific. Repro shapes and full timing table in `.superpowers/sdd/task-v8-report.md`. Ruled out: `SOFT_ELEMENT_CAP` boundary (8,380,418 was still under the then-current 8,388,608 cap when it hung — the cliff is unrelated to that constant), aspect ratio (confirmed by the `[2100,2000]` case), and proportional slowdown (8,372,232 is fast; 8,186 values more hangs — not a gradual curve). Suspected worker/pipeline-internal (not yet investigated further). Mitigated for now by lowering `SOFT_ELEMENT_CAP` to 8,000,000 (`src/components/config/SchemaEditor.tsx`) so the advisory banner fires before the stall zone, not after it. | **Open** — uninvestigated beyond ruling out the three causes above; cap lowered as a stopgap, root cause not fixed. |
