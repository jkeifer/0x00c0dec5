# Codec curation + linearization setting — design

**Date:** 2026-07-12
**Supersedes:** project 4's "Real codecs" presentation tier (the Pyodide
runtime and the zstd/gzip/blosc entries themselves are unchanged).

## Motivation (from design discussion)

The "educational vs real" split shipped by project 4 is a false taxonomy —
all codecs are real, and all codecs in this engine are already the same
shape: **stride-aware bytes→bytes** (`encode(bytes, inputDtype, params)`).
They compose freely, even in compositions that don't make sense (the
existing advisory-warning machinery handles that). What actually
distinguishes array data is **how arrays are linearized into bytes**, which
deserves to be a first-class setting rather than a hidden C-order
assumption. Curation should span real-format lineages (Zarr *and* Parquet),
not just what numcodecs happens to ship.

## 1. Curated codec set

One registry, no tiers. Backing implementation (local engine code vs
numcodecs-via-Pyodide) is an invisible detail; the `runtime: 'pyodide'`
field keeps driving load-gating/disabled-until-ready exactly as today.

| key | label | class | backing | notes |
|-----|-------|-------|---------|-------|
| `delta` | Delta | transform | local (existing) | unchanged |
| `zigzag` | Zigzag | transform | local (NEW) | Parquet's signed→unsigned mapping (`(n<<1) ^ (n>>bits-1)` per element); dtype-preserving, bijective (`isLossy: false`); `applicableTo`: signed integer dtypes only (warning otherwise, advisory as usual) |
| `byte-shuffle` | Byte Shuffle | transform | local (existing) | description gains "Parquet calls this BYTE_STREAM_SPLIT" |
| `bit-shuffle` | Bit Shuffle | transform | local (NEW) | bit-plane transposition across elements (the trick inside blosc/bitshuffle); dtype-preserving, bijective; pairs with RLE/entropy the way byte-shuffle does, one level finer |
| `dictionary` | Dictionary | compression | local (NEW) | Parquet's workhorse. Self-contained byte format: `[u8 stride][u32 dictCount][dictCount × stride dict bytes][u8 indexWidth (1/2/4, min that fits dictCount)][indices]`, little-endian. Entropy-class: output dtype uint8, chunk-level trace degradation, exact round-trip (`isLossy: false`). Works on any fixed-stride dtype (incl. charN) |
| `rle` | RLE | compression | local (existing) | KEPT — Parquet lineage, and the one codec whose output stays readable in the hex view |
| `deflate` | Deflate | compression | numcodecs (`Zlib`) (NEW) | the algorithm inside GZip, bare zlib container — compare hex with GZip's `1f 8b` magic + trailer: same bytes inside, different wrapper |
| `gzip` | GZip | compression | numcodecs | label loses " (real)" |
| `zstd` | Zstd | compression | numcodecs | label loses " (real)" |
| `lz` | — | — | — | **DELETED outright** (redundant next to real compressors). Unknown codec keys in saved states/pipelines are already tolerated (skipped) by the engine and UI |
| `blosc` | — | — | — | **DELETED** (design decision: a meta-compressor is confusing as a teaching object — it bundles shuffle+compressor choices that this tool wants to show as separable steps). Its bitshuffle lesson moves to the standalone `bit-shuffle` transform |

Explicitly out: CRC32C (checksums teach nothing about how data composes
into a file), bit-packing (bit-granularity *size-changing* output; note
bit-shuffle IS in — it's size-preserving), Snappy (no clean backing;
Parquet supports zstd/gzip anyway), LZ4 standalone. Scale/offset and
bitround remain on `typeAssignment` — NOT codecs (CLAUDE.md pitfall 3
stands).

Internal `category` values (`'reordering'`/`'entropy'`) are unchanged —
they drive `outputDtypeFor` and trace degradation and renaming them churns
everything for nothing. Only display grouping changes.

## 2. Presentation: no tiers

- Picker: two optgroups by function — **"Transforms"** (delta, zigzag,
  byte-shuffle) and **"Compression"** (dictionary, rle, gzip, zstd, blosc).
  The `codec-group-real` optgroup and testid are deleted; pyodide-backed
  entries are simply disabled (with the existing suffix) inside their
  functional group until the runtime is ready.
- Labels: no "(real)" suffixes anywhere.
- Runtime banner copy goes neutral: "Loading compression runtime:" /
  "Compression codecs unavailable: … Everything else works." (testids
  unchanged: `runtime-banner`, `runtime-banner-step-{id}`,
  `runtime-banner-dismiss`).

## 3. Linearization setting (the substantive feature)

**What:** for the array model with `shape.length > 1`, a new setting next
to chunk shape choosing the element-traversal order used to linearize each
chunk's elements into bytes:

- `c` — row-major (default; today's behavior, byte-identical)
- `fortran` — column-major
- `morton` — Z-order/Morton (bit-interleaved coordinates; spatial locality
  visible in the hex view — the teaching payoff)

Tabular data (1-D) and 1-D arrays are unaffected and show no control.
This is orthogonal to the existing `interleaving` (row/column variable
interleaving), which is unchanged.

**State:** `AppState.linearization: 'c' | 'fortran' | 'morton'` (default
`'c'`; persistence backfills the default for older saved states). New
action `SET_LINEARIZATION`. The worker's memo keys for the Linearized
stage (and thus everything downstream) include it.

**Engine:** linearization order is a pure index-mapping family —
`linearIndex ↔ element coords` within a chunk's (edge-clipped) dims —
consumed by:
- `linearizeChunk` (write side),
- the Linearized/Encoded stage layouts' per-value tracing (`traceAt` and
  friends in `layout.ts`, plus `elementInChunk`/`chunkIdForElement`),
- the reader's de-linearization (round-trip must be exact for all three
  orders under edge-clipped chunks).

