# 0x00C0DEC5 — Extension: Read Step

> **For the implementer**: this document extends the main design document. It should be implemented after the core pipeline (Phases 1–5 in the main doc) is complete and stable. It adds a Read step to the pipeline, codec decode functions, a diff view, and a metadata inclusion toggle.

## Motivation

The core pipeline shows data transforming from readable values to opaque bytes on disk. But it never proves the bytes are *usable*. The Read step closes the loop: it takes the file bytes produced by the Write step and attempts to reconstruct the original values. This serves two pedagogical purposes:

1. **Metadata justifies itself.** By default, metadata is not included in the file. The Read step cannot parse the file and shows a clear failure state. The user enables metadata and the Read step succeeds. The lesson: without self-describing metadata, bytes are meaningless.

2. **Lossy transforms become visible.** If the pipeline included lossy operations — bit-rounding or a lossy scale/offset from Type Assignment (see `docs/design.md`; these are no longer codecs, but the lossy-visibility lesson is unchanged), or a codec that's lossy for its input dtype (Delta on a float) — the reconstructed values differ from the originals. The diff view shows exactly where and how much precision was lost.

## Changes to the Write Step

### Metadata Inclusion Toggle

Add a toggle to the Write section in the sidebar:

- **Include metadata**: yes / no (default: **no**)

When set to "no," the Write step produces file(s) containing only the magic number (if set) and encoded chunk data. No metadata is written — not as a header, not as a footer, not as a sidecar. The metadata assembly section in the sidebar still shows what *would* be written (so the user can see the metadata they're choosing not to include), but none of it reaches the output file(s).

When set to "yes," metadata is serialized and placed according to the existing metadata configuration (format, placement).

This toggle should be the *first* control in the Write section, above magic number and other options, because it's the most consequential decision.

### State Update

Add to `AppState.write`:

```typescript
write: {
  includeMetadata: boolean;       // default: false
  magicNumber: string;
  partitioning: "single" | "per-chunk";
  metadataPlacement: "header" | "footer" | "sidecar";
  chunkOrder: "row-major" | "column-major";
};
```

Two further options were added to `write`/`metadata` alongside making this extension's Read step actually work end-to-end (see `docs/design.md`'s Write Step section for the full rationale): `write.footerLocator: 'trailer' | 'none'` (only meaningful with `metadataPlacement: 'footer'`) and `metadata.includeChunkIndex: boolean`. Both follow the same philosophy as `includeMetadata` — a user-facing format choice with a visible, honest consequence in the Read step rather than the app quietly making every configuration always readable.

## The Read Step

### Pipeline Position

The Read step is the final stage in the pipeline, after Write. It appears as:

- A node in the pipeline strip labeled "Read" with a success/failure indicator
- A selectable stage in both pane dropdowns
- A section at the bottom of the sidebar (below Write) showing read status and controls

### Behavior

The Read step takes the file bytes from the Write step's output and attempts to reconstruct the original dataset values. It operates only on what's in the file — it does not have access to the pipeline configuration, **with one deliberate exception**: the reader is handed the format's configured magic number (`readFile(files, { magic: Uint8Array })`) so it can verify the file starts (and, with a footer trailer, ends) with the bytes it expects. This is analogous to how a real Parquet reader is compiled already knowing to look for `PAR1`, or a TIFF reader `II*\0` — the magic number is part of the format definition the reader was built for, not something it infers from the file. See `docs/design.md`'s "Reader Knows the Magic Number (D2)" subsection under Write Step for the full rationale; every other structural fact (schema, shape, chunking, codecs) still comes exclusively from metadata embedded in or alongside the file, per the rest of this document.

**When metadata is not included (default):**

The reader examines the file bytes. It verifies the magic number (per D2 above), but beyond that, the bytes are opaque. The Read step enters a **failure state**.

The failure state displays:

- In the pipeline strip: the Read node shows a red/warning indicator (e.g., ✗ icon)
- In the sidebar Read section: a clear message explaining the failure
- In the pane (when Read is selected): the failure message, prominently displayed

The failure message should be specific and educational. The shipped implementation generalizes this into a **failure taxonomy** — see "Read Failure Taxonomy (D4)" below — of which "no metadata at all" is only one case. That case's message:

> **Cannot read file.**
>
> The file contains [N] bytes of data but no metadata describing how to interpret them. A reader needs to know: the variable names and types, the data shape, how the data was chunked and interleaved, and what codecs were applied — in order to reverse the encoding and reconstruct values.
>
> Enable "Include metadata" in the Write step to make this file self-describing.

