# 0x00C0DEC5 — Design Document

> **For the implementer**: this document is the complete specification. Build in the order described in the [Implementation Order](#implementation-order) section. Write tests for each engine module before moving to the next. Do not start on React components until the entire engine layer passes tests. If anything in this spec is ambiguous or seems contradictory, ask for clarification rather than guessing — a wrong assumption in the engine layer will cascade into every component built on top of it.

## Overview

0x00C0DEC5 is a web-based interactive tool that teaches how data file formats are constructed. Users define a dataset, then watch it transform step-by-step from human-readable values into opaque bytes on disk. Every file format — Parquet, GeoTIFF, Zarr, HDF5 — solves the same fundamental problems: how to structure data, encode it efficiently, and provide enough metadata to read it back. This tool lets people discover those problems firsthand by building a format from scratch.

The primary use case is a live conference talk where the presenter builds up a file format interactively with audience participation. A secondary use case is self-guided exploration, where users experiment with the tool independently, potentially loading presets that replicate real-world format designs.

**Target audience**: ranges from geospatial practitioners who use these formats daily but don't understand their internals, to CS students learning about serialization for the first time.

## Tech Stack

- **React + TypeScript** for the application
- **Vite** for build tooling and dev server
- **Static deployment** target (GitHub Pages, Vercel, or similar)
- No backend; all computation happens client-side

### Dependencies

Scaffolded via `npm create vite@latest 0x00c0dec5 -- --template react-ts`, which provides React, TypeScript, and Vite as baseline dev dependencies.

**Runtime dependencies:**

| Package | Purpose | Justification |
|---------|---------|---------------|
| `react-resizable-panels` | Drag-to-resize sidebar and comparison panes | Handles pointer capture, min/max constraints, keyboard accessibility, and persistence hooks correctly. Reimplementing this from scratch is surprisingly fiddly and error-prone (as the earlier prototypes demonstrated). |
| `@tanstack/react-virtual` | Virtual scrolling for hex, table, and flat views | Proven virtualizer that handles variable-size rows, scroll-to-index (needed for hover-driven scroll sync), and dynamic measurement. Writing a custom virtualizer that works reliably across browsers and doesn't fight with React's render cycle is a common source of bugs. |
| `immer` | Immutable state updates | The `AppState` object is deeply nested (field pipelines contain arrays of codec steps with param objects). Spreading nested updates by hand is verbose and error-prone. Immer's `produce()` keeps update logic readable. Optional but recommended. |

**Considered but not included:**

| Package | Reason to skip |
|---------|---------------|
| State management (Redux, Zustand, Jotai) | React's built-in `useState` + `useContext` + `useMemo` is sufficient. The state shape is complex but there's only one consumer tree. If prop drilling becomes painful during implementation, Zustand is the lightest option to add later. |
| CSS framework (Tailwind, styled-components) | The UI has a specific dark theme with precise color values. Inline styles or a single CSS module file with CSS custom properties is simpler than configuring a framework. A `theme.ts` constants file covers the design tokens. |
| Virtual scrolling alternatives (`react-window`, `react-virtuoso`) | `@tanstack/react-virtual` is headless (no opinionated DOM structure), which matters because the hex view and table view have very different row layouts. `react-window` is more prescriptive. |
| Drag-and-drop (for codec pipeline reordering) | Up/down buttons are sufficient for v1. Codec pipelines are typically 2-4 steps. If drag reordering is desired later, `@dnd-kit/core` is the best option. |
| MessagePack / CBOR library | For binary metadata serialization. Defer until the metadata assembly feature is implemented — a hand-rolled length-prefixed format may be more pedagogically transparent than a real serialization library. |
| Chart library | No charts in v1. The pipeline strip and entropy display are custom SVG/HTML. |
| Monospace font | Use a system font stack (`'JetBrains Mono', 'Fira Code', 'SF Mono', 'Cascadia Code', 'Consolas', monospace`). No need to bundle a web font — anyone with a dev-oriented system will have at least one of these, and the fallback `monospace` is fine. |

**Dev dependencies** (beyond Vite template defaults):

| Package | Purpose |
|---------|---------|
| `vitest` | Unit testing for the engine layer (dtypes, codecs, chunking, linearization, tracing). The pipeline logic is pure functions — highly testable and critical to get right. |
| `@testing-library/react` | Component testing if needed, though engine tests are higher priority. |

## Core Concepts

### The Unified Data Model

There is one data model, not two. A dataset consists of:

- **Shape**: an N-dimensional array of sizes (e.g., `[1000]` for tabular, `[256, 256]` for raster)
- **Variables**: a named, ordered set of variables, each with a data type. All variables share the dataset's shape.

A "tabular" dataset is simply a 1-d dataset where each variable (column) may have a different dtype. An "N-d array" dataset is a multi-dimensional dataset where variables (bands) often share a dtype but need not. The internal engine is identical; only the UI presentation differs (spreadsheet table vs. heatmap grid).

This unification is pedagogically important: it shows that tabular and raster formats are not fundamentally different — they solve the same problems at different dimensionalities.

### The Transformation Pipeline

The entire journey from human-readable values to bytes on disk is modeled as a single linear pipeline. The pipeline exists in full from the moment the tool loads, with every step initialized to a passthrough/no-op default. The user configures each step, and the output updates reactively.

The pipeline has three kinds of steps:

#### 1. Structural Steps
These change the topology of the data — how it's organized, not its byte content.

- **Chunk**: splits the dataset into chunks defined by a chunk shape. Before chunking, data is one logical array. After chunking, it's a collection of spatial slices. Chunking is uniform across all variables.
- **Linearization order**: for the array model with `shape.length > 1`, chooses the element-traversal order used to flatten each chunk's multi-dimensional elements into a 1-D byte stream (`data-testid="linearization-select"`, in the Chunk sidebar section beside the chunk shape inputs — rendered only when it's a meaningful choice; hidden for tabular data and 1-D arrays, which have only one possible order). Three options, all bijective (round-trip exactly, including under edge-clipped chunk dims at shape edges):
  - **C order (row-major)** — default, today's historical behavior, byte-identical to pre-linearization-setting output. Last dimension varies fastest.
  - **Fortran order (column-major)** — first dimension varies fastest.
  - **Morton (Z-order)** — bit-interleaved coordinates. Spatially nearby elements land near each other in the byte stream, visible directly in the hex view — this is the pedagogical payoff: C/Fortran order put a spatial neighbor on the opposite side of a row/column boundary arbitrarily far away in the byte stream, Morton keeps it close.

  This is orthogonal to Interleave below (which orders *variables* within a chunk); linearization orders *elements* within a chunk. `orderCoordsOf`/the linearization module (`src/engine/order.ts`) is the single pure index-mapping source of truth, consumed identically by the writer (`linearizeChunk`), the per-value tracing layouts, and the reader's de-linearization — so switching orders never desyncs any of write, hover-trace, or read.
- **Byte order (endianness)**: little-endian (default) or big-endian, applying to every multi-byte dtype regardless of data model or shape (`data-testid="byte-order-toggle"`, same Chunk section, not gated on array/ndim like linearization is — any scalar with a multi-byte dtype still has an endianness). This is Zarr v3's `bytes` codec `endian` parameter made an explicit, first-class setting rather than a silent little-endian assumption baked into `valuesToBytes`/`bytesToValues`. See "Metadata UI" below for the read-side lesson this setting is paired with.
- **Interleave**: within each chunk, determines how variables are arranged.
  - *Column-oriented / BSQ (band-sequential)*: each variable's bytes are stored contiguously within the chunk. Enables per-variable codec pipelines.
  - *Row-oriented / BIP (band-interleaved-by-pixel)*: variable bytes are interleaved per element. Forces a single codec pipeline on the mixed byte stream.

These structural steps constrain downstream operations. Interleaving determines whether codecs can be per-variable or must be per-chunk. This constraint is a key pedagogical insight the tool surfaces.

#### 2. Byte-Level Steps (Codecs)
Transform the bytes within the containers defined by structural steps. Codecs are:

- **Dtype-aware**: each codec knows its input dtype and declares its output dtype. Scale/offset converts float32 → int16. Entropy codecs output raw bytes (uint8).
- **Parameterized**: each codec has typed parameters (scale factor, element size, keep bits, etc.) with defaults, ranges, and UI controls.
- **Composable**: codecs form an ordered pipeline. The output dtype of one feeds the input dtype of the next.
- **Granularity follows interleaving**:
  - Column-oriented: each variable has its own independent codec pipeline
  - Row-oriented: one codec pipeline per chunk, operating on interleaved bytes

Users should be able to apply codecs that are "nonsensical" for the current configuration (e.g., byte shuffle on heterogeneous interleaved data). The tool shows a warning but does not block the operation. The garbled output *is the lesson* — it teaches why column orientation exists.

#### 3. Output Steps
Produce the final files.

