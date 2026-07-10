# Performance Architecture — Design Spec

**Date:** 2026-07-10
**Status:** Approved for planning
**Context docs:** `docs/design.md` (core spec), `notes/improvement-ideas.md`
(exploration + prioritization), por-que repo
(`~/dev/por-que/por-que/_ver-por-que.repo`) for borrowed worker/SW/build-info
patterns.

## Goal

Support datasets large enough that compression statistics are honest:

- **Array model:** ~1M elements per variable (1024×1024 — a normal COG tile),
  e.g. 3 float64 variables = 24MB at the Values stage.
- **Tabular model:** ~250K rows × a few columns (a couple of Parquet row
  groups).

Every change must keep the app fully working at today's small sizes — the
existing pedagogy (per-value hover tracing, hex inspection, honest stats) is
preserved, not traded away.

**Deadline context:** conference talk early September 2026 (~2 months). Each
implementation phase leaves the app shippable.

## Non-goals

- **No "inflation factor"** or synthetic data padding — fake compression
  numbers undermine the tool's credibility.
- **No per-chunk incremental recompute** (Parquet-style dirty tracking).
  Most edits invalidate all chunks; stage-level memoization already skips
  unaffected stages; a full worker recompute at target sizes is expected to
  be sub-second outside heavy codecs. Revisit only if profiling disagrees.
- **No unbounded scale.** A soft element-count cap (constant chosen after
  profiling; expected O(1M–4M) total values) with a warning banner above it.
- **No sampled/approximate stats.** Byte counts and entropy are always
  computed over the full real bytes.

## Current architecture and the three walls (verified 2026-07-10)

### Wall 1 — memory: per-byte trace materialization (the hard wall)

Every stage builds `traces: ByteTrace[]` with one object per byte
(`src/hooks/usePipeline.ts`; `ByteTrace` in `src/types/pipeline.ts` carries
traceId string, variableName, color, coords array, displayValue string,
dtype, chunkId, byteInValue, byteCount). At the array target: Values alone is
24MB → 24M objects; Typed/Linearized/Encoded repeat it. At ~100B/object of JS
heap this is multiple GB → tab OOM. Same-complexity side structures:
`chunkTraceMap`/`traceChunkMap` (per-element traceId strings) and
`buildChunkRegions(traces)` (an O(bytes) pass per stage).

### Wall 2 — main-thread synchronous compute

The chained `useMemo`s in `usePipeline` have correct dependency boundaries
but block the UI for whole recomputes. Known hot spots: value generation
calls `Number(raw.toPrecision(sigFigs))` per element (string allocation ×
1M), and the educational LZ codec is a naive O(n × window) backward scan
(`src/engine/codecs.ts` ~line 224).

### Wall 3 — DOM rendering limits

- HexView at 24MB = 1.5M rows × ~18px ≈ 27M px of scroll height — past
  Firefox's element-height cap (~17.9M px) and near Chrome's (~33.5M px).
  Continuous scroll physically breaks regardless of virtualization.
- GridView is not virtualized (known exception UI-19) — renders one DOM cell
  per element. 1M cells is a non-starter.
- TableView at 250K virtualized rows is fine.

## Design

Three pillars. The unifying idea is the COG model: don't materialize what a
range request can answer; render only what the viewport needs; navigate the
rest with an overview.

### Pillar 1 — traces become arithmetic, not data

**Key observation:** at every stage the byte→trace mapping is *derivable*
from compact structure. Replace materialized `ByteTrace[]` with a per-stage
**layout descriptor** — O(variables + chunks) plain data — plus pure lookup
functions in a shared engine module (importable by both main thread and
worker).

**Layout descriptor per stage** (shapes indicative, refined in the plan):

- **Values / Typed / Read:** ordered per-variable blocks
  `{ variableName, color, dtype, start, byteLength, stride }`. Text
  variables at Values/Read have variable stride → a per-variable
  `Uint32Array` of cumulative element byte offsets (length N+1); byte→element
  is a binary search, element→byte is a direct index. Fixed-stride numerics
  are pure division.
- **Linearized:** ordered chunk regions
  `{ chunkId, coords, variableName?, start, byteLength }`. Within a chunk:
  column mode = one variable's elements in chunk-relative order (chunk-flat
  index → global coords via existing `chunk.ts` arithmetic); row mode =
  interleaved records with a record stride and a per-field offset table.