**When metadata is included:**

The reader:

1. Locates the metadata based on placement (check header, then footer, then sidecar file) — see `docs/design.md`'s "Footer Locator (D1)" for how footer placement is actually found (a trailer-length seek, or a best-effort scan that can legitimately fail)
2. Deserializes the metadata (JSON or binary, determined by inspecting the bytes or by the format indicator in the metadata itself)
3. Extracts structural information: schema, shape, chunk shape, interleaving, codec pipelines, chunk index, byte order
4. Uses the chunk index to locate each chunk's bytes in the file — or, if the index was omitted (`includeChunkIndex: false`, D3), computes offsets from chunk shape and dtype size when every codec pipeline in play is size-preserving
5. For each chunk, reverses the codec pipeline (see Codec Decode Functions below)
6. Deinterleaves and reassembles the full dataset
7. Produces reconstructed values

The Read step enters a **success state** and produces a `PipelineStage` containing the reconstructed values — same structure as the Values stage but potentially with different values where lossy transforms occurred.

### Read Failure Taxonomy (D4)

The single "no metadata" failure case above generalizes to six distinct failure reasons, each with its own educational message (the sidebar's `ReadStatus` and the pane's failure display render the message verbatim rather than hardcoding text per case):

```typescript
type ReadFailureReason =
  | 'no-metadata'        // metadata genuinely absent (includeMetadata = false)
  | 'metadata-not-found' // metadata present but the locator/scanner failed (footerLocator = 'none')
  | 'bad-magic'          // magic mismatch (D2)
  | 'corrupt-metadata'   // metadata located but failed to parse
  | 'no-chunk-index'     // variable-size chunks with no index (D3)
  | 'decode-error';       // codec reversal / deinterleave / reassembly failed

interface ReadFailure {
  success: false;
  reason: ReadFailureReason;
  message: string;
  byteCount: number;
}
```

Each reason teaches something different:

- **`no-metadata`** — the original lesson: bytes without a self-description are meaningless. Fix: enable "Include metadata."
- **`metadata-not-found`** — metadata was written, but a best-effort scanner (footer placement with no trailer) couldn't pin down its exact boundaries. The lesson is why real formats record an exact length rather than relying on scanning — the message points at Parquet's `[footer][4-byte length]['PAR1']` trailer and the Footer locator option that adds the equivalent to this tool.
- **`bad-magic`** — the leading (or, with a trailer, trailing) bytes don't match the format's expected magic. The lesson: a reader only understands files it was built for; this is what "the format's magic number" actually buys a real parser (immediate, cheap rejection of the wrong kind of file, or corruption, before wasting effort on the rest of the parse).
- **`corrupt-metadata`** — metadata was found at the expected location but didn't parse into a usable structure (missing required fields, malformed JSON/binary). The lesson: a reader that finds *something* but can't trust it has to fail rather than guess.
- **`no-chunk-index`** — chunks are variable-size (a size-changing codec like RLE/LZ is in the pipeline) and no index was written to say where each one starts. The lesson: this is precisely why real chunked/columnar formats (Zarr, Parquet) always carry a chunk/row-group index.
- **`decode-error`** — metadata was found and parsed successfully, but reconstructing values failed anyway (codec reversal, deinterleaving, or reassembly threw). The lesson: metadata can describe a dataset correctly and the bytes can still not match that description — the failure surfaces the underlying exception message for debugging rather than silently producing wrong values.

### Read Section in Sidebar

A minimal section below Write:

- **Status indicator**: green checkmark + "File parsed successfully" or red X + the failure message
- **When successful**: summary stats — number of variables recovered, shape, total values, any lossy warnings
- **Diff toggle**: "Show differences from original" — enables the diff view in the pane (see Diff View below)

## Codec Decode Functions

Each codec needs a `decode` method in addition to `encode`. The decode function reverses the transform given the same parameters.

```typescript
interface CodecDefinition {
  // ... existing fields ...
  encode: (bytes: Uint8Array, inputDtype: string, params: Record<string, any>) => {
    bytes: Uint8Array;
    outputDtype: string;
  };
  decode: (bytes: Uint8Array, encodedDtype: string, params: Record<string, any>) => {
    bytes: Uint8Array;
    outputDtype: string;  // the original dtype before encoding
  };
  isLossy: (inputDtype: DtypeKey) => boolean;  // predicate, not a plain boolean — see below
}
```