Morton with non-power-of-two / edge-clipped chunk dims is the named risk:
padded bit-interleaved keys are sparse, so compaction (sorting the used
keys) is required, which breaks O(1) two-way math. Approach: a per-chunk
forward/inverse permutation (`Uint32Array` pair) computed lazily from the
pure function and **memoized where used — never serialized into the worker
result** (PERF-1's lesson: no per-element arrays cross the thread
boundary). Both worker (linearize) and main thread (traceAt) derive it
independently on demand. C/Fortran orders use closed-form index math, no
permutation materialized.

**Metadata + read:** the metadata *layout* include-group gains the
linearization order; the reader consumes it to de-linearize. With the
layout group toggled off, the existing layout-starved read failure covers
it (no new failure taxonomy). Read-process step text mentions the order
where it narrates chunk decoding.

**UI:** Chunking sidebar section gains the control (`data-testid`
`linearization-select`), rendered only for array model with ndim > 1.

## 3b. Endianness setting + the silent-corruption metadata lesson

**What:** byte order becomes an explicit, recorded choice (Zarr v3's
`bytes` codec `endian` param territory) instead of a silent
little-endian assumption.

- **Setting:** `AppState.byteOrder: 'little' | 'big'` (default `'little'`,
  today's behavior byte-identical; persistence backfills). Applies to BOTH
  data models (any multi-byte dtype). UI control lives beside the
  linearization select (`data-testid` `byte-order-toggle`), visible always
  (it's not ndim-gated). New action `SET_BYTE_ORDER`.
- **Engine:** `valuesToBytes`/`bytesToValues` (and the DataView call sites
  behind them) gain the byte-order parameter; Typed-stage bytes,
  linearized chunks, and read-side decoding all honor it. Codec dtype flow
  is unaffected (codecs are stride-aware bytes→bytes; endianness is
  upstream of them).
- **Metadata — the mini-lesson:** endianness gets its OWN granular include
  toggle (`include-endianness-toggle`, joining the existing five), NOT
  membership in the layout group, because its failure mode is unique:
  every other starved group hard-fails a named read step, but a missing
  endianness entry does not fail — **the reader assumes the host's byte
  order (little-endian in every browser) and proceeds**. If the file was
  authored big-endian with the entry omitted, the read *succeeds* with
  garbled values: silent data corruption, not honest failure. The
  read-process view narrates the assumption ("byte order not recorded —
  assuming host (little-endian)"), and the Read-stage diff view shows the
  damage. When the entry IS present, the reader uses it and the lesson
  inverts (BE file + recorded endianness round-trips exactly).

## 4. Content updates (presets, guide, docs, scenarios)

- **Presets:** `basically-parquet` showcases the Parquet lineage
  (dictionary and/or zigzag joining its existing delta+rle);
  `basically-zarr` showcases blosc/zstd; `basically-geotiff` reviewed for
  fit. Any `lz` references removed. Presets regenerate via the existing
  `scripts/gen-presets.ts` flow if applicable, else hand-edited JSON.
- **Guide:** codec-related teaching steps updated to the new set and
  grouping; a linearization teaching beat added to the chunking section's
  guide content.
- **Scenarios:** `scenario-real-codecs.mjs` renamed/updated
  (`codec-group-real` is gone — assert the new group labels instead);
  `scenario-talk-arc.mjs` re-verified (delta+rle beats survive);
  a linearization check added (switching order changes Linearized-stage
  bytes; Morton round-trips through Read); full suite green.
- **Docs:** `docs/design.md` codec section + CLAUDE.md testid list
  updated (`codec-group-real` removed; `linearization-select`,
  `byte-order-toggle`, `include-endianness-toggle` added; the granular
  metadata toggle list gains the endianness entry with its
  silent-corruption semantics noted).
- **Guide/presets additionally cover:** the endianness mini-lesson (a
  guide beat on the toggle's silent-corruption behavior) and the
  linearization beat; `basically-*` presets get explicit
  `linearization`/`byteOrder` fields (defaults).

## Non-goals

- No change to the Pyodide runtime, gating, SW caching, or protocol.
- No bit-packing, CRC32C, Snappy, LZ4-standalone, or Blosc codecs.
- No sharding: deliberately rejected as a codec (design discussion: Zarr
  v3's `sharding_indexed` conflates storage layout with encoding — in this
  app that concern already lives in the Write stage's partitioning
  options, which is the right place for it).
- No change to `interleaving` semantics or the tabular model (beyond
  `byteOrder`, which applies to both models).
- No v3-style `{"name", "configuration"}` metadata reshaping (not asked
  for; metadata records keep their current shape, plus the new
  linearization and endianness entries).

## Risks / plan spike items

1. Morton correctness under edge-clipped chunks (bijectivity + exact
   read round-trip) — first engine task proves it with property-style
   tests across odd shapes before anything consumes it.
2. Per-value tracing through Fortran/Morton orders — the layout
   equivalence tests (`referenceTraces` pinning) must extend to the new
   orders; if the reference tracer assumes C order internally, extend it
   deliberately, not incidentally.
3. Dictionary's self-contained format must round-trip through the read
   side purely from `codec_pipelines` metadata (no side-channel dtype
   knowledge beyond what entropy codecs already get).
4. `byteOrder` threading: `valuesToBytes`/`bytesToValues` have many call
   sites (engine, read, tests, viewers' source-array derivation). The
   parameter must default to `'little'` so untouched call sites stay
   byte-identical, with the setting threaded only along the
   typed→linearized→read spine — an audit of call sites is the plan's
   first endianness task.
5. The endianness read-assumption path must NOT mark the read as failed
   or lossy — silent success with wrong values is the point. Guard
   against a well-meaning implementer "fixing" it into a failure.
