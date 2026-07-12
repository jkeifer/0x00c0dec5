# Real codecs via Pyodide/numcodecs — design

**Date:** 2026-07-11
**Source:** `notes/improvement-ideas.md` §4 (real codecs), amended by design
discussion: Pyodide-only (no fflate/CompressionStream rung), eager load with
narrated progress, curated numcodecs trio.

## Goal

Add real-world compression to the codec pipeline so the tool shows honest,
recognizable numbers — the *actual* codecs Zarr uses (`numcodecs`), running
in Python via Pyodide/WebAssembly. Educational codecs (Delta, Byte Shuffle,
RLE, LZ) are untouched; real codecs sit alongside them in the same registry
and pipeline machinery.

Explicitly rejected alternatives (from the design discussion):

- **Native `CompressionStream`** — zero-dependency but async-only, and
  `reverseCodecPipeline` runs deep inside the synchronous 1100-line reader;
  asyncifying the engine + test suite is large mechanical churn for one codec.
- **fflate (sync JS gzip)** — obsolete as a stepping stone once Pyodide is
  the direction: numcodecs includes zlib/gzip, and the eager-load decision
  removes the "casual users never see a real codec" concern.

## Key architectural fact

`loadPyodide()` and `loadPackage()` are async, but **`runPython` executes
synchronously once loaded**. So the engine's `encode()`/`decode()` stay
synchronous pure functions, `readFile` stays sync, and all ~935 existing
tests are unaffected. The async surface is exactly one one-time init phase,
owned by the pipeline worker.

## Components

### 1. Runtime module — `src/engine/pyodideRuntime.ts`

Owns the Pyodide handle at module scope.

- `initPyodideRuntime(onProgress: (step: RuntimeStep) => void): Promise<void>`
  — idempotent (subsequent calls return the same promise). Steps, each
  reported as it starts and completes:
  1. `download-runtime` — "Downloading Python runtime (Pyodide <version>, ~12 MB)"
  2. `install-numpy` — "Installing numpy"
  3. `install-numcodecs` — "Installing numcodecs — the compression library Zarr uses"
  Loads `pyodide.mjs` from the pinned jsdelivr CDN via dynamic import
  (`/* @vite-ignore */`) so Vite doesn't try to bundle it; `indexURL` pinned
  to the same version. Exact Pyodide version pinned in one constant at
  implementation time (current 0.28.x line).
- `pyodideReady(): boolean` and a sync accessor used by codec entries; the
  accessor throws `"Python runtime is not loaded"` if called before init
  resolves — this error flows through the worker's existing `ok:false` path.
- Byte bridge: `Uint8Array` in → Python `bytes` → `numcodecs` codec
  `encode`/`decode` → `Uint8Array` out. One copy each way per chunk;
  numcodecs codecs are C-backed, so throughput is dominated by the codec,
  not the bridge.
- The `pyodide` **npm package is a devDependency only** (types + the Node
  runtime for tests). The app ships no Pyodide bytes; browsers fetch from
  the CDN (cached by the service worker, below).

### 2. Codec registry entries — `src/engine/codecs.ts`

Three new `CodecDefinition` entries, all `category: 'entropy'` so every
existing mechanism applies unchanged (output dtype uint8 via
`outputDtypeFor`, per-value trace degradation to chunk level,
`codec_pipelines` metadata records, read-side reversal through
`CODEC_REGISTRY[key].decode`):

| key | label | params | numcodecs call |
|-----|-------|--------|----------------|
| `zstd` | Zstd | `level` (1–22, default 3) | `numcodecs.Zstd(level)` |
| `gzip` | GZip | `level` (0–9, default 6) | `numcodecs.GZip(level)` |
| `blosc` | Blosc | `cname` (lz4/zstd/zlib, default lz4), `clevel` (1–9, default 5), `shuffle` (none/byte/bit, default byte) | `numcodecs.Blosc(cname, clevel, shuffle)` |

- `applicableTo: () => true`, `isLossy: () => false`.
- Blosc's built-in shuffle is the deliberate pedagogical overlap with the
  educational Byte Shuffle codec ("real formats build this in").
- `CodecDefinition` gains an optional `runtime?: 'pyodide'` field. Absent =
  educational codec, always available. This is the only type change.

### 3. Worker integration — `src/worker/pipeline.worker.ts` + protocol

- The worker calls `initPyodideRuntime()` **at worker startup** (eager, per
  the design decision), forwarding progress as a new protocol message:
  `{ kind: 'runtime-status', status: 'loading' | 'ready' | 'error',
  step?: RuntimeStep, detail?: string }`.
