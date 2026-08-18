# Architecture Snapshot

> Current-state map, verified against the code as of the Phase 4 docs pass. For *how it got
> here* — what was broken, what decisions were made and why — see `docs/remediation-plan.md`.
> That document's Part 1 describes an earlier, broken state; where it and this file disagree,
> this file (and the code) win. This document does not repeat that history — it's a "get
> oriented in 10 minutes" map of what exists today.

## The Pipeline: 7 Stages

`StageName` (`src/types/pipeline.ts`) is the single source of truth for stage identity:

```typescript
type StageName = 'values' | 'typed' | 'linearized' | 'encoded' | 'metadata' | 'write' | 'read';
```

Each stage is a pure function in `src/engine/pipelineCompute.ts` (react-free, so it can be
bundled into a Web Worker without pulling react along). `src/hooks/usePipeline.ts` is now a
one-line re-export shim (`export * from '../engine/pipelineCompute.ts'`) kept permanently so
every existing import path continues to work.

| # | Stage function | Reads | Produces |
|---|-----------------|-------|----------|
| 1 | `computeValuesStage(shape, variables)` | `shape`, each variable's `name`/`color`/`logicalType` | Human-readable values per variable (`generateValues`), as float64 display bytes |
| 2 | `computeTypedStage(shape, variables, variableValues)` | stage 1's values, each variable's `logicalType`/`typeAssignment` | Storage-dtype bytes per variable (`assignType`), plus `VariableStats` (min/max/mean/clipped/rounded/nanCount/isLossy) |
| 3 | `computeLinearizedStage(shape, chunkShape, interleaving, variables, typedVariableValues)` | stage 2's typed values, `chunkShape`, `interleaving` | Chunked + interleaved bytes (`chunkData`/`chunkDataPerVariable` + `linearizeChunk`), plus a `StageLayout` descriptor for on-demand trace/chunk lookups (see below) |
| 4 | `computeEncodedStage(chunks, linearizedChunks, interleaving, variables, fieldPipelines, chunkPipeline)` | stage 3's chunks, `fieldPipelines` (id-keyed) or `chunkPipeline` | Codec-pipeline output per chunk (`runCodecPipeline`) |
| 5 | `computeMetadataStage(state, encodedChunks, variableStats)` | full `state` (re-derives schema/shape/codec config directly — not from prior stage outputs) + stage 4's chunks/stats | Serialized metadata bytes (`collectMetadata` + `serializeMetadata`) |
| 6 | `computeFilesStage(state, encodedChunks, variableStats)` | full `state` + stage 4's chunks/stats | Assembled `VirtualFile[]` (`assembleFiles`) |
| 7 | `computeReadStage(files, shape, variables, magicNumber)` | stage 6's files, `shape`, variables, magic | `ReadFileResult` (success or one of 6 failure reasons) + reconstructed logical values |

`computePipelineStages(state)` composes all 7 in sequence — a plain synchronous call, used by
tests and as the reference implementation.

### Where Compute Runs: Worker + Coalescing Client

`computePipelineStages` runs off the main thread, inside `src/worker/pipeline.worker.ts`. The
main thread talks to it through `src/worker/client.ts`'s `PipelineWorkerClient`: a latest-wins
coalescing client that holds at most one in-flight request and one queued state (a newer
`compute()` call while a request is in flight replaces the queued slot rather than piling up),
respawns the worker and reposts on a crash, and arms a watchdog timer that forces a respawn if a
queued state is waiting behind a compute that never returns. `src/hooks/useWorkerPipeline.ts`
wraps the client in a hook: it posts every state change, keeps the last-good `PipelineResult`
mounted while a newer computation is in flight (stale-view UX — the UI never blanks out
mid-recompute), and exposes a `computing` flag surfaced in the UI as
`data-testid="pipeline-computing-indicator"`.

### Per-Stage Memoization

This is what actually stops a metadata-field keystroke from re-running the whole pipeline.
`createPipelineComputer()` (`src/engine/pipelineCompute.ts`) returns a stateful closure — one
instance lives for the worker's lifetime — that memoizes each stage independently: every stage's
cache key is a JSON string of exactly the state slice that stage's compute function reads (per
the table above), with the upstream stage's key folded into the downstream key so an upstream
change invalidates every stage after it:

| Stage | Memo key includes | Does NOT recompute on... |
|-------|---------------------|----------------------------|
| `values` | `shape`, `variables` | chunkShape, interleaving, codecs, metadata, write config |
| `typed` | `valuesKey`, `shape`, `variables` | chunkShape, interleaving, codecs, metadata, write config |
| `linearized` | `typedKey`, `shape`, `chunkShape`, `interleaving`, `variables` | codecs, metadata, write config |
| `encoded` | `linearizedKey`, `interleaving`, `variables`, `fieldPipelines`, `chunkPipeline` | metadata, write config |
| `metadata` | `encodedKey`, `typedKey`, the whole `state` object | — (`state` changes on every edit, but this key is downstream of `encodedKey`, which won't change if only e.g. a custom metadata entry changed) |
| `write` (files) | same key shape as `metadata` | — |
| `read` | `filesKey`, `shape`, `variables`, `write.magicNumber` | metadata edits that don't affect written bytes (they do, in practice, since metadata is embedded — but *unrelated* write/UI state does not retrigger this) |

Net effect: typing in the magic-number field or a metadata custom-entry value re-runs stages
5–7 (metadata, write, read) but not 1–4 (values, typed, linearized, encoded) — the expensive
generation/chunking/codec work. `tests/unit/hooks/pipelineComputer.memo.test.ts` verifies this
by asserting stage objects keep the same reference (`===`) across a metadata-only recompute.

Because the worker keeps reusing the same `ArrayBuffer` instances for cache-hit stages, results
are sent back to the main thread via structured clone rather than `postMessage`'s transfer list:
a transferred buffer is detached from the worker thread, so a later cache hit would hand back a
reference to already-detached memory and crash the next `postMessage` — transfer and per-stage
memoization can't share the same buffers, and memoization avoiding recompute is worth more than
transfer avoiding a clone of already-small serialized bytes.

### Per-Byte Traces: Computed On Demand, Not Precomputed

There is no precomputed trace map. `src/engine/layout.ts` produces a `StageLayout` descriptor
per stage (built alongside stages 3 and 4's chunk/encode work) describing byte regions in terms
of chunk/element coordinates. Three functions answer trace questions against that descriptor on
demand: `traceAt(layout, byteIndex, sources)` (byte → `ByteTrace`), `byteRangesForTrace(layout,
traceId)` (trace → byte ranges, the inverse), and `chunkRegionsOf(layout)` (chunk membership via
coordinate math, replacing the old chunk↔trace maps). `chunkIdForElement`/`elementInChunk` do the
equivalent lookups for hover-linking in viewers that work in element space rather than byte
space. Consumers (`HoverBar.tsx`, `viewerUtils.ts`) call these directly instead of reading a
precomputed map out of `PipelineResult`.

## Where Each Concern Lives

### Engine (`src/engine/` — pure functions, no React)

| File | One-liner |
|------|-----------|
| `generate.ts` | Seeded PRNG (`hashSeed`, `createPRNG`) and `generateValues` — deterministic per-variable data generation from a `LogicalTypeConfig`. |
| `elements.ts` | Value ⟷ typed-array byte conversion (`valuesToBytes`/`bytesToValues`) and display formatting (`formatValue`/`formatLogicalValue`). Guards fractional element counts as a caught error rather than an uncaught `RangeError`. |
| `typeAssign.ts` | `assignType` — logical values → storage bytes (scale/offset, clamping, bit-rounding, NaN-aware stats). `reverseTypeAssignment` — the inverse, called once per variable during Read, *after* codec-pipeline reversal, not as part of it. |
| `chunk.ts` | Chunk grid geometry (`computeChunkGrid`, `enumerateChunkCoords`), flat-index ⟷ N-d coordinate conversion, and `chunkData`/`chunkDataPerVariable` (row-mode vs. column-mode chunk extraction). |
| `linearize.ts` | `linearizeChunk` — turns a chunk's per-variable values into one interleaved (row) or concatenated (column) byte stream, with `buildTraces`. |
| `codecs.ts` | The 4-codec registry (Delta, Byte Shuffle, RLE, LZ) — `CODEC_REGISTRY`, `runCodecPipeline`, `outputDtypeFor` (the dtype-flow rule), `stepWarnings` (applicability + param-mismatch warnings), `shannonEntropy`. |
| `decode.ts` | `reverseCodecPipeline` — walks a codec pipeline's dtype chain forward once, then decodes each step in reverse order. |
| `trace.ts` | `ByteTrace` construction/parsing (`makeTraceId`, `makeChunkTraceId`, `parseTraceId`, `isChunkLevelTrace`) and the two trace-propagation strategies: `propagateTracesValuePreserving` (reordering codecs, dtype changes) and `degradeTracesToChunkLevel` (entropy codecs). |
| `metadata.ts` | `collectMetadata` (schema, shape, chunk_shape, codec_pipelines, chunk_index, logical_types, type_assignments, variable_statistics, byte_order, custom entries with override-wins collision semantics (a custom key matching an auto key replaces its value in place)) and JSON/binary (de)serialization. |
| `write.ts` | `assembleFiles` — single-file and per-chunk file assembly: magic placement, header/footer/sidecar/none metadata placement, the D1 trailer, chunk ordering, and the header-metadata offset-convergence loop. |
| `read.ts` | `readFile` — the reader: magic verification, metadata location (sidecar / trailer / header / footer scan), structure parsing, chunk-index resolution (real or computed), chunk reassembly by coordinates, codec + type-assignment reversal, and the 6-reason failure taxonomy. Deliberately the largest engine file — see "Failure Taxonomy" below and `docs/remediation-plan.md`'s Phase 2 acceptance note on why its size is load-bearing, not accidental complexity. |
| `bytes.ts` | The one byte-utility module: `hexToBytes` (tolerant — strips non-hex, drops a trailing odd nibble), `bytesToHex`, `concatBytes`, `formatByteCount`. |

### Types (`src/types/`)

`dtypes.ts` (8-entry storage dtype registry), `codecs.ts` (`CodecDefinition`, `CodecStep`),
`pipeline.ts` (`StageName`/`STAGE_ORDER`, `ByteTrace`, `PipelineStage`, `ReadFileResult`/
`ReadFailureReason`, `VariableStats`), `state.ts` (`AppState`, `Variable`, `LogicalTypeConfig`,
`TypeAssignment`, `DEFAULT_STATE`).

### State layer (`src/state/`)

- **`useAppState.ts`** — the reducer (`AppAction`/`reducer`) and `AppStateProvider`. Actions
  are grouped into semantic actions (shape/variable/chunk/interleave/codec/metadata-entry CRUD,
  each with real validation), three patch actions (`UPDATE_WRITE`, `UPDATE_METADATA_CONFIG`,
  `UPDATE_UI`), and `SET_DATA_MODEL` (pure) + `REPLACE_STATE` (the one "swap everything" escape
  hatch, used only by the `switchDataModel` wrapper that also owns the model-switch storage I/O).
- **`persistence.ts`** — `loadState(model)`/`saveState(state)` plus
  `loadActiveModel()`/`saveActiveModel()`. Three storage keys total: `0x00c0dec5-state-tabular`,
  `0x00c0dec5-state-array`, `0x00c0dec5-active-model`. `loadState` pipes a raw parse through
  `migrateState` → `deepMergeDefaults` (over a `structuredClone` of `DEFAULT_STATE`, never a
  live reference) → `validateState`, so nothing malformed or missing reaches the engine.
- **`PipelineContext.tsx`** — `PipelineProvider`/`usePipelineContext`. Wraps a `PipelineResult`
  (from `useWorkerPipeline`) plus `showDiff`, split into two memos so a `showDiff`-only toggle doesn't
  invalidate consumers that only read pipeline data, and vice versa. This is what removed ~10
  drilled props from each `<StagePane>` in `App.tsx`.

### UI (`src/components/`)

- **`layout/`** — `App.tsx` (root layout, resizable panels), `Header.tsx`, `Sidebar.tsx`,
  `PipelineStrip.tsx` (stage nodes with byte count/entropy/warning icon).
- **`config/`** — one editor per sidebar section: `SchemaEditor`, `ChunkConfig`,
  `InterleaveConfig`, `CodecPipelineEditor` (reusable) + `CodecSection` (routes to per-field or
  per-chunk editors based on `interleaving`), `TypeAssignConfig`, `MetadataEditor`,
  `WriteConfig`, `ReadStatus`.
- **`viewers/`** — `StagePane` (dropdown + view-mode radios + viewer dispatch; view modes are
  Table/Grid/Hex/Flat for Values/Typed/Read, Hex/Flat-only for Linearized/Encoded/Metadata/
  Write), `TableView`, `GridView`, `HexView` (+ `HexRowRenderer`, `useHexData` — one hex
  implementation shared by the plain and multi-file-sectioned "write hex" presentations, keyed
  by `data-testid="hex-view"` vs. `"write-hex-view"`), `FlatView`, `viewerUtils.ts` (shared
  formatting/chunk-region helpers).
- **`shared/`** — `Radio`, `HoverBar`, `Label`, `controlStyles.ts` (the one `inputStyle`).
- **`files/`** — `FileExplorer`.

### Hooks (`src/hooks/`)

`usePipeline.ts` (permanent re-export shim over `src/engine/pipelineCompute.ts`, described
above), `useWorkerPipeline.ts` (worker-backed pipeline hook, described above), `useHover.ts`
(cross-pane hover state keyed by trace/data indices, not DOM refs), `useContainerWidth.ts`.

## File Formats Produced

All shapes below come from `assembleFiles` (`src/engine/write.ts`); the reader
(`src/engine/read.ts`) is the exact inverse.

**Single file, header placement:**
```
[magic][header metadata][chunk data...][magic]
```
Metadata embeds `chunk_index` offsets computed relative to its own (converged) length — see
"Header Metadata and Offset Convergence" in `docs/design.md`.

**Single file, footer placement, `footerLocator: 'trailer'` (default):**
```
[magic][chunk data...][footer metadata][u32 LE metadata length][magic]
```
Parquet-style (`[footer][len]['PAR1']`). The reader seeks to `end - magicLen - 4`, reads the
length, and slices exactly — no scanning needed, for JSON or binary metadata alike.

**Single file, footer placement, `footerLocator: 'none'`:**
```
[magic][chunk data...][footer metadata][magic]
```
No recorded length. The reader falls back to a best-effort backward scan (string-literal-aware
JSON brace matching, or a bounded binary entry-count plausibility scan) that can legitimately
fail — see the failure taxonomy below.

**Single file, sidecar placement:**
```
data file:     [magic][chunk data...][magic]
metadata file: [serialized metadata bytes]   (name: "metadata")
```

**Single file, `includeMetadata: false`:**
```
[magic][chunk data...][magic]
```
No metadata anywhere — the Read step's central, default-on lesson (see below).

**Per-chunk partitioning** (any metadata placement other than "no metadata"):
```
{variable}_chunk_{coords}  (column mode) or  chunk_{coords}  (row mode):
  [magic][one chunk's encoded bytes][magic]
metadata  (sidecar-shaped, always, when includeMetadata is true):
  [serialized metadata bytes]
```
`chunk_index` entries in per-chunk mode carry `offset: magic.length` (each chunk file's own
internal offset, not a position in a shared stream) — the reader matches chunk-index entries to
files by coordinates (and variable name, in column mode), never by byte offset across files or
by parsing numbers out of filenames.

## The Read Failure Taxonomy

`ReadFailureReason` (`src/types/pipeline.ts`), returned as `{ success: false, reason, message,
byteCount }`:

| Reason | When | Lesson |
|--------|------|--------|
| `no-metadata` | No metadata was written at all (`includeMetadata: false`) | Self-describing bytes require metadata — the read extension's core point. |
| `metadata-not-found` | Metadata was written, footer placement, `footerLocator: 'none'`, and the best-effort scan couldn't pin down the boundary | Why real formats record an exact length (Parquet's trailer) instead of scanning. |
| `bad-magic` | Leading (or, with a trailer, trailing) bytes don't match the configured magic | A reader only understands files it was built for (D2) — cheap, immediate rejection, exactly like a real format parser's first check. |
| `corrupt-metadata` | Metadata was located but didn't parse into a usable structure | Finding *something* isn't the same as being able to trust it. |
| `no-chunk-index` | `includeChunkIndex: false` and at least one codec pipeline in play is size-changing (RLE/LZ) | Why chunked/columnar formats always carry an index — variable-size chunks are unlocatable without one. |
| `decode-error` | Metadata parsed fine, but codec reversal / deinterleaving / reassembly threw | Metadata can describe a dataset correctly while the bytes still don't match that description. |

On success, `ReadFileResult` carries `reconstructedValues: Map<string, number[]>` and
`lossyVariables: Set<string>` — the union of Type-Assignment lossiness (from each variable's
`VariableStats.isLossy`, computed during the Typed stage) and codec lossiness (each codec's
`isLossy(inputDtype)` predicate, evaluated by walking the *metadata's own* codec-pipeline dtype
flow forward — the reader never consults live app config for this, only what's in the file).

## Offline Caching

`public/sw.js` is a hand-written service worker (no workbox) registered production-only from
`src/main.tsx`, guarded by `import.meta.env.PROD`, as `sw.js?v=<commit>` — `BUILD_INFO.commit`
(`src/build-info.js`, generated by `scripts/get-git-info.js` on `predev`/`prebuild`) gives each
build a distinct script URL, which forces the browser to fetch and activate a new worker on
deploy. The worker opens a cache named `0xc-<commit>` and purges any other `0xc-*` cache on
`activate`, so old builds' cached assets don't linger. Same-origin GETs are cache-first (hashed
Vite assets are immutable per URL) except navigations (`request.mode === 'navigate'`), which are
network-first with cache as the offline-only fallback — the unhashed shell URL changes content
across deploys, and serving it cache-first would pin a client to its first-seen build forever,
because the cached shell re-registers its own old `sw.js?v=<commit>` on every load.

## Pointers

- **History, findings, and the rationale behind every "D#" decision cited above**:
  `docs/remediation-plan.md`. Its Part 1 findings describe an earlier, broken state of this
  codebase — useful for understanding *why* something is built the way it is, not a description
  of current behavior.
- **The full spec this was built from**: `docs/design.md` (core pipeline) and
  `docs/extension-read-step.md` (the Read step, codec decode functions, diff view).
- **Testing conventions, Playwright regression harness, data-testid list**: `CLAUDE.md`.