- **Encoded:** per chunk `{ start, byteLength, mapping }` where `mapping` is
  `'identity'` (delta and other position-preserving codecs — traces show the
  original value, matching today's `propagateTracesValuePreserving`
  semantics), `'shuffle'` (byte-transpose arithmetic parameterized by
  element size), or `'chunk-level'` (entropy codecs — the whole chunk is one
  trace range, matching today's `degradeTracesToChunkLevel`).
- **Metadata:** a single region.
- **Write:** per-file region tables (magic / metadata / chunk index / chunk
  data), where chunk-data regions delegate into the Encoded mapping and
  structural regions carry the existing structural traceIds
  (`magic:start`, `metadata`, …).

**Lookup API** (new `src/engine/layout.ts`; exact naming decided in the
plan):

- `traceAt(layout, byteIndex, valueSources) → ByteTrace | null` — returns
  the same `ByteTrace` shape viewers consume today, with `displayValue`
  formatted on demand from the value arrays.
- `byteRangesForTrace(layout, traceId) → {start, end}[]` — the reverse
  direction, for hover linking from Table/Grid into Hex.
- `chunkRegionsOf(layout) → ChunkRegion[]` — replaces
  `buildChunkRegions(traces)` with an O(chunks) derivation.
- Element↔chunk membership becomes coordinate math;
  `chunkTraceMap`/`traceChunkMap` are deleted outright.

**Trace semantics are unchanged.** TraceId formats (`trace.ts`), per-value
fidelity through value-preserving stages, and chunk-level degradation after
entropy codecs all behave exactly as documented in CLAUDE.md pitfall #1 —
only the *representation* changes (computed on demand instead of stored).
Viewers keep receiving `ByteTrace` objects; they just call a function instead
of indexing an array. Hover state continues to use data indices/traceIds,
never DOM refs (pitfall #2).

**Value arrays:** numeric `logicalValues`/`typedValues` migrate from
`LogicalValue[]` (plain JS arrays) to `Float64Array`/typed arrays —
transferable across the worker boundary and dramatically cheaper than
structured-cloning 1M-element plain arrays. Plain arrays remain only for
text variables.

### Pillar 2 — pipeline compute in a Web Worker

The engine is pure functions over typed arrays; `computePipelineStages` is
already the pure composition. It moves into a module worker.

**Protocol** (`src/worker/protocol.ts`, tagged unions on `kind` — pattern
borrowed from por-que's `src/js/worker/protocol.ts`):

```typescript
// Requests
{ kind: 'compute', id: number, state: AppState }
// AppState is already JSON-safe (it's what localStorage persists).
// The worker regenerates values deterministically from state; no data is
// shipped in. (Future dataset presets: worker fetches and caches sample
// data keyed by preset id.)

// Responses
{ kind: 'progress', id: number, stage: StageName }        // per-stage tick
{ kind: 'result', id: number, ok: true,
  payload: TransferablePipelineResult }                    // bytes transferred
{ kind: 'result', id: number, ok: false, error: string }
```

`TransferablePipelineResult`: per-stage `{ name, bytes: ArrayBuffer,
layout: LayoutDescriptor, stats }` plus files, readResult, variableStats,
and the typed value arrays. All `ArrayBuffer`s move via the transfer list.
Layout descriptors are plain data; the lookup *functions* are imported from
the shared engine module on the main thread, so hover/tracing does local
arithmetic with zero worker round-trips.

**Client** (`src/worker/client.ts`) — differs deliberately from por-que's
pending-map query server, because ours is a recompute pipeline where only
the newest request matters:

- **Latest-wins coalescing:** at most one compute in flight plus a single
  `queued` slot that newer states overwrite. A slider drag through 20 values
  costs 2 computes, not 20. When a result arrives it is published (even if
  superseded — progressive under stale-view UX), then the queued state is
  posted immediately.
- **Crash handling (borrowed verbatim from por-que `client.ts`):** a worker
  `error` listener fails pending work, terminates, and nulls the worker so
  the next use respawns it. Without this a dead worker hangs everything.
- **Watchdog:** a synchronous compute cannot be aborted mid-flight. If a run
  exceeds a threshold (~10s) *and* a newer state is queued, terminate +
  respawn + post the newest (reuses the crash path). No SharedArrayBuffer
  abort flags, no compute chunking.
- **Warm at boot:** the worker is created at app start; the initial compute
  doubles as warmup. When Pyodide codecs arrive (separate project) they add
  a fire-and-forget `warmup` message kind on this same worker — a new
  message, not a rearchitecture.

**React integration:** `usePipeline(state)` becomes
`{ result: PipelineResult | null, computing: boolean }`. It holds the last
good result and flips `computing` for the indicator.

**Decided recompute UX: stale view + subtle indicator.** The previous result
stays on screen; the pipeline strip shows a small "recomputing…" pulse
(per-stage progress ticks can animate it); the new result swaps in place.
No layout shift, no blocking overlay.

**Stage memoization moves into the worker.** The worker caches per-stage
inputs/outputs with the same dependency boundaries the `useMemo` chain has
today (documented per-stage in `usePipeline.ts`), so a metadata keystroke
still skips generation/typing/chunking/encoding. The chained `useMemo`s on
the main thread are deleted.

**Compute error handling:** a failed compute keeps the last good result on
screen, marks the pipeline strip with an error state, and records the error
in the About modal diagnostics. The app never crashes on engine errors
(design-doc edge-case philosophy unchanged).

### Pillar 2a — build info + About modal

Ported from por-que (`scripts/get-git-info.js`, `src/build-info.js` +
hand-written `.d.ts`):

- Build script writes gitignored `src/build-info.js` with
  `{ commit: git describe --match=NeVeRmAtCh --always --abbrev=8 --dirty,
  buildTime: ISO string }`. Wired to **both** `predev` and `prebuild` so a
  fresh clone's dev server doesn't fail on the missing module.
- Header gains a small ⓘ info icon opening an **About modal**:
  - Always visible: app name, commit (+dirty marker), build time, GitHub
    repo link.
  - **Collapsed by default** under an expandable "Performance" toggle:
    worker diagnostics — worker state (booting / ready / computing /
    crashed), last compute duration per stage, current element count,
    worker respawn count, last compute error if any. (Later additions:
    Pyodide status, service-worker cache name.)
- The per-stage timing readout doubles as a live profiler during this work;
  the commit line makes stale-cached GitHub Pages builds diagnosable.
- Styling per project conventions: inline styles from `src/theme.ts`;
  testids per convention (e.g. `about-modal`, `about-performance-toggle`).

### Pillar 2b — service worker (offline cache)

**Decided: lands with this work** (not deferred to the Pyodide project) —
it buys full offline resilience for the talk since the app is entirely
client-side. Port por-que's `static/sw.js` (~90 lines, hand-written, no
workbox) with these properties preserved:

- Registered production-only as `sw.js?v=<commit>` (from build-info) so
  every deploy forces a service-worker update.
- Versioned cache name per commit; `activate` purges older versions'
  caches.
- **Network-first for the app shell** (navigations), cache only as offline
  fallback — a cache-first shell re-registers its own old `sw.js?v=<old>`
  and pins clients to a dead build forever (the bug por-que already fixed).
  Hashed Vite assets are immutable per URL → cache-first.
- Adjustments for this repo: served from `public/` under the
  `/0x00c0dec5/` base path (registration path and scope must respect
  `import.meta.env.BASE_URL`); no third-party CDN origins to cache yet
  (that list grows when Pyodide arrives).

### Pillar 3 — viewers at scale

- **GridView → canvas above a size threshold.** Below the threshold
  (constant, e.g. ≤ ~4K elements) the existing DOM cell grid with visible
  values remains — it is pedagogically valuable at talk-demo sizes. Above
  it, render a canvas: one `ImageData` pixel per element, colormapped per
  variable (normalized to the variable's min/max), scaled with
  `image-rendering: pixelated`. Hover becomes mouse-position → element
  coords arithmetic (no DOM cells, no `querySelector` — retires the UI-19
  exception at large sizes). This canvas is the same rendering the future
  geo colormap/affine-axes work builds on.
- **HexView → overview + jump above a height threshold.** While
  `totalRows × rowHeight` stays under a conservative cross-browser cap
  (~8M px), the current continuous virtual scroll remains. Above it, the
  view switches to a windowed mode: a **byte-map overview strip** (canvas;
  each pixel column = N bytes, colored by variable/chunk/structural region
  from the layout descriptor) that serves as navigation — click to jump the
  virtualized window to that neighborhood — plus an offset input for exact
  jumps. The overview is independently pedagogical: a zoomed-out picture of
  file structure no current view provides.
- **TableView / FlatView:** already virtualized; they consume `traceAt`
  lookups for visible rows only. No structural change.

### Codec and generation hot paths

- **LZ codec:** rewrite the inner match loop with hash-chain matching
  (3-byte prefix hash table) — linear-ish instead of O(n × window), and
  *more* honest pedagogically (it's how real LZ77 implementations work).
  Same output format, same decode.
- **Value generation:** replace the per-element
  `Number(raw.toPrecision(sigFigs))` string round-trip with an arithmetic
  rounding fast path (sized by profiling; only if it shows up).

## Testing strategy

Engine-first, per project rules (CLAUDE.md):

1. **Layout-lookup equivalence tests (the cornerstone).** For small datasets
   across representative configs (both data models; row/column interleaving;
   text + numeric variables; codec pipelines with delta/shuffle/RLE/LZ;
   multi-chunk shapes; all write placements), compute the old materialized
   traces and assert `traceAt` returns an equivalent `ByteTrace` for **every
   byte at every stage**, and `byteRangesForTrace` inverts it. This pins the
   refactor to exact current behavior before anything is deleted.
2. **Worker protocol tests:** client coalescing (N rapid states → ≤2
   computes, last state wins), crash respawn, watchdog terminate, transfer
   integrity (bytes identical across the boundary).
3. **Profiling harness** (`scripts/profile.mjs`, plain node): runs
   `computePipelineStages` at 10K / 100K / 1M elements, prints per-stage
   wall time and heap deltas. Run before Phase 2 (baseline + validate this
   spec's claims) and after each phase (regression guard).
4. **Playwright scenarios** (per `tests/ui/scenario-helpers.mjs`
   conventions): a large-dataset scenario — seed a 1M-element state via
   `seedStateAndReload`, assert no crash/pageerror, recompute indicator
   appears and clears, hover linking works in both panes, hex overview mode
   engages and jumps correctly; an About-modal scenario — version renders,
   performance section collapsed by default, expands to show worker state.
5. **Existing regression scenarios** must stay green at small sizes
   throughout (`scenario-crash-inputs`, `scenario-placement-matrix`,
   `scenario-hover-linking`, `scenario-pane-defaults`).

## Implementation phasing

Each phase leaves the app fully working and shippable.

1. **Profiling harness + baseline** (~a day). Validates the wall analysis
   with real numbers; sets the regression guard.
2. **Lazy traces** (the big invasive one). Layout descriptors + `layout.ts`
   lookup API behind the equivalence test suite; convert viewers and hover
   off materialized arrays; delete `ByteTrace[]` materialization,
   `chunkTraceMap`/`traceChunkMap`, and O(bytes) `buildChunkRegions`.
   Expected to reach a few hundred K elements alone.
3. **Worker compute + build-info/About + service worker.** Protocol, client
   coalescing, `usePipeline` conversion, stage memoization in worker;
   build-info script + About modal (diagnostics feed off worker timings);
   SW port. Unlocks the 1M target and pre-pays the async plumbing that
   real codecs (CompressionStream / WASM zstd / Pyodide) need.
4. **Viewer scale work.** Canvas GridView; hex overview + jump. Independent
   of each other; parallelizable; each is talk-visible.
5. **Hot-path cleanup.** LZ hash-chain rewrite; generation fast path; final
   soft-cap constant + warning banner — all sized by the Phase 1 harness
   numbers re-run at scale.

## Open questions (spike-sized, resolved during implementation)

- Text-variable offset tables: confirm `Uint32Array` prefix sums cover
  FlatView/HexView needs at the Values/Read stages (variable stride).
- Row-mode interleaving + byte shuffle: confirm the transpose arithmetic
  has no corner requiring a materialized map (the equivalence suite decides
  this empirically).
- Exact thresholds: GridView canvas cutover, HexView windowed-mode cutover,
  soft element cap, watchdog timeout — all constants chosen from profiling,
  not guessed in this spec.
- Whether `progress` ticks per stage are worth animating in the pipeline
  strip or a single pulse suffices (cosmetic; decide in Phase 3).
