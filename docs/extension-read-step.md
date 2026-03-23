# 0x00C0DEC5 — Extension: Read Step

> **For the implementer**: this document extends the main design document. It should be implemented after the core pipeline (Phases 1–5 in the main doc) is complete and stable. It adds a Read step to the pipeline, codec decode functions, a diff view, and a metadata inclusion toggle.

## Motivation

The core pipeline shows data transforming from readable values to opaque bytes on disk. But it never proves the bytes are *usable*. The Read step closes the loop: it takes the file bytes produced by the Write step and attempts to reconstruct the original values. This serves two pedagogical purposes:

1. **Metadata justifies itself.** By default, metadata is not included in the file. The Read step cannot parse the file and shows a clear failure state. The user enables metadata and the Read step succeeds. The lesson: without self-describing metadata, bytes are meaningless.

2. **Lossy transforms become visible.** If the codec pipeline included lossy operations (bitround, scale/offset with precision loss), the reconstructed values differ from the originals. The diff view shows exactly where and how much precision was lost.

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

## The Read Step

### Pipeline Position

The Read step is the final stage in the pipeline, after Write. It appears as:

- A node in the pipeline strip labeled "Read" with a success/failure indicator
- A selectable stage in both pane dropdowns
- A section at the bottom of the sidebar (below Write) showing read status and controls

### Behavior

The Read step takes the file bytes from the Write step's output and attempts to reconstruct the original dataset values. It operates only on what's in the file — it does not have access to the pipeline configuration.

**When metadata is not included (default):**

The reader examines the file bytes. It may find a magic number (if one was set), but beyond that, the bytes are opaque. The Read step enters a **failure state**.

The failure state displays:

- In the pipeline strip: the Read node shows a red/warning indicator (e.g., ✗ icon)
- In the sidebar Read section: a clear message explaining the failure
- In the pane (when Read is selected): the failure message, prominently displayed

The failure message should be specific and educational:

> **Cannot read file.**
>
> The file contains [N] bytes of data but no metadata describing how to interpret them. A reader needs to know: the variable names and types, the data shape, how the data was chunked and interleaved, and what codecs were applied — in order to reverse the encoding and reconstruct values.
>
> Enable "Include metadata" in the Write step to make this file self-describing.

**When metadata is included:**

The reader:

1. Locates the metadata based on placement (check header, then footer, then sidecar file)
2. Deserializes the metadata (JSON or binary, determined by inspecting the bytes or by the format indicator in the metadata itself)
3. Extracts structural information: schema, shape, chunk shape, interleaving, codec pipelines, chunk index, byte order
4. Uses the chunk index to locate each chunk's bytes in the file
5. For each chunk, reverses the codec pipeline (see Codec Decode Functions below)
6. Deinterleaves and reassembles the full dataset
7. Produces reconstructed values

The Read step enters a **success state** and produces a `PipelineStage` containing the reconstructed values — same structure as the Values stage but potentially with different values where lossy transforms occurred.

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
  lossy: boolean;  // true if encode→decode does not perfectly round-trip
}
```

### Per-Codec Decode Behavior

| Codec | Reversible? | Lossy? | Decode behavior |
|-------|-------------|--------|-----------------|
| Scale/Offset | Yes | **Yes** when crossing float↔int boundary | `value / scale + offset`, cast back to original dtype. Float→int→float loses precision to the scale/offset quantization. Int→int may clip at range boundaries. |
| Bit Round | No | **Yes** | Decode is identity (returns input unchanged). The zeroed mantissa bits are irrecoverable. The lossy flag tells the diff view to expect differences. |
| Delta | Yes | No | Cumulative sum (prefix sum). Reverse of differencing. Order parameter means applying cumsum N times. |
| Byte Shuffle | Yes | No | Inverse transpose. Same element size parameter, reverse the byte grouping. |
| RLE | Yes | No | Expand (count, value) pairs back to byte runs. |
| LZ (simple) | Yes | No | Expand back-references to literal bytes. |

### Pipeline Reversal

The codec pipeline is reversed in order: if the encode pipeline was `[scale_offset, delta, shuffle, rle]`, the decode pipeline applies `[rle_decode, shuffle_decode, delta_decode, scale_offset_decode]`.

For per-variable pipelines (column mode), each variable's pipeline is reversed independently, then the variables are deinterleaved and reassembled.

For per-chunk pipelines (row mode), each chunk's pipeline is reversed, then the chunk is deinterleaved.

The dtype flows backward through the pipeline: if encoding went `float32 → int16 → int16 → int16 → uint8`, decoding goes `uint8 → int16 → int16 → int16 → float32`. Each decode step's `outputDtype` is the *input* dtype of the corresponding encode step. This information is stored in the metadata's codec pipeline specification.

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