- **Compute gating:** before running a compute, the worker awaits the init
  promise **only if the posted state references a codec with
  `runtime: 'pyodide'`** (a small pure helper `stateUsesPyodideCodec(state)`
  checks fieldPipelines + chunkPipeline). States without real codecs compute
  immediately — boot is never delayed by the download. A stored state that
  uses zstd shows the normal recomputing indicator until the runtime lands,
  then computes; no error, no race.
- Init failure (offline first visit, CDN down): `runtime-status: error` with
  the reason; educational codecs unaffected. A compute that needs the failed
  runtime produces `ok:false` with the runtime error → existing PERF-1
  diagnostics/boot-error/stale-view machinery presents it.
- Worker respawn (crash watchdog) constructs a fresh worker → Pyodide
  reloads, served from the service-worker cache (fast, offline-safe).
  StrictMode's dev double-worker likewise double-loads; the first is
  terminated immediately and the SW cache makes the second load cheap.

### 4. UI

- **Load banner:** while `runtime-status` is `loading`, a slim banner under
  the Header narrates the current step (checkmarks for completed steps). On
  `ready` it disappears; on `error` it becomes a dismissible error banner
  ("Real codecs unavailable: <reason>. Everything else works."). Status
  reaches the UI through `useWorkerPipeline` (the client exposes the last
  `runtime-status` alongside diagnostics).
- **Codec picker:** the add-codec dropdown groups entries — the educational
  four first, then a visually separated **"Real codecs"** group with a
  one-line note ("actual numcodecs — the library Zarr uses — running in
  Python via WebAssembly"). While loading/errored, real entries render
  disabled with the state noted. Existing pipelines referencing a real codec
  are not blocked in the UI (the worker gates the compute).
- New testids: `runtime-banner`, `runtime-banner-step-{id}`,
  `codec-group-real`, plus the standard per-step codec testids that already
  derive from registry keys.

### 5. Service worker — `public/sw.js`

- Add the Pyodide CDN origin to the cacheable set, but in a **separate
  cache keyed by the pinned Pyodide version** (`0xc-pyodide-<version>`),
  cache-first (the URLs are immutable). The existing per-commit app-shell
  cache and its activate-time purge are unchanged — this prevents every
  deploy from evicting and re-downloading ~12–30 MB of runtime.
- Purge rule: on activate, delete `0xc-pyodide-*` caches whose version
  differs from the pinned one.
- Result: after one online visit, the entire app **including the Python
  runtime** works offline — the on-stage safety net.

### 6. Testing

- **Unit (Node):** `tests/unit/engine/realCodecs.test.ts` loads the real
  runtime once in `beforeAll` (pyodide npm package; numpy/numcodecs wheels
  fetched on first run and cached under `node_modules/.cache/pyodide` so
  repeat runs are offline). `describe.skipIf(process.env.SKIP_PYODIDE)`
  keeps the rest of the suite runnable when offline. Coverage: exact
  encode→decode round-trip per codec across representative dtypes; dtype
  flow (`outputDtypeFor` → uint8); full pipeline integration: encode with
  zstd → write → `readFile` replays the decode from `codec_pipelines`
  metadata; `stateUsesPyodideCodec` truth table; runtime-not-ready accessor
  throws.
- **Scenario (Playwright):** `tests/ui/scenario-real-codecs.mjs` — banner
  narration appears and resolves; real codecs disabled→enabled in the
  picker; add zstd to a pipeline, verify Encoded stage size drops and Read
  round-trips; offline-failure path (route-block the CDN, assert error
  banner + educational codecs still work).
- Existing 935 tests: untouched (nothing else goes async).

## Non-goals (this pass)

- No micropip / arbitrary Python packages; only numpy + numcodecs.
- No byte-level download percentage (Pyodide exposes no download progress
  without fetch interception); step narration only.
- No additional numcodecs beyond the trio (the registry makes more a
  follow-on, not a rearchitecture).
- No changes to educational codecs or the trace/metadata machinery.

## Risks / open items for the plan

- Pyodide-in-worker + Vite dev server: dynamic CDN import avoids bundling
  issues, but the plan's first task should be a spike proving
  load-in-worker works under both `npm run dev` and the production build.
- numcodecs wheel availability in the pinned Pyodide distribution must be
  verified at version-pinning time (it ships in the official package index).
- Node-side wheel caching for tests is a small helper; if it turns out
  fiddly, fall back to network-on-first-run with the skip flag documented.