**Deviation from the original spec**: this document originally specified a plain `lossy: boolean` field. The shipped implementation uses `isLossy: (inputDtype) => boolean` instead — a predicate over the codec step's actual input dtype. A single boolean can't express Delta's real behavior: after a fix to remove an early clamping bug, Delta's encode/decode is an *exact* modular round-trip for every integer dtype (typed-array writes wrap mod 2^N, so a negative diff on an unsigned dtype wraps and un-wraps exactly rather than clamping to 0 and losing information), but Delta is still lossy on float dtypes, since each difference gets re-rounded to the float's own precision on the way back to bytes. `isLossy(dtype)` is the minimum shape that can say "exact here, lossy there" for the same codec.

Also note: **Scale/Offset and Bit Round are no longer codecs at all.** They were folded into the Type Assignment concept (`Variable.typeAssignment.scale`/`offset`/`keepBits`) — see `docs/design.md`'s "Logical Types and Type Assignment" section. Reversing them is `reverseTypeAssignment()` (`src/engine/typeAssign.ts`), applied once per variable after the codec pipeline (which now only ever contains Delta/Byte Shuffle/RLE/LZ) has been fully reversed — not part of `CODEC_REGISTRY`'s decode step at all. The table below covers only the four codecs that remain in the registry.

### Per-Codec Decode Behavior

| Codec | Reversible? | isLossy(dtype) | Decode behavior |
|-------|-------------|-----------------|-----------------|
| Delta | Yes | `true` for float dtypes only; `false` for every integer dtype | Cumulative sum (prefix sum), applied `order` times — the exact inverse of encode's differencing, including the same typed-array wraparound that makes integer round-trips exact. Float dtypes remain lossy: each cumulative sum re-rounds to float precision. |
| Byte Shuffle | Yes | `false` always | Inverse transpose. Same `elementSize` parameter, reverse the byte grouping. |
| RLE | Yes | `false` always | Expand (count, value) pairs back to byte runs. |
| LZ (simple) | Yes | `false` always | Expand back-references (`[length, offsetHi, offsetLo]`) and literals (`[0x00, byte]`) to the original byte stream. |

Type Assignment reversal (not a codec, but still part of what makes a lossy pipeline visible in the diff view):

| Transform | Reversible? | Lossy? | Reversal behavior |
|-----------|-------------|--------|--------------------|
| Scale/offset (integer storage of decimal/continuous values) | Yes | Yes when the value was clamped or rounded going in | `value / scale + offset`, computed from the stored integer. The forward clamping/rounding that happened during Typed-stage conversion is not recoverable — `VariableStats.isLossy` (from `assignType`) records whether this happened. |
| Bit-round (`keepBits` on a float storage dtype) | No | Yes, whenever `keepBits` is less than the dtype's full mantissa width | No decode step exists — the zeroed low mantissa bits are simply gone. The value read back is whatever the truncated bit pattern represents; `assignType`'s readback-comparison marks it `rounded` in `VariableStats`. |

### Pipeline Reversal

The codec pipeline (just Delta/Byte Shuffle/RLE/LZ, per variable in column mode or per chunk in row mode) is reversed in order: if the encode pipeline was `[delta, shuffle, rle]`, the decode pipeline applies `[rle_decode, shuffle_decode, delta_decode]` (`reverseCodecPipeline` in `src/engine/decode.ts`). After the codec pipeline is fully reversed, `reverseTypeAssignment` is applied once, separately, per variable — it is not itself a pipeline step to be interleaved with codec reversal.

For per-variable pipelines (column mode), each variable's pipeline is reversed independently, then the variables are deinterleaved and reassembled.

For per-chunk pipelines (row mode), each chunk's pipeline is reversed, then the chunk is deinterleaved.

The dtype flows backward through the pipeline using the same rule as the forward direction (`outputDtypeFor` in `src/engine/codecs.ts`, applied in reverse): if encoding went `int16 → int16 → int16 → uint8` (Delta, then Byte Shuffle, then RLE — entropy codecs collapse to `uint8`, reordering codecs preserve dtype), decoding goes `uint8 → int16 → int16 → int16`, and only then does `reverseTypeAssignment` convert those int16 values back to the original decimal/continuous logical values. This information is stored in the metadata's `codec_pipelines` and `type_assignments` entries.

## Diff View

When the Read step succeeds, the pane can show reconstructed values. A diff mode highlights where values changed.

### Table View (Tabular Data)

When diff mode is enabled and the pane is showing the Read stage:

- Each cell shows the reconstructed value
- Cells where the reconstructed value differs from the original are highlighted with a background tint (using the `warning` theme color at low opacity)
- Hovering a differing cell shows a tooltip: `"Original: 42.7134 → Reconstructed: 42.7 (Δ = -0.0134)"`
- A summary row or header annotation shows per-variable stats: number of differing values, max absolute error, mean absolute error

### Grid View (Array Data)

When diff mode is enabled:

- The grid shows the *difference* (reconstructed − original) as the heatmap value instead of the raw reconstructed value
- Color scale is diverging: zero difference is neutral, positive/negative differences are opposite colors
- Hovering shows: original, reconstructed, and difference
- A summary shows max/mean absolute error for the selected variable

### Hex/Flat Views

Diff mode does not apply to hex or flat views — these show the Read stage bytes as-is (which are the reconstructed raw typed bytes before any comparison logic).

## Implementation Notes

### Engine Additions

New files:

- `src/engine/decode.ts` — codec decode functions and pipeline reversal logic
- `src/engine/read.ts` — file reader: metadata location, deserialization, chunk extraction, pipeline reversal, value reconstruction

Additions to existing files:

- `src/types/codecs.ts` — add `decode` and `lossy` to `CodecDefinition`
- Each codec implementation gets a `decode` function
- `src/types/state.ts` — add `includeMetadata` to write state
- `src/types/pipeline.ts` — add read stage type (extends `PipelineStage` with diff data)

### New Components

- `src/components/config/ReadStatus.tsx` — sidebar section showing read success/failure
- Diff overlay logic in `TableView.tsx` and `GridView.tsx` (conditional rendering when viewing the Read stage with diff enabled)

### Test Priorities

1. **Codec round-trip tests**: for each codec, verify that `decode(encode(input))` produces the expected output. For lossless codecs, this should be identical to input. For lossy codecs, verify the error is within expected bounds.
2. **Full pipeline round-trip**: generate data → full pipeline → write → read → compare. Verify lossless pipeline produces identical values and lossy pipeline produces values within expected tolerance.
3. **Read failure**: verify that omitting metadata produces the expected failure state.
4. **Metadata sufficiency**: verify that the metadata contains everything the reader needs — schema, shape, chunks, interleaving, codec specs, chunk index.

## Step log and granular metadata (2026-07)

Two later additions to the Read step, both shipped: a narrated step-by-step log the
reader produces on every attempt, and finer-grained control over which metadata
groups get written — each group mapping to exactly one point in that log where its
absence stops the reader.

### The 8-step log

Every call to `readFile` (`src/engine/read.ts`) narrates through a fixed 8-step
order, success or failure, recorded in `ReadFileResult.steps: ReadStep[]`
(`src/types/pipeline.ts`). `READ_STEP_ORDER` is the single source of truth for step
identity, display label, and what the reader "needs" at that step:

| # | id | label |
|---|----|-------|
| 1 | `verify-magic` | Verify magic number |
| 2 | `locate-metadata` | Locate metadata |
| 3 | `parse-metadata` | Parse metadata |
| 4 | `read-schema` | Read schema |
| 5 | `read-layout` | Read layout |
| 6 | `locate-chunks` | Locate chunks |
| 7 | `decode-chunks` | Decode chunks |
| 8 | `reassemble` | Reassemble values |

Each `ReadStep` carries `outcome: 'ok' | 'failed' | 'skipped'`, plus `needed`/`found`
text and an optional `detail`. On failure, every step up to and including the
failing one is recorded (`ok` then one `failed`), and every step after it is
recorded `skipped` — the reader never attempted them. On success, all 8 are `ok`.

Two places in the UI render this log:

- The sidebar's `ReadStatus` (`src/components/config/ReadStatus.tsx`) shows a one-line
  progress summary above its existing status message — `read-status-progress`:
  `"8/8 steps"` on success, `"N/8 steps · failed at: {label}"` on failure, where `N`
  is the count of `ok` steps and `{label}` is the failed step's label.
- The Read stage's pane offers a `Process` view mode alongside Table/Grid/Hex/Flat
  (`READ_VIEW_MODES` in `src/components/viewers/StagePane.tsx`), rendering the full
  8-row checklist via `ReadProcessView` (`read-process-view`, rows `read-step-{id}`) —
  shown automatically on failure, or on demand on success.

### Five metadata groups