- **Metadata Assembly**: collects all structural and encoding metadata accumulated through the pipeline (schema, shape, chunk layout/index, codec pipelines per variable or per chunk, plus user-defined arbitrary key-value pairs including geo metadata like CRS and affine transforms). The user chooses a serialization strategy (JSON text, binary, or potentially others). The output is serialized metadata bytes.
- **Write**: takes encoded chunk data + serialized metadata bytes and produces one or more files. Configuration includes:
  - **Magic number**: a user-defined byte sequence at the start and/or end of the file
  - **Partitioning**: single file or one file per chunk (like zarr's directory-of-chunks model)
  - **Metadata placement**: embedded as header, embedded as footer, or separate sidecar file
  - **Chunk ordering**: the order chunks appear in the file (row-major, column-major). This is a write-time concern that affects read access patterns but not data content.
  - **Chunk index**: byte offset table mapping chunk coordinates to locations in the file. Part of the metadata.

### Default Pipeline State

On first load, the full pipeline is present with these defaults:

| Step | Default |
|------|---------|
| Schema | 3 variables, small shape (~32 elements) |
| Chunk | chunk shape = full shape (single chunk, no splitting) |
| Interleave | Column-oriented |
| Codecs | Empty (no transforms, raw bytes pass through) |
| Metadata | Auto-collected structural metadata only, JSON serialization |
| Write | Single file, metadata as header, magic number `00 C0 DE C5`, row-major chunk order |

The user sees their data as human-readable values on the left and the output file bytes on the right immediately. Every change to any pipeline step updates the output reactively.

## Pipeline Stage Data Model

The pipeline is a fixed, ordered list of **7 stages** — `StageName` (`src/types/pipeline.ts`) is the single source of truth for stage identity, both for computation order and for what a persisted pane selection means:

```typescript
type StageName = 'values' | 'typed' | 'linearized' | 'encoded'
               | 'metadata' | 'write' | 'read';

const STAGE_ORDER: StageName[] = [
  'values', 'typed', 'linearized', 'encoded', 'metadata', 'write', 'read',
];
```

| Stage | Produces |
|-------|----------|
| **Values** | Human-readable logical values per variable (from `logicalType`), as float64 bytes for display purposes. |
| **Typed** | Each variable's logical values converted to its `typeAssignment.storageDtype` (see "Logical Types and Type Assignment" above). |
| **Linearized** | Typed values chunked (per `chunkShape`) and interleaved (row/column) into byte order. |
| **Encoded** | Each chunk's (or each variable's, in column mode) codec pipeline applied. |
| **Metadata** | The serialized metadata bytes (JSON or binary) — see Metadata Assembly below. |
| **Write** | The final assembled virtual file(s) — magic, metadata placement, chunk ordering, partitioning. |
| **Read** | The result of reading the Write stage's file(s) back — reconstructed values on success, or a failure state (see the Read Step extension). |

Stages are identified **by name**, not by index — a persisted pane selection stores a `StageName` string so it survives the stage list growing (it already has, twice: Typed was added when scale/offset moved out of the codec pipeline, then Read was added by the read extension). Each stage carries:

```typescript
interface PipelineStage {
  name: string;                  // Display name (e.g., "Values", "Typed", "Read")
  bytes: Uint8Array;             // The byte content at this stage
  traces: ByteTrace[];           // Per-byte provenance, one entry per byte
  chunkRegions: ChunkRegion[];   // Byte ranges labeled by chunk/structural region, for hex-view sectioning
  stats: {
    byteCount: number;
    entropy: number;             // Shannon entropy (bits/byte)
  };
}
```

### Byte Tracing

Every byte in the pipeline carries provenance information linking it back to its source value. This enables the cross-stage hover interaction: hover a value in the table view and see the corresponding bytes highlight in the hex view of a later stage.

```typescript
interface ByteTrace {
  traceId: string;               // Unique ID: "{variableName}:{flatIndex}"
  variableName: string;
  variableColor: string;         // For visual grouping
  coords: number[];              // N-d coordinates in the original shape
  displayValue: string;          // Human-readable source value
  dtype: string;                 // Dtype at this stage (may differ from source after scale/offset)
  chunkId: string;               // Which chunk this byte belongs to
  byteInValue: number;           // Position within the typed value (0..dtypeSize-1)
  byteCount: number;             // Total bytes for this value at this stage
}
```

**Tracing fidelity degrades through the pipeline**, and this is intentional:

- **Values stage**: perfect per-value tracing.
- **Typed stage**: perfect per-value tracing — the dtype conversion (and any scale/offset/keepBits from Type Assignment) is a byte-count change per value at most (e.g. float64 display bytes → int16 storage bytes), still a clean one-to-one mapping from source value to its typed bytes.
- **Linearized stage**: perfect per-value tracing, bytes are just chunked and reordered.
- **After reordering codecs (Delta, Byte Shuffle)**: per-value tracing preserved (`propagateTracesValuePreserving` in `src/engine/trace.ts`) — these codecs never change the byte count, so the mapping stays one-to-one.
- **After entropy codecs (RLE, LZ)**: tracing drops to chunk-level (`degradeTracesToChunkLevel`). These are the only size-changing steps left in the codec registry (scale/offset, the other historical size-changer, is no longer a codec — see Logical Types and Type Assignment above). Individual bytes can no longer be mapped to specific source values; hovering highlights all values from the source chunk instead.

This degradation is pedagogically valuable: it shows that entropy coding makes data opaque and that you need metadata to reverse the process.

## Data Types

The type registry includes:

| Type | Size | Signed | Float | Range |
|------|------|--------|-------|-------|
| int8 | 1 | yes | no | -128 to 127 |
| uint8 | 1 | no | no | 0 to 255 |
| int16 | 2 | yes | no | -32768 to 32767 |
| uint16 | 2 | no | no | 0 to 65535 |
| int32 | 4 | yes | no | -2.1B to 2.1B |
| uint32 | 4 | no | no | 0 to 4.2B |
| float32 | 4 | yes | yes | ±3.4×10³⁸ |
| float64 | 8 | yes | yes | ±1.8×10³⁰⁸ |

All multi-byte types use little-endian encoding (matching most modern hardware and formats like Zarr, Parquet, GeoTIFF).

This is the **storage** type registry — the dtype bytes are actually written as. It is a separate concept from the **logical type** a variable is defined with (see "Logical Types and Type Assignment" below): a user picks a logical type ("a decimal between -50 and 50 with 1 decimal place") and separately chooses which of these eight storage dtypes to encode it into. That choice — not a codec — is where precision/size tradeoffs like float→int quantization and mantissa bit-rounding now live.

## Logical Types and Type Assignment

Earlier drafts of this tool modeled float→int quantization and mantissa-bit-rounding as codecs ("Scale/Offset" and "Bit Round"). The shipped design instead splits data generation and storage into two explicit concepts, with a dedicated pipeline stage between them:

- **Logical type** (`Variable.logicalType`): describes what a human-meaningful value looks like, independent of how it's stored. There are three kinds:

  ```typescript
  type LogicalType = 'integer' | 'decimal' | 'continuous';

  interface LogicalTypeConfig {
    type: LogicalType;
    min: number;
    max: number;
    decimalPlaces?: number;       // decimal only — e.g. 1 → values like 23.4
    significantFigures?: number;  // continuous only
  }
  ```

  `integer` generates whole numbers in `[min, max]`. `decimal` generates values with a fixed number of decimal places (a stand-in for "realistic sensor precision," e.g. temperature to 1 decimal place). `continuous` generates full-precision floating point values within the range. This is the Values stage's data source — the numbers a spreadsheet-literate user would recognize.

- **Type assignment** (`Variable.typeAssignment`): the pedagogical "choose a dtype" step — how those logical values get converted into storage bytes.

  ```typescript
  interface TypeAssignment {
    storageDtype: DtypeKey;
    scale?: number;    // for integer storage of decimal/continuous values
    offset?: number;   // for integer storage of decimal/continuous values
    keepBits?: number; // for float precision reduction (mantissa bits kept)
  }
  ```

  If `scale`/`offset` are set, the Typed stage computes `(value - offset) × scale` before casting into `storageDtype` — the same transform the old "Scale/Offset" codec performed, now framed as "you're storing a decimal value in an integer dtype, so you need a scale factor to preserve precision" rather than as a pipeline step. If `keepBits` is set on a float `storageDtype`, mantissa bits beyond `keepBits` are zeroed after conversion — the same transform the old "Bit Round" codec performed. Both are still genuinely lossy in exactly the ways the old codecs were (integer clamping/rounding, irrecoverable mantissa truncation); only where they live in the pipeline changed.

This distinction is pedagogically sharper than the old model: it separates "what does this value mean" (logical type) from "how many bytes do I spend representing it, and what do I give up by doing so" (type assignment) — the same question every real format's schema answers (Parquet's logical vs. physical types, GeoTIFF's sample format, Zarr's dtype + filters).

### The Typed Pipeline Stage

Converting logical values to storage bytes is its own pipeline stage, **Typed**, sitting immediately after **Values** and before **Linearized** (see Pipeline Stages below). The Typed stage's byte content is exactly what `assignType()` produces per variable, concatenated; its traces carry the storage dtype and the human-readable (pre-conversion) display value, so hovering a Typed-stage byte still shows the original logical value even though the bytes are now, say, int16.

`assignType()` also tracks per-variable statistics (`VariableStats`): count, min/max/mean (NaN-aware — NaN inputs are counted separately in `nanCount` and excluded from min/max/mean rather than poisoning them), `clipped` (values clamped to the storage dtype's range), `rounded` (values that lost precision), and `isLossy` (`clipped > 0 || rounded > 0`). These stats feed both the Metadata stage (as `variable_statistics`) and the diff view's lossy-variable flagging.

## Codec Registry

Codecs are zarr-inspired but use friendlier naming. With scale/offset and bit-round moved into Type Assignment (above), there are two remaining codec categories — **reordering** and **entropy**; the **mapping** category from earlier drafts no longer exists. Each codec declares:

```typescript
interface CodecDefinition {
  key: string;                    // Unique identifier
  label: string;                  // Display name
  category: "reordering" | "entropy";
  runtime?: "pyodide";             // present only for numcodecs-via-WebAssembly codecs
  description: string;            // Tooltip/help text
  params: Record<string, ParamDef>;
  applicableTo: (dtype: string) => boolean;  // Which input dtypes are meaningful
  isLossy: (inputDtype: DtypeKey) => boolean; // Whether encode->decode loses information for this input dtype
  encode: (bytes: Uint8Array, inputDtype: string, params: Record<string, any>) => {
    bytes: Uint8Array;
    outputDtype: string;
  };
  decode: (bytes: Uint8Array, encodedDtype: string, params: Record<string, any>) => {
    bytes: Uint8Array;
    outputDtype: string;
  };
}

interface ParamDef {
  label: string;
  type: "number" | "select";
  default: any;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];             // For "select" type
}
```

`isLossy` is a **predicate over the input dtype**, not a plain boolean — this deviates from `docs/extension-read-step.md`'s original `lossy: boolean` field (see that doc's own note on the deviation). A single boolean cannot express Delta's actual behavior: after removing an early clamping bug, Delta's encode/decode is an exact modular round-trip for every integer dtype (typed-array writes wrap mod 2^N, so a negative diff on an unsigned dtype is not clamped away — it wraps and un-wraps exactly), but Delta is still lossy on float dtypes, because each difference gets re-rounded to the float's own precision. `isLossy(dtype)` is the minimum shape that can say "exact for integers, lossy for floats."

### The Curated Codec Set

Earlier drafts split codecs into an "educational" tier (hand-rolled, always available) and a "real" tier (actual numcodecs running in Python via Pyodide/WebAssembly), presented as two visually separated groups in the picker. That split was a false taxonomy: every codec here is the same shape — stride-aware `encode(bytes, inputDtype, params) → { bytes, outputDtype }` — and composes freely with every other one, "real" or not. The picker is now **one flat list, no group labels, no "(real)" suffixes**, in `CODEC_REGISTRY` insertion order (`src/engine/codecs.ts`), which the picker iterates directly — that order runs transforms → structural/symbol compression → entropy coders, so the list itself hints at sensible pipeline order without enforcing it:

**Delta → Zigzag → Byte Shuffle → Bit Shuffle → Dictionary → RLE → Deflate → GZip → Zstd**

Whether a codec's `encode`/`decode` is hand-rolled locally or delegates to numcodecs-via-Pyodide is an implementation detail carried on `CodecDefinition.runtime` (`'pyodide'` when true, `undefined` for local). Pyodide-backed entries render disabled (with a `(loading…)`/`(unavailable)` suffix) until the runtime reports ready — see "Codec Runtime" below — but nothing else about them differs from local codecs: same registry, same params/warnings/dtype-flow machinery, same picker position.

**Reordering codecs** (rearrange bytes for better compressibility, dtype-preserving; `isLossy` varies):