Metadata inclusion (`state.metadata.include: MetadataIncludeConfig`,
`src/types/state.ts`) is no longer one `includeMetadata` toggle — it's five
independent group toggles, each gating a specific set of metadata keys
(`METADATA_KEY_GROUPS` in `src/engine/metadata.ts`):

| Group | Testid | Keys it gates | Reader step it starves when off |
|-------|--------|----------------|----------------------------------|
| `schema` | `include-schema-toggle` | `schema`, `type_assignments`, `logical_types` | `read-schema` — fails `missing-schema` |
| `layout` | `include-layout-toggle` | `shape`, `chunk_shape`, `chunk_grid`, `chunk_order`, `partitioning`, `interleaving` | `read-layout` — fails `missing-layout` |
| `codecs` | `include-codecs-toggle` | `codec_pipelines` | `decode-chunks` — see assume-identity below (not a hard failure) |
| `chunkIndex` | `include-chunk-index-toggle` | `chunk_index` | `locate-chunks` — fails `no-chunk-index` only when a size-changing codec is in play (D3); otherwise offsets are computed from geometry |
| `descriptive` | `include-descriptive-toggle` | `variable_statistics` + all custom entries | none — the reader never needs this group to reconstruct values |

This replaces the old single-purpose `includeChunkIndex` write option: `chunkIndex`
above is the same D3 semantics, now one of five groups instead of a standalone flag.

### Assume-identity semantics (codecs group off)

Turning off `codecs` doesn't fail the read the way `schema` or `layout` do, because
an absent `codec_pipelines` key is genuinely ambiguous. When `parseStructure` finds
no `codec_pipelines` entry, `reconstructValues` proceeds with an assumed empty
(identity) pipeline per variable/chunk instead of refusing. That assumption lands in
one of three outcomes, only one of which the reader can actually distinguish:

1. **Honest success** — no codecs were applied at write time, so "assume identity" is
   correct and values reconstruct exactly. Indistinguishable, from parsed metadata
   alone, from outcome 2.
2. **Garbled-but-same-size** — a non-size-changing codec (Delta, Byte Shuffle) *was*
   applied, so the assumed-raw bytes are wrong, but the byte count still matches what
   chunk geometry × dtype size predicts. The read reports `decode-chunks` as `ok`
   with a `detail` noting the ambiguity (`describeDecodeDetail` in `src/engine/read.ts`):
   *"no codec info — assumed raw bytes (honest if none were applied at write time;
   garbled if they were)"* — and the resulting values are silently wrong. This is the
   one case the reader cannot detect at all.
3. **Detectably wrong** — a size-changing codec (RLE, LZ) was applied. The assumed-raw
   byte count no longer matches the geometry-predicted count, `reconstructValues`
   throws, and `readFile` maps it to failure reason `decode-error` at `decode-chunks`,
   naming both counts in the message.

In other words: omitting the `codecs` group is safe if and only if no codec pipeline
was ever attached; otherwise it's a silent correctness bug for reordering-only
pipelines and a loud, named failure for entropy-codec pipelines.

### Two new failure reasons

`ReadFailureReason` (`src/types/pipeline.ts`) gained two members alongside the
original six, both surfaced by the `schema`/`layout` groups above:

- **`missing-schema`** — metadata was located and parsed, but the `schema` key itself
  is absent (`schema` group off at write time). Distinct from `corrupt-metadata`,
  which is for a `schema` value that's present but fails to parse. Checked at the
  `read-schema` step.
- **`missing-layout`** — metadata was located, parsed, and schema was present, but
  `shape`/`chunk_shape` are absent (`layout` group off). Schema is checked first, so
  when both groups are off, `missing-schema` wins. Checked at the `read-layout` step.

Both follow the existing failure-taxonomy shape: a `ReadFailureReason` string, a full
`byteCount`, an educational `message`, and the same 8-step `steps` log (failed at the
relevant step, later steps `skipped`) as every other failure reason above.

### Phase Integration

This extension is a single implementation phase that can be done after the main v1 is complete:

**Phase 6: Read Step**
1. Add `decode` and `lossy` to all codec definitions, with tests
2. Implement `src/engine/decode.ts` (pipeline reversal), with tests
3. Implement `src/engine/read.ts` (file parsing/reconstruction), with tests
4. Add `includeMetadata` toggle to Write config UI
5. Add Read node to pipeline strip with success/failure indicator
6. Add ReadStatus sidebar section
7. Add Read stage to pane dropdown options
8. Implement diff overlay in TableView and GridView
9. Full round-trip integration tests