| Codec | Params | Input → Output | isLossy | Description |
|-------|--------|---------------|---------|-------------|
| Delta | order: number (1-3) | any non-float → same | float dtypes only | Store value-to-value differences via typed-array arithmetic (wraps mod 2^N for integers — exact round-trip on every integer dtype, including unsigned). Lossy only on float dtypes, where each difference is re-rounded to float precision. `applicableTo` returns false for float dtypes, surfacing the ⚠ warning there. |
| Zigzag | — | signed int8/16/32 → same | never | Maps signed integers to unsigned so small magnitudes get small byte values (0→0, −1→1, 1→2, −2→3, …) — the transform Parquet applies before RLE/bit-packing. Bijective, byte width unchanged. `applicableTo` is signed-integer-only; other dtypes warn (advisory, not blocked). |
| Byte Shuffle | elementSize: number (1-8) | any → same | never | Transpose bytes by position within each element (Parquet calls this BYTE_STREAM_SPLIT). `applicableTo` returns false for 1-byte dtypes (nothing to transpose). A **separate** param-aware warning (not expressible via `applicableTo`, which only sees the dtype) fires when `elementSize` doesn't match the actual input dtype's size — this is the "shuffle needs to know the element boundary" lesson; garbled output is intentional, not blocked. |
| Bit Shuffle | — | any multi-byte → same | never | Byte Shuffle one level finer: transposes the *bits* of a block of elements into bit planes (all elements' bit 0, then bit 1, …) rather than whole bytes. Slowly varying data yields long constant bit runs — this is the transform inside blosc/bitshuffle, pulled out as its own standalone, bijective step. |

**Entropy/compression codecs** (compress redundancy; always applicable, byte-wise; output dtype collapses to `uint8`):

| Codec | Params | isLossy | Backing | Description |
|-------|--------|---------|---------|-------------|
| Dictionary | — | never | local | Parquet's workhorse: distinct fixed-stride values go into a dictionary, the stream becomes indices into it. Self-contained format — `[stride][dictCount][dict bytes][indexWidth][indices]` — great for low-cardinality data, and pairs naturally with RLE on the index stream (as Parquet itself does). |
| RLE | — | never | local | Run-length encoding: `(count, value)` byte pairs, one byte each (count capped at 255, so a run longer than 255 splits into multiple pairs). The one codec whose output stays legible in the hex view. |
| Deflate | level: number (1-9) | never | numcodecs (`zlib`), via Pyodide | The algorithm inside GZip, in a bare zlib container — compare the first bytes with GZip's `1f 8b` magic: same compressed stream, different wrapper. |
| GZip | level: number (0-9) | never | numcodecs, via Pyodide | Real DEFLATE/gzip — the same algorithm behind `.gz` files and PNG. |
| Zstd | level: number (1-22) | never | numcodecs, via Pyodide | Real Zstandard — the default compressor in modern Zarr. |

All entropy/compression codecs collapse the output dtype to `uint8` — this is the dtype-flow rule below.

**Deliberately excluded**: `lz` (the earlier hand-rolled LZ77) and `blosc` were both **deleted**, not deprecated — unknown codec keys in saved states/pipelines are already tolerated (skipped) by the engine and UI, so old saves referencing them degrade gracefully rather than erroring. `lz` was redundant next to the real compressors above. Blosc was rejected as a *meta-compressor*: it bundles a shuffle choice and a compressor choice into one opaque codec, which is confusing as a teaching object in a tool built around showing pipeline steps as separable — its bitshuffle half lives on as the standalone Bit Shuffle transform above. Also out: CRC32C (checksums teach nothing about how data composes into a file), bit-packing (bit-granularity size-changing output, unlike the size-preserving Bit Shuffle), Snappy and standalone LZ4 (no clean Pyodide backing, and Zstd/GZip already cover the "real compressor" lesson). Sharding (Zarr v3's `sharding_indexed`) was considered and rejected as a codec entirely — it conflates storage layout with encoding, and that concern already has a home in the Write step's partitioning options (see "Write Step" below), not the codec pipeline.

### Codec Applicability and Warnings

Codecs declare which dtypes they're applicable to via `applicableTo()`. When a codec is applied to an inapplicable dtype (e.g., Delta on a float, or Byte Shuffle on a 1-byte dtype), the UI shows a warning but does **not** prevent the operation. The result may be garbage (or, for Delta on float, merely re-rounded) — and that's intentional. The user learns through experimentation why certain codecs require certain data layouts.

**Warning UI**: `stepWarnings()` (`src/engine/codecs.ts`) is the single source of truth for both the per-step ⚠ icon in `CodecPipelineEditor` and the Encoded-stage ⚠ icon in the pipeline strip (`pipeline-stage-encoded-warning`). It combines two independent checks:

- `codec.applicableTo(dtype)` at each step's actual running input dtype (computed via the dtype-flow rule below, not re-derived locally).
- Byte Shuffle's `elementSize` param against the step's actual input dtype size — a mismatch here is a *separate* warning from `applicableTo`, since `applicableTo` never sees the step's params.

Hovering or clicking the icon shows the warning text (e.g., "Delta on Float32 is lossy — differences are re-rounded to float precision each step..." or "Element size 2 doesn't match dtype size 4 — bytes will be grouped incorrectly...").

Additionally, when the interleaving is set to row-oriented and the variables have heterogeneous dtypes, the codec section's explanatory callout should note: "Mixed dtypes are interleaved — codecs like Byte Shuffle and Delta that assume uniform element size will produce garbled output. This is a key reason column-oriented formats exist."

When a codec produces output **larger** than its input (e.g., RLE on random data), the byte count in the pipeline strip node and the codec step annotation should display in the `warning` color to draw attention to the size increase.

### Codec Pipeline Display and the Dtype-Flow Rule

Each step in the pipeline editor shows the output dtype as an annotation (e.g., "Byte Shuffle →int16"). The dtype flows through the pipeline via one rule, `outputDtypeFor(codec, inputDtype)` (`src/engine/codecs.ts`) — the single source of truth, called by both the codec pipeline executor and the UI's warning/annotation logic (never re-implemented locally):

```typescript
function outputDtypeFor(codec: CodecDefinition, inputDtype: DtypeKey): DtypeKey {
  return codec.category === 'entropy' ? 'uint8' : inputDtype;
}
```

Entropy/compression codecs (Dictionary, RLE, Deflate, GZip, Zstd) always collapse the running dtype to `uint8`; reordering codecs (Delta, Zigzag, Byte Shuffle, Bit Shuffle) always preserve it. Each step's `encode()` input dtype is the previous step's `outputDtype` (or the variable's `typeAssignment.storageDtype` for the first step) — this makes it visible when a codec is receiving unexpected input, and keeps the pipeline's dtype bookkeeping in exactly one place.

### Codec Runtime

Three codecs (Deflate, GZip, Zstd) delegate `encode`/`decode` to actual `numcodecs` — the same Python library Zarr uses — running in-browser via Pyodide (Python compiled to WebAssembly). This is invisible to the pipeline machinery (same `CodecDefinition` shape, same registry, same picker), but the runtime has to load before those three codecs can run:

- The worker initializes Pyodide **eagerly at startup**, independent of whether the current configuration uses a Pyodide-backed codec. A compute is only gated on that init promise when the posted state actually references a `runtime: 'pyodide'` codec (`stateUsesPyodideCodec()` in `src/engine/codecs.ts`, checked against both `fieldPipelines` and `chunkPipeline`); states that don't use one compute immediately, so boot is never delayed by the download.
- While loading, a slim banner under the Header narrates progress: **"Loading compression runtime: …"**. On success it disappears silently. On failure (offline, CDN unreachable) it becomes a dismissible error banner: **"Compression codecs unavailable: {error}. Everything else works — the other codecs are unaffected."** — the six local codecs (Delta, Zigzag, Byte Shuffle, Bit Shuffle, Dictionary, RLE) are never affected by a Pyodide failure.
- In the picker, Pyodide-backed entries render disabled (with a `(loading…)`/`(unavailable)` suffix) until the runtime reports ready. A saved pipeline that already references one of them is never blocked by the UI — only the compute itself waits on/fails against the runtime.

## UI Architecture

### Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│  Header: Title (0x00C0DEC5) + Data Model Toggle (Tabular / N-d Array)    │
├────────────┬─────────────────────────────────────────────────────────┤
│            │  Pipeline Strip (horizontal, all stages, with stats)     │
│            ├─────────────────────────────────────────────────────────┤
│  Sidebar   │  Hover Info Bar (traces hovered value across stages)    │
│  (config)  ├────────────────────────┬────────────────────────────────┤
│            │  Left Pane             │  Right Pane                    │
│  Schema    │  [dropdown: stage]     │  [dropdown: stage]             │
│  Chunk     │  [radio: view mode]    │  [radio: view mode]            │
│  Interleave│                        │                                │
│  Codecs    │  (viewer content)      │  (viewer content)              │
│  Metadata  │                        │                                │
│  Write     │                        │                                │
│            │                        │                                │
└────────────┴────────────────────────┴────────────────────────────────┘
```

### Design Tokens

The application uses a dark theme optimized for presenting on projectors (high contrast, not too bright). All color and spacing values are defined as CSS custom properties in a `theme.ts` constants file and applied via a root-level CSS variables declaration.

**Colors:**

```typescript
const theme = {
  // Backgrounds (darkest to lightest)
  bg:            "#0d1117",   // App background
  surface:       "#161b22",   // Cards, panel backgrounds, sticky headers
  surfaceInput:  "#1c2129",   // Input fields, dropdowns
  surfaceHover:  "#21262d",   // Hover states on surfaces

  // Borders
  border:        "#30363d",   // Primary borders, dividers
  borderSubtle:  "#21262d",   // Subtle internal dividers (e.g., table rows)

  // Text
  textPrimary:   "#e6edf3",   // Primary content
  textSecondary: "#8b949e",   // Labels, secondary info
  textTertiary:  "#484f58",   // Placeholders, disabled, offsets in hex view

  // Accent
  accent:        "#58a6ff",   // Interactive elements, active states, links
  accentDim:     "#58a6ff18", // Accent backgrounds (buttons, selections)

  // Pane border colors (fixed, used to distinguish left/right panes)
  paneLeft:      "#58a6ff",   // Blue
  paneRight:     "#d19a66",   // Orange

  // Variable colors (assigned round-robin to variables)
  variableColors: [
    "#e06c75",  // red
    "#61afef",  // blue
    "#98c379",  // green
    "#d19a66",  // orange
    "#c678dd",  // purple
    "#56b6c2",  // cyan
    "#e5c07b",  // yellow
    "#be5046",  // dark red
    "#7ec8e3",  // light blue
    "#c3e88d",  // light green
  ],

  // Semantic
  warning:       "#d19a66",   // Codec applicability warnings
  warningDim:    "#d19a6615",
  info:          "#58a6ff",
  infoDim:       "#58a6ff10",
};
```

**Typography:**

```typescript
const fonts = {
  sans: "'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif",
  mono: "'JetBrains Mono', 'Fira Code', 'SF Mono', 'Cascadia Code', 'Consolas', monospace",
};

const fontSizes = {
  xs:   10,   // Labels, tertiary info, byte offsets
  sm:   11,   // Secondary text, codec categories, small buttons
  base: 12,   // Body text, input fields, hex bytes
  md:   13,   // Dropdown values, stage names
  lg:   15,   // Section headers, app title
};
```

**Spacing:** use a 4px base unit. Common values: 4, 8, 10, 12, 16, 20, 24. Padding inside panels is 12px. Gap between sidebar sections is 14px. Pipeline strip node padding is 4px 10px.

**Border radius:** 4px for small elements (badges, inline buttons), 5-6px for inputs and cards, 14-16px for pill buttons (model toggle).

A horizontal bar showing all pipeline stages as connected nodes. Each node displays:
- Stage name
- Byte count at that stage
- Shannon entropy (bits/byte)

Arrows connect stages left-to-right to reinforce the flow metaphor. The strip scrolls horizontally if stages overflow.

The pipeline strip is non-interactive beyond visual information — stage selection happens via the pane dropdowns.

### Dual Comparison Panes

Two side-by-side panes, each independently selectable to any pipeline stage via a dropdown. Default: left = Values, right = final output (Write). Each pane has a view mode radio group:

**For the Values stage:**
- **Table** (tabular data): spreadsheet-style with variable names as column headers, row indices, values in cells
- **Grid** (array data): 2D heatmap grid with variable selector tabs, color intensity mapped to value range
- **Hex**: raw bytes in standard hex dump format
- **Flat**: value-per-line list with variable indicator, coordinates, hex bytes, and decoded value

**For all other stages:**
- **Hex**: standard hex dump with offset column, hex bytes (colored by source variable), ASCII column
- **Flat**: value-per-line list

View modes are presented as a segmented radio control (all options visible, active one highlighted).

### Hover Interaction

Hovering any value or byte in either pane highlights the corresponding data in the other pane (via shared `traceId`). The hover info bar between the pipeline strip and the panes shows:

- The hovered value's label (e.g., "temperature[7]")
- Its human-readable value
- Byte count at each pipeline stage

After entropy coding, hovering highlights all values from the same chunk rather than individual values (see Byte Tracing above).

### Sidebar

A scrollable panel containing configuration for each pipeline step, separated by dividers. Sections appear in pipeline order:

1. **Schema**: variable name/dtype editors, shape input, add/remove variables
2. **Chunk**: chunk shape input, resulting chunk count display
3. **Interleave**: radio toggle (row/column with data-model-appropriate labels)
4. **Codecs**: depends on interleaving mode
   - Column mode: per-variable pipeline editors, each labeled with variable name/color/dtype
   - Row mode: single per-chunk pipeline editor
   - Both modes show a contextual explanation of why the codec granularity differs
5. **Metadata**: auto-collected metadata display, arbitrary key-value editor, serialization format selector
6. **Write**: magic number input, partitioning toggle, metadata placement selector, chunk ordering selector

### Virtual Scrolling

All data views (table, hex, flat) use virtual scrolling to handle datasets with thousands of elements. Only visible rows plus a small buffer are rendered. Row height is fixed per view type.

### Full-Height Layout

The application fills the viewport (`height: 100vh`). The sidebar and panes flex to fill available space. No content should overflow the viewport requiring page-level scrolling.

### Resizable Panels

All major layout boundaries are drag-resizable:

- **Sidebar ↔ main area**: a vertical drag handle on the sidebar's right edge. The sidebar has a reasonable minimum width (~200px) and maximum (~450px). The main area takes the remaining space.
- **Left pane ↔ right pane**: a vertical drag handle between the two comparison panes. Either pane can be collapsed to near-zero or expanded to fill the main area. This lets the presenter focus on a single view during the talk, or compare two stages side-by-side.

Drag handles should be visually subtle (a thin line or dots pattern that highlights on hover) but with a generous hit target (~6-8px). The cursor should change to `col-resize` on hover. Panel sizes should be persisted as part of the UI state so they survive page reloads.

## State Management

### Persistent State

All pipeline configuration is persisted to `localStorage` with a debounced save (500ms after last change), flushed synchronously on `pagehide` so edits in the final 500ms before the tab closes aren't lost. State is restored on page load.

The persistence layer is a thin abstraction (`src/state/persistence.ts`) with `loadState(model): AppState | null` and `saveState(state): void`, plus `loadActiveModel()`/`saveActiveModel()` for the third storage key described below — so the storage backend can be swapped later if needed (e.g., to IndexedDB for larger state, or to URL hash encoding for shareable links).

**Three storage keys**, not one:

- `"0x00c0dec5-state-tabular"` and `"0x00c0dec5-state-array"` — one per data model, so switching models doesn't destroy the other model's configuration.
- `"0x00c0dec5-active-model"` — records whichever model the user was last looking at, so a fresh page load restores it (rather than always defaulting to tabular).

The persisted state object (verbatim from `src/types/state.ts`):

```typescript
type LogicalType = "integer" | "decimal" | "continuous";

interface LogicalTypeConfig {
  type: LogicalType;
  min: number;
  max: number;
  decimalPlaces?: number;       // decimal only
  significantFigures?: number;  // continuous only
}

interface TypeAssignment {
  storageDtype: DtypeKey;
  scale?: number;    // for integer storage of decimal/continuous
  offset?: number;   // for integer storage of decimal/continuous
  keepBits?: number; // for float precision reduction
}

interface Variable {
  id: string;
  name: string;
  logicalType: LogicalTypeConfig;
  typeAssignment: TypeAssignment;
  color: string;
}

interface AppState {
  dataModel: "tabular" | "array";
  shape: number[];
  chunkShape: number[];
  interleaving: "row" | "column";
  linearization: "c" | "fortran" | "morton";  // default 'c'; array model, ndim > 1 only — see "Linearization Order" below
  byteOrder: "little" | "big";                // default 'little'; both data models, any ndim — see "Byte Order" below
  variables: Variable[];
  fieldPipelines: Record<string, CodecStep[]>;  // keyed by Variable.id (not name — see below)
  chunkPipeline: CodecStep[];                    // per-chunk, used in row mode
  metadata: {
    customEntries: { key: string; value: string }[];
    serialization: "json" | "binary";
    include: MetadataIncludeConfig;  // six granular toggles — see "Metadata UI" below (supersedes the old single includeChunkIndex boolean; chunkIndex is now one of the six groups)
  };
  write: {
    includeMetadata: boolean;     // default false — see the Read Step extension
    magicNumber: string;          // hex string
    partitioning: "single" | "per-chunk";
    metadataPlacement: "header" | "footer" | "sidecar";
    chunkOrder: "row-major" | "column-major";
    footerLocator: "trailer" | "none";  // default 'trailer' — see "Footer Locator" under Write Step
  };
  ui: {
    leftPaneStage: StageName;     // one of the 7 stage names, not an index
    rightPaneStage: StageName;    // default 'write'
    leftPaneView: string;
    rightPaneView: string;
    showDiff: boolean;
  };
}

interface CodecStep {
  codec: string;                  // codec key
  params: Record<string, number | string>;
}
```

Two shapes worth calling out because they changed since the tool's first draft:

- **`fieldPipelines` is keyed by `Variable.id`, not `Variable.name`.** Names are user-editable and can collide (two variables named the same thing, or one renamed onto an existing name); keying by name meant a rename or collision could silently clobber or delete another variable's codec pipeline. The file format itself still keys `codec_pipelines` by variable *name* (see Metadata Assembly) — the id→name translation happens once, at metadata-collection time, not throughout the app. One consequence: duplicate variable names are now harmless to the pipeline itself (each variable still has its own pipeline, keyed by its own id) — the UI still flags duplicate/empty names with a warning border, because the *file format* keys by name and a written file with duplicate variable names is genuinely ambiguous to a reader.
- **`ui.leftPaneStage`/`rightPaneStage` are `StageName` strings, not numeric indices**, and there is no `-1` sentinel. Persisting an index into a list that has already grown twice (Typed, then Read) meant an old save's index quietly pointed at the wrong stage after the list grew. Stage names are stable under list growth; `rightPaneStage` defaults to `'write'` (a real, correct default — not a sentinel resolved elsewhere).
- `ui.sidebarWidth`/`ui.leftPaneRatio` from earlier drafts don't exist — panel sizing is handled entirely by `react-resizable-panels`' own persistence, not app state.

### State Updates

The reducer (`src/state/useAppState.ts`) groups actions into three shapes rather than one setter action per field:

1. **Semantic actions** for anything with real validation or structural consequences: `SET_SHAPE` (clamps/pads `chunkShape` to match), `SET_CHUNK_SHAPE` (rejects empty/non-positive/wrong-length shapes, mirroring `SET_SHAPE`), `ADD_VARIABLE`/`REMOVE_VARIABLE`/`UPDATE_VARIABLE`, `SET_INTERLEAVING`, `SET_FIELD_PIPELINE`/`SET_CHUNK_PIPELINE`, and the metadata custom-entry CRUD actions (`ADD_METADATA_ENTRY`/`REMOVE_METADATA_ENTRY`/`UPDATE_METADATA_ENTRY`).
2. **Three patch actions** for plain-object config sections with no cross-field validation: `UPDATE_WRITE` (merges into `state.write`), `UPDATE_METADATA_CONFIG` (merges into `state.metadata`'s `serialization`/`includeChunkIndex`), `UPDATE_UI` (merges into `state.ui`). These replaced roughly a dozen one-field setter actions from earlier drafts.
3. **`SET_DATA_MODEL`** is intentionally a pure, storage-free reducer case — it only flips `state.dataModel`. The actual model-switch sequence (save the outgoing model's state, load the incoming model's state or default, force `dataModel` onto the resolved state, record the new active model, then swap it in) lives in a `switchDataModel()` wrapper exposed alongside `dispatch`, which dispatches a `REPLACE_STATE` action with the fully-resolved state. Keeping storage I/O out of the reducer body matters under React StrictMode, which double-invokes reducers.

### Migration Behavior

`loadState(model)` runs three passes before state reaches the app, each with a defined fallback:

1. **`migrateState`**: handles the one known historical shape migration (variables that carried a flat `dtype` field instead of `logicalType`/`typeAssignment` get synthesized logical types and their pipelines get stripped of the now-nonexistent `scale-offset`/`bitround` codec steps). Returns `null` (→ treated as absent, falls through to defaults) if migration itself throws.
2. **`deepMergeDefaults`**: recursively merges the migrated state over `DEFAULT_STATE`, field by field — anything missing at any level (a newer field like `write.footerLocator` that didn't exist when the save was written) is filled in from the default. `fieldPipelines` is treated as an open-ended dictionary (all of the source's own keys are kept, not just keys present in the default) rather than a fixed shape.
3. **`validateState`**: structural validation on the merged result — invalid `variables` entries are dropped; a non-array or empty/non-positive `shape` resets the *entire* state to defaults (there's no sane partial recovery from a corrupt shape); `chunkShape` is clamped/padded to match `shape` exactly as `SET_SHAPE` does; `leftPaneStage`/`rightPaneStage` migrate old numeric indices (including the old `-1` sentinel, mapped to `'write'`) to `StageName`s via `STAGE_ORDER`, falling back to the default stage name if unrecognized; `fieldPipelines` keys are re-matched — a legacy key equal to some variable's *name* (not id) is re-keyed to that variable's id, and any key matching neither an id nor a name is dropped.

Every fallback in this chain returns a deep clone of `DEFAULT_STATE`'s data (never a live reference to it), so a caller mutating a loaded-and-defaulted state can never corrupt the shared default object for the rest of the session.

### Model Switching

Switching between "Tabular" and "N-d Array" changes the UI presentation but does not destroy state unnecessarily. The current state is saved before switching, and restored if the user switches back. Each data model has a separate saved state slot, and the switch is recorded so a reload returns to the model that was active (see "Persistent State" above).

### Presets (v2)

Named state snapshots that can be loaded. Built-in presets would replicate real-world formats:
- "This is basically Parquet" (tabular, column-oriented, per-column codecs, footer metadata)
- "This is basically GeoTIFF" (2D array, tiled chunks, metadata header)
- "This is basically Zarr" (N-d array, per-chunk files, sidecar metadata)

A "Custom" preset auto-saves the user's current configuration. Selecting a built-in preset doesn't destroy the custom state.

Not yet built — see `docs/remediation-plan.md` decision D10 for the pinned design once this is implemented.

## Data Generation

For the v1 tool, data is generated client-side using a deterministic PRNG (seeded by variable name + global seed). This ensures reproducible output across page reloads.

Generation is simple: uniform random within the dtype's range. The seed ensures different variables produce different data.

**v2 additions** (future): correlated data along dimensions (simulates spatial autocorrelation), sorted data (simulates indexed columns), constant regions (demonstrates RLE effectiveness), user-provided data upload.

## Metadata Assembly

The metadata view is a dedicated section in the sidebar (and potentially a selectable stage in the pipeline) that shows all accumulated metadata:

### Auto-Collected Metadata
Generated automatically from the pipeline configuration:
- **Schema**: variable names, dtypes, variable count
- **Shape**: dataset dimensions
- **Chunk layout**: chunk shape, chunk count, chunk grid dimensions
- **Chunk index**: byte offsets mapping chunk coordinates to file positions (generated at write time)
- **Codec pipelines**: per-variable or per-chunk, with all parameters
- **Byte order**: endianness

### User-Defined Metadata
Arbitrary key-value string pairs. The UI provides an "add entry" button. For geospatial use cases, this is where CRS (as a WKT or PROJ string) and affine transform coefficients would be added. The tool does not interpret these values — they're opaque strings that get serialized alongside the structural metadata.

This is pedagogically powerful for the geospatial audience: it shows that "geo" formats are just regular data formats with a few extra metadata keys. The CRS isn't magic — it's a string in a metadata dictionary.

### Serialization
The user chooses how metadata is serialized via a radio toggle:

**JSON** (default): The metadata object is serialized as pretty-printed JSON text, then encoded to UTF-8 bytes. The sidebar shows a read-only preview of the JSON (truncated if long, expandable). This is the recommended default because users can read it.

**Binary**: A simple length-prefixed binary format designed to be pedagogically transparent — the user can see the structure in the hex view. The format is:

```
[4 bytes] entry count (uint32 LE)
For each entry:
  [4 bytes] key length in bytes (uint32 LE)
  [N bytes] key (UTF-8)
  [4 bytes] value length in bytes (uint32 LE)
  [M bytes] value (UTF-8 for strings, or raw bytes for numeric arrays)
```

The auto-collected metadata entries use well-known keys: `"schema"`, `"shape"`, `"chunk_shape"`, `"chunk_grid"`, `"chunk_index"`, `"codec_pipelines"`, `"byte_order"`. User-defined entries use their literal key strings. Values for structured entries (schema, codec pipelines) are JSON-encoded strings within the binary container — this is intentionally a hybrid to keep the binary format simple while still supporting nested structure.

The sidebar preview for binary mode shows the entry list with key names and byte sizes, plus total serialized size.

### Metadata UI

The Metadata section in the sidebar contains:

1. **Auto-collected entries** (read-only): a collapsible list showing each auto-collected metadata key, its value (or a summary for large values like chunk index), and byte size. These update automatically as the pipeline configuration changes.

2. **Custom entries**: an editable list of key-value pairs. Each row has a text input for the key, a text input for the value, and a delete button. An "Add entry" button appends a new blank row. For the geospatial use case, the presenter would add entries like `crs` = `EPSG:4326` and `transform` = `[1.0, 0.0, 0.0, 0.0, -1.0, 90.0]`.

   **Custom keys that collide with an auto-collected key are renamed, not silently dropped.** Once metadata entries collapse into a flat key→value object at serialization, a custom entry keyed e.g. `shape` would otherwise overwrite the real auto-collected `shape` entry with last-write-wins semantics — corrupting the file's self-description with no warning. Instead, `collectMetadata()` (`src/engine/metadata.ts`) deterministically renames any colliding custom key by prefixing `user_` (repeating the prefix if the user's own key is already `user_<autoKey>`, so the rename itself can never introduce a fresh collision). Auto keys always keep their name; no information is lost, but the written key may differ from what was typed. `MetadataEditor` surfaces a warning on the affected row showing the resulting key.

3. **Serialization toggle**: radio group for JSON / Binary.

4. **Granular include toggles**: six independent on/off toggles (`state.metadata.include: MetadataIncludeConfig`, `src/types/state.ts`), each starving a specific group of auto-collected metadata keys when off: `include-schema-toggle`, `include-layout-toggle`, `include-codecs-toggle`, `include-chunk-index-toggle` (the `chunk_index` group specifically — see "Chunk Index" under Write Step below), `include-descriptive-toggle`, and `include-endianness-toggle`. The first five gate metadata the reader (see the Read Step extension) genuinely *needs*: turning one off makes the reader stop at a specific, named step, with the read status reporting exactly where and why. **`include-endianness-toggle` is different in kind, not just in what it gates.** Omitting `byte_order` does not fail the read at all — the reader falls back to assuming the *host's* byte order (little-endian, in every browser) and proceeds normally. If the file was actually written big-endian, the read *succeeds*, silently, with every multi-byte value wrong. This is deliberate: it's the one metadata toggle in the tool that demonstrates silent data corruption rather than an honest failure, and the Read-stage's process view narrates the assumption explicitly ("byte order not recorded — assuming host (little-endian)") so the lesson is visible even when the numbers alone wouldn't tip you off.

5. **Serialized size**: displays the total byte count of the serialized metadata.

The Metadata Assembly also appears as a selectable stage in the pipeline strip and pane dropdowns. When selected, the pane shows the serialized metadata bytes in hex or flat view — so you can see exactly what the metadata looks like as bytes.

Serialized metadata bytes are then placed according to the Write step's configuration (header, footer, or sidecar).

## Write Step

The write step assembles the final file(s). It combines:

1. **Magic number** (optional): user-defined bytes at the start of the file. Also written at the end of every file (single-file and per-chunk alike) so the Read step (see the Read Step extension) has a trailing marker to check when a trailer is in play. Default: `00 C0 DE C5` (the tool's own name as a hex literal — and itself a demonstration of the concept).

2. **Metadata bytes**: the serialized metadata from the Metadata Assembly step, placed as header (before data), footer (after data), or in a separate sidecar file. Only written at all when `write.includeMetadata` is true — see the Read Step extension for the default-false rationale.

3. **Chunk data**: the encoded bytes from the codec pipeline, ordered according to the chunk ordering setting (row-major or column-major).

4. **Chunk index**: a table of byte offsets for each chunk (`coords`/`offset`/`size`, plus `variableName` in column mode). This is part of the metadata and is critical for random access — see "Chunk Index" below for the user-facing toggle and what happens without it.

5. **Partitioning**: in "single file" mode, everything goes in one file. In "per-chunk" mode, each chunk is a separate file (named `{variable}_chunk_{coords}` in column mode or `chunk_{coords}` in row mode), and metadata (when included) lives in its own `metadata` sidecar file. This mirrors zarr's directory structure.

The output is one or more "virtual files" displayed in a file explorer view (`data-testid="file-explorer"`, entries `file-entry-{i}`). Each file shows its name, size, and byte content (viewable in the hex/flat viewers).

### Header Metadata and Offset Convergence

When metadata is placed as a **header**, the chunk index it embeds needs to know the byte offsets where chunk data starts — but those offsets depend on the header's own serialized size, which depends on the chunk index's digit counts, which can change the header's size. `assembleFiles` (`src/engine/write.ts`) resolves this with a small bounded fixed-point loop (`convergeHeaderMetadata`, capped at 6 iterations): re-serialize using the previous pass's length as the next pass's assumed header size, until the length stops changing. If it genuinely doesn't settle (an oscillation between two lengths), the metadata is padded with trailing whitespace (JSON only) to the largest length seen — offsets computed for that length remain exactly correct once the bytes are padded out to it. The final offsets are asserted against the actual data start before the file is returned, so a convergence bug fails loudly (a thrown error) rather than shipping a file whose reader would mis-slice chunks.

Footer and sidecar placement don't need this: chunk data is written starting right after the leading magic regardless of metadata size, so those offsets are exact on the first pass.

### Footer Locator (D1)

When `write.metadataPlacement === 'footer'`, a second option controls **how a reader is expected to find the footer**: `write.footerLocator: 'trailer' | 'none'` (default `'trailer'`), shown in the Write sidebar section only in that placement.

- **`'trailer'`**: the file layout is `[magic][chunks][metadata][u32 LE metadata-length][magic]` — this is exactly how Parquet works (`[footer][4-byte length]['PAR1']`; the help text says so directly). The reader seeks to `end − magicLen − 4`, reads the length, and slices the metadata exactly. Works identically for JSON and binary metadata.
- **`'none'`**: the layout stays the plain `[magic][chunks][metadata][magic]` with no length recorded anywhere. The reader falls back to a best-effort backward scan: for JSON, a string-literal-aware brace scan (so an unbalanced `{`/`}` inside a custom metadata *value* — e.g. a WKT string — doesn't throw off the boundary); for binary, a bounded plausibility scan looking for a 4-byte little-endian value that looks like a small positive entry count. **Scanning may legitimately fail** — that's the intended lesson, not a bug, and the failure mode is deliberately narrow: no further heuristics are layered on to make it succeed more often. On failure, the Read step reports `metadata-not-found` (see the Read Step extension's failure taxonomy) with a message that names the Footer locator option as the fix.

This is a genuine user-facing format decision, following the tool's philosophy that the user makes format decisions and the Read step shows the consequence — rather than the app quietly making footer metadata always locatable.

### Chunk Index (D3)

A new Metadata option, `metadata.includeChunkIndex: boolean` (default `true`), controls whether the `chunk_index` entry (coords/offset/size per chunk) is written into metadata at all.

- **`true`** (default): current/expected behavior — the reader locates each chunk directly from the index.
- **`false`**: `chunk_index` is omitted entirely. The Read step then attempts to **compute** chunk offsets itself, from `chunkShape × dtype size` in row-major chunk order — but this is only possible when *every* codec pipeline in play is size-preserving (Delta, Byte Shuffle — not RLE or LZ, whose encoded size isn't derivable from the input shape alone). When a size-changing codec is present with no index, the Read step fails with reason `no-chunk-index`, explaining that variable-size chunks are unlocatable without an index — arguably the tool's clearest lesson in why real chunked/columnar formats (Zarr, Parquet) always carry one.

Reassembly always keys chunks by coordinates — taken from real index entries when present, or from the computed row-major layout when absent — never from filename parsing or raw byte-offset order.

### Reader Knows the Magic Number (D2)

The Read step extension originally specified that the reader "operates only on what's in the file — it does not have access to the pipeline configuration." That still holds for everything *except* the magic number: `readFile(files, formatSpec: { magic: Uint8Array })` is handed the configured magic as part of the "format definition" it was built to understand — exactly as a real Parquet reader is compiled knowing to expect `PAR1`, or a TIFF reader knows `II*\0`. This is a deliberate, narrow exception to the "reader has no config access" rule, scoped to magic only; every other structural fact (shape, dtypes, chunking, codecs) still comes exclusively from the file's own metadata.

With the magic known, the reader **verifies** it — both the leading magic, and the trailing magic when a footer trailer is in play — rather than blindly stripping `magic.length` bytes from each end and hoping for the best. A mismatch is its own failure reason, `bad-magic`, with a message that draws the Parquet/TIFF analogy directly: this reader only understands files it was built for, and a mismatch means either the wrong kind of file or file corruption before the reader ever got to interpret contents. This closes a real gap: without verification, a reader that merely strips N bytes from each end has no way to detect that those weren't actually magic bytes at all, and would silently attempt to parse garbage as if it were the real payload.

## File Explorer (v1 minimal, v2 expanded)

For v1, the file explorer is minimal: a list of output files with names and sizes, displayed in the sidebar's Write section or as a small panel. Clicking a file selects it for viewing in a pane.

For v2, this becomes a tree view showing directory structure (relevant for per-chunk partitioning with subdirectories).

## Talk Workflow

The tool supports a live presentation workflow:

1. **Start**: tool loads with the default passthrough pipeline. Presenter shows the Values view — "here's our data, everyone understands this."
2. **Walk through each step**: presenter moves through the sidebar top-to-bottom, configuring each pipeline step. Audience participates by choosing options (e.g., "should we use row or column orientation?").
3. **Binary decisions**: at key junctures, the presenter offers the audience a choice between two options. Both paths have prepared talking points. The presenter can address both: "you picked column-oriented, which means we can do per-variable codecs. If you'd picked row-oriented, we'd be stuck with one pipeline for everything."
4. **Presets for recovery**: if the audience's choices lead somewhere unproductive, the presenter can load a preset to get back on track.
5. **Build up incrementally**: each configuration change updates the output in real time. The audience watches the file bytes evolve.

## Project Structure

This was the planned structure going into implementation. Some files were added, split, or renamed as the engine grew (a byte-utility module, a decode/reversal module, the type-assignment engine, a `PipelineContext`, etc.) — see `docs/architecture.md` for a current, verified map of where each concern actually lives.

```
src/
├── types/
│   ├── dtypes.ts              # Data type registry
│   ├── codecs.ts              # Codec registry and implementations
│   ├── pipeline.ts            # Pipeline stage types
│   └── state.ts               # App state types
├── engine/
│   ├── generate.ts            # Data generation (PRNG)
│   ├── elements.ts            # Value → binary element conversion
│   ├── chunk.ts               # Chunking logic
│   ├── linearize.ts           # Interleaving / linearization
│   ├── codecs.ts              # Codec pipeline execution
│   ├── metadata.ts            # Metadata collection and serialization
│   ├── write.ts               # File assembly
│   └── trace.ts               # Byte tracing logic
├── components/
│   ├── layout/
│   │   ├── App.tsx            # Root layout
│   │   ├── Header.tsx         # Title + model toggle
│   │   ├── Sidebar.tsx        # Config panel container
│   │   └── PipelineStrip.tsx  # Stage visualization bar
│   ├── config/
│   │   ├── SchemaEditor.tsx   # Variable/shape config
│   │   ├── ChunkConfig.tsx    # Chunk shape config
│   │   ├── InterleaveConfig.tsx
│   │   ├── CodecPipelineEditor.tsx  # Reusable codec pipeline UI
│   │   ├── CodecSection.tsx   # Per-field or per-chunk codec routing
│   │   ├── MetadataEditor.tsx # Metadata assembly config
│   │   └── WriteConfig.tsx    # Write step config
│   ├── viewers/
│   │   ├── StagePane.tsx      # Pane with dropdown + view mode + viewer
│   │   ├── TableView.tsx      # Spreadsheet table (virtual scrolled)
│   │   ├── GridView.tsx       # 2D heatmap grid
│   │   ├── HexView.tsx        # Hex dump (virtual scrolled)
│   │   └── FlatView.tsx       # Value-per-line list (virtual scrolled)
│   ├── shared/
│   │   ├── Radio.tsx          # Segmented radio control
│   │   ├── HoverBar.tsx       # Cross-stage hover info
│   │   └── Label.tsx          # Section label
│   └── files/
│       └── FileExplorer.tsx   # Output file list
├── state/
│   ├── useAppState.ts         # Main state hook
│   ├── persistence.ts         # localStorage save/load
│   └── defaults.ts            # Default states for each model
├── hooks/
│   ├── usePipeline.ts         # Computes all pipeline stages from state
│   └── useHover.ts            # Shared hover state
└── main.tsx                   # Entry point
```

## Performance Considerations

- **Memoize aggressively**: pipeline stage computation is potentially expensive. Each stage should be memoized and only recompute when its inputs change. Intermediate stages should not recompute when only downstream configuration changes.
- **Virtual scrolling**: all list/table/hex views must virtualize. Only render visible rows + a buffer.
- **Debounce saves**: state persistence should debounce at ~500ms to avoid thrashing storage on rapid parameter changes.
- **Codec computation**: for v1, all codecs run in the main thread. If performance is an issue with large datasets, consider moving codec execution to a Web Worker. The LZ codec's O(n×w) complexity may be slow for large inputs.
- **Maximum data size**: the tool is for learning, not production. `SOFT_ELEMENT_CAP` (`src/components/config/SchemaEditor.tsx`, 8,000,000 total values across all variables) is the advisory ceiling — an `element-cap-warning` banner appears above it, but the app does not stop you. Below that, viewer components switch strategy at their own thresholds rather than degrading: `GridView`'s `MAX_CELLS` (10,000 cells) switches from DOM cells to a canvas render; `HexView`'s `WINDOWED_SECTION_ROWS` (262,144 rows) switches to a windowed view with an overview strip.

## Accessibility

- All interactive controls should be keyboard-navigable
- Color is used for variable identification but should not be the only differentiator (add icons or labels)
- Hex view hover targets should be large enough to hit on touch devices (may need a touch-friendly mode)

## Edge Cases and Validation

The tool should handle degenerate configurations gracefully rather than crashing or producing blank output.

| Scenario | Behavior |
|----------|----------|
| Zero variables | GridView shows "No variables defined" (its early-return now happens *after* all hooks run — an earlier draft violated React's rules of hooks here and crashed on delete-then-add-variable; fixed). TableView/FlatView/HexView render their normal (empty) structure. Pipeline stages produce 0-byte or near-empty outputs (magic/metadata bytes may still be present) rather than crashing. |
| Empty shape (e.g., `[0]` or `[]`) | Cannot actually reach state: the Schema editor's shape inputs clamp to `Math.max(1, parseInt(...) \|\| 1)` per dimension before dispatch, and `SET_SHAPE` independently rejects any shape that is empty or has a non-positive dimension (returning the unchanged state). No warning-border UI exists for shape — the value simply can't go invalid. |
| Shape with very large dimensions (> `SOFT_ELEMENT_CAP`, 8,000,000 total values) | Advisory only: the Schema section renders an `element-cap-warning` banner, but nothing blocks the configuration. Virtual scrolling, `GridView`'s canvas mode (above `MAX_CELLS`), and `HexView`'s windowed mode (above `WINDOWED_SECTION_ROWS`) keep large element counts from freezing the table/grid/hex/flat views regardless. |
| Chunk shape larger than data shape on any dimension | Clamped per-dimension to the data shape (both in `ChunkConfig`'s input handler and in `SET_CHUNK_SHAPE`/`validateState`) — one chunk on that axis, silently, not an error. |
| Chunk shape of 0 on any dimension | Rejected outright: `SET_CHUNK_SHAPE` requires every dimension to be a positive integer and returns the unchanged state otherwise; `ChunkConfig`'s input also clamps to a minimum of 1. (An earlier draft let a hand-edited `chunkShape: [0]` reach `computeChunkGrid`, which divides by the chunk dimension and hangs on an infinite loop — fixed by rejecting at the source.) |
| Chunk shape of 1 on any dimension | Valid (maximally chunked); may produce many chunks. `ChunkConfig` shows the resulting chunk count in the warning color with "— consider larger chunks" once it exceeds 1000. |
| Variable name collision (two variables with same name) | `SchemaEditor` shows a warning border on every variable sharing a duplicated (or empty) name. Unlike earlier drafts, this is now purely a display/file-format concern, not a data-loss risk: `fieldPipelines` is keyed by each variable's stable `id`, so duplicate or renamed display names no longer clobber another variable's codec pipeline or values. The warning still matters because the *written file format* keys `codec_pipelines`/`schema` by variable name, so a file with duplicate names is genuinely ambiguous to a reader. |
| Variable name empty | Same warning-border treatment as a name collision (`hasWarning = !v.name || duplicateNames.has(v.name)`); there is no internal fallback name synthesized — the empty string is what gets used as the (ambiguous) key at metadata-serialization time. |
| Codec pipeline produces 0 bytes | Valid (e.g., RLE or LZ on empty input return `new Uint8Array(0)`). Pipeline strip and hex view handle the empty stage without special-casing. |
| Codec pipeline produces bytes larger than input | Valid (not an error); the pipeline strip is expected to call this out in the warning color per the Codec Applicability section. |
| All variables deleted | Same as zero variables case. |
| Interleaving switched from column to row with existing per-field pipelines | The per-field pipelines are preserved in state (`fieldPipelines` is untouched by `SET_INTERLEAVING`) but become inactive — the Encoded stage in row mode reads `chunkPipeline` instead. Switching back to column reactivates the same `fieldPipelines`, unchanged. `CodecSection` swaps between the per-field and per-chunk editors based on `state.interleaving`, with the mixed-dtype explanatory callout. |
| Shape dimensions changed (e.g., from 1-d to 2-d) while chunk shape is still 1-d | `SET_SHAPE` pads `chunkShape` with the new dimensions' full extent (new dims default to no splitting) and clamps existing dims that shrank; `validateState`'s merge-time fallback does the equivalent clamp/pad for a stale persisted `chunkShape`. |
| Odd-length or non-hex magic-number input | `hexToBytes` (`src/engine/bytes.ts`) is the single tolerant implementation used by both write and read: it strips non-hex characters and drops a trailing unpaired nibble rather than throwing. `WriteConfig`'s magic input (`data-testid="magic-input"`) shows a warning border for non-hex characters, but no input can crash the pipeline. |
| Stale/corrupt/outdated `localStorage` | `loadState()` runs migrate → deep-merge-over-defaults → structural validation (see State Management → Migration Behavior) before the app ever sees the result; anything unrecoverable (e.g. a corrupt shape) resets to a full default state rather than reaching the engine with missing fields. |
| `write.includeMetadata = false` | The Write stage omits metadata entirely (not even a placeholder) — only magic + chunk data. The Read stage fails with reason `no-metadata`, prompting the user to enable it. This is the read extension's central lesson and is the default. |
| Metadata present but its locator/scanner can't find it (`footerLocator: 'none'`) | Read fails with reason `metadata-not-found`, distinct from `no-metadata` — the message explains that metadata was written but a best-effort scan couldn't pin it down, and names the Footer locator "trailer" option as the fix. |
| Chunk index omitted (`includeChunkIndex: false`) with a size-changing codec (RLE/LZ) in play | Read fails with reason `no-chunk-index` rather than attempting (and silently getting wrong) a computed offset guess. |
| Magic number mismatch on read | Read fails with reason `bad-magic` before any attempt to locate metadata or reconstruct values. |

## Open Questions for Implementation

These are decisions left to the implementer's judgment:

1. **Chunk index representation**: the chunk index in metadata maps chunk coordinates to byte offsets. Recommended: a JSON array of objects `[{ coords: [0, 0], offset: 128, size: 512 }, ...]` for JSON serialization, and the same structure flattened for binary. But the implementer may find a more compact representation.

2. **File explorer interaction**: when partitioned into per-chunk files, clicking a file in the explorer should show that file's bytes in the selected pane. Whether there should also be a "show all files concatenated" option is left to the implementer.

3. **Pipeline strip interactivity**: currently spec'd as non-interactive (visual only). A reasonable enhancement would be: clicking a stage scrolls the sidebar to the corresponding config section. This is optional for v1.

4. **Metadata preview truncation**: for large metadata (many chunks → large chunk index), the sidebar preview should truncate. The exact truncation threshold and "show more" behavior is left to the implementer.

5. **Hex view column count**: the doc assumes 16 bytes per row. On narrow panes this may overflow. The implementer may want to make this responsive (e.g., 8 bytes per row on narrow panes).

## Implementation Order

Build in this order. Each phase should be functional and testable before moving to the next.
(This is the original pre-implementation plan, kept for historical reference — see the Codec
Registry and Logical Types sections above for what actually shipped: 4 codecs, not 6, with
scale/offset and bit-round moved to a separate Type Assignment concept and its own Typed stage.)

**Phase 1: Engine + Tests**
1. `src/types/` — all type definitions (dtypes, codecs, pipeline, state)
2. `src/engine/generate.ts` — PRNG data generation
3. `src/engine/elements.ts` — value → binary element conversion
4. `src/engine/chunk.ts` — chunking logic
5. `src/engine/linearize.ts` — interleaving
6. `src/engine/codecs.ts` — codec pipeline execution
7. `src/engine/trace.ts` — byte tracing with fidelity degradation
8. `src/engine/metadata.ts` — metadata collection + JSON/binary serialization
9. `src/engine/write.ts` — file assembly (magic number, metadata placement, chunk ordering, partitioning)
10. Tests for all of the above using vitest. Test codec roundtrip behavior, dtype correctness, trace preservation through non-size-changing codecs, trace degradation through entropy codecs, metadata serialization roundtrip, and write step file assembly.

**Phase 2: Minimal UI Shell**
1. App layout with resizable panels (sidebar + main area with two panes)
2. Pipeline strip (read-only visualization)
3. State management hooks, localStorage persistence
4. Pane dropdown selectors and view mode radio groups

**Phase 3: Viewers**
1. HexView with virtual scrolling and hover highlighting
2. TableView with virtual scrolling and hover highlighting
3. FlatView with virtual scrolling and hover highlighting
4. GridView for array data
5. HoverBar showing cross-stage trace info
6. Verify hover linking works between both panes

**Phase 4: Config Sidebar**
1. SchemaEditor (variables + shape)
2. ChunkConfig
3. InterleaveConfig (with codec granularity explanation callouts)
4. CodecSection + CodecPipelineEditor (per-field and per-chunk modes, parameter controls, warning indicators)
5. MetadataEditor (auto-collected display, custom key-value pairs, serialization toggle)
6. WriteConfig (magic number, partitioning, metadata placement, chunk ordering)

**Phase 5: Integration + Polish**
1. Wire everything together: config changes → engine recomputation → viewer updates
2. File explorer (minimal: file list with sizes)
3. Model switching with per-model state preservation
4. Edge case handling (see Edge Cases table)
5. Performance profiling and optimization if needed
6. Responsive hex view column count

## v2 Roadmap

Features explicitly deferred from v1:

- **Presets**: named state snapshots, built-in format examples ("basically Parquet", "basically Zarr")
- **Wizard overlay**: guided step-by-step flow overlaid on the workbench
- **Geo metadata helpers**: CRS picker (EPSG search), affine transform builder
- **WASM codecs**: zstd, deflate for realistic entropy coding
- **Data generation modes**: correlated, sorted, constant regions, user upload
- **File explorer tree**: directory view for partitioned outputs
- **Chunk ordering visualization**: visual showing which chunks are adjacent in the file vs. spatially adjacent, illustrating access pattern implications
- **Undo/redo**: for the talk workflow, being able to step backward
- **Export**: download the generated files as actual files
