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

Each pipeline stage produces an output that the viewer can display. Stages are identified by index and carry:

```typescript
interface PipelineStage {
  name: string;                  // Display name (e.g., "Values", "Linearized", "1. Delta")
  bytes: Uint8Array;             // The byte content at this stage
  traces: ByteTrace[];           // Per-byte provenance, one entry per byte
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

- **Before structural steps (Values stage)**: perfect per-value tracing
- **After chunking/interleaving (Linearized stage)**: perfect per-value tracing, bytes are just reordered
- **After non-size-changing codecs (delta, shuffle, bitround)**: per-value tracing preserved (byte count stable, one-to-one mapping)
- **After dtype-changing codecs (scale/offset)**: per-value tracing preserved but byte count per value changes (e.g., 4 bytes → 2 bytes)
- **After size-changing entropy codecs (RLE, LZ)**: tracing drops to chunk-level. Individual bytes can no longer be mapped to specific source values. Hovering highlights all values from the source chunk.

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

## Codec Registry

Codecs are zarr-inspired but use friendlier naming. Each codec declares:

```typescript
interface CodecDefinition {
  key: string;                    // Unique identifier
  label: string;                  // Display name
  category: "mapping" | "reordering" | "entropy";
  description: string;            // Tooltip/help text
  params: Record<string, ParamDef>;
  applicableTo: (dtype: string) => boolean;  // Which input dtypes are meaningful
  encode: (bytes: Uint8Array, inputDtype: string, params: Record<string, any>) => {
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

### v1 Codecs

**Mapping codecs** (transform value domains):

| Codec | Params | Input → Output | Description |
|-------|--------|---------------|-------------|
| Scale/Offset | scale: number, offset: number, outputDtype: select | any → any | `(value - offset) × scale`, cast to output type. Primary use: float → integer for compressibility. |
| Bit Round | keepBits: number (1-23) | float → float | Zero least-significant mantissa bits. Reduces precision to improve compressibility. Only meaningful for float types. |

**Reordering codecs** (rearrange bytes for better compressibility):

| Codec | Params | Input → Output | Description |
|-------|--------|---------------|-------------|
| Delta | order: number (1-3) | any → same | Store value-to-value differences. Operates in typed value space, not byte space. Effective for slowly-changing data (sorted IDs, timestamps, coordinates). |
| Byte Shuffle | elementSize: number (1-8) | any → same | Transpose bytes by position within each element. Groups MSBs together, LSBs together. Element size should match dtype size (auto-defaulted). |

**Entropy codecs** (compress redundancy):

| Codec | Params | Input → Output | Description |
|-------|--------|---------------|-------------|
| RLE | — | any → uint8 | Run-length encoding. Outputs (count, value) byte pairs. Effective after bitround or quantization creates runs. |
| LZ (simple) | windowSize: number | any → uint8 | Simplified LZ77 with back-references. Finds repeated byte sequences. |

**v2 additions** (future): zstd via WASM, deflate, variable-length encoding, quantize.

### Codec Applicability and Warnings

Codecs declare which dtypes they're applicable to via `applicableTo()`. When a codec is applied to an inapplicable dtype (e.g., bitround on an integer, or shuffle on interleaved heterogeneous types), the UI shows a warning but does **not** prevent the operation. The result may be garbage — and that's intentional. The user learns through experimentation why certain codecs require certain data layouts.

**Warning UI**: when a codec step receives an input dtype that fails `applicableTo()`, the step in the pipeline editor gets a small warning icon (⚠) next to the codec name, colored in the `warning` theme color. Hovering or clicking the icon shows a tooltip with a short explanation (e.g., "Bit Round is designed for float types; applying to int16 zeros out data bits rather than mantissa bits"). The same warning icon appears on the corresponding node in the pipeline strip.

Additionally, when the interleaving is set to row-oriented and the variables have heterogeneous dtypes, the codec section's explanatory callout should note: "Mixed dtypes are interleaved — codecs like Byte Shuffle and Delta that assume uniform element size will produce garbled output. This is a key reason column-oriented formats exist."

When a codec produces output **larger** than its input (e.g., RLE on random data), the byte count in the pipeline strip node and the codec step annotation should display in the `warning` color to draw attention to the size increase.

### Codec Pipeline Display

Each step in the pipeline editor shows the output dtype as an annotation (e.g., "Scale/Offset →int16"). The dtype flows through the pipeline: scale/offset changes it, entropy codecs collapse it to uint8, other codecs preserve it. This makes it visible when a codec is receiving unexpected input.

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

All pipeline configuration is persisted to `localStorage` with a debounced save (500ms after last change). State is restored on page load.

The persistence layer should be a thin abstraction (`src/state/persistence.ts`) with `loadState(): AppState | null` and `saveState(state: AppState): void` functions, so the storage backend can be swapped later if needed (e.g., to IndexedDB for larger state, or to URL hash encoding for shareable links).

Storage key: `"0x00c0dec5-state"`. Each data model (tabular, array) gets a separate key: `"0x00c0dec5-state-tabular"` and `"0x00c0dec5-state-array"`, so switching models doesn't destroy the other model's configuration.

The persisted state object:

```typescript
interface AppState {
  dataModel: "tabular" | "array";
  shape: number[];
  chunkShape: number[];
  interleaving: "row" | "column";
  chunkOrder: "row-major" | "column-major";
  variables: Variable[];
  fieldPipelines: Record<string, CodecStep[]>;  // per-variable, used in column mode
  chunkPipeline: CodecStep[];                    // per-chunk, used in row mode
  metadata: {
    customEntries: { key: string; value: string }[];
    serialization: "json" | "binary";
  };
  write: {
    magicNumber: string;          // hex string
    partitioning: "single" | "per-chunk";
    metadataPlacement: "header" | "footer" | "sidecar";
    chunkOrder: "row-major" | "column-major";
  };
  ui: {
    leftPaneStage: number;
    rightPaneStage: number;
    leftPaneView: string;
    rightPaneView: string;
    sidebarWidth: number;         // pixels
    leftPaneRatio: number;        // 0-1, fraction of main area width allocated to left pane
  };
}

interface Variable {
  id: string;
  name: string;
  dtype: string;
  color: string;
}

interface CodecStep {
  codec: string;                  // codec key
  params: Record<string, any>;
}
```

### Model Switching

Switching between "Tabular" and "N-d Array" changes the UI presentation but does not destroy state unnecessarily. The current state is saved before switching, and restored if the user switches back. Each data model has a separate saved state slot.

### Presets (v2)

Named state snapshots that can be loaded. Built-in presets would replicate real-world formats:
- "This is basically Parquet" (tabular, column-oriented, per-column codecs, footer metadata)
- "This is basically GeoTIFF" (2D array, tiled chunks, metadata header)
- "This is basically Zarr" (N-d array, per-chunk files, sidecar metadata)

A "Custom" preset auto-saves the user's current configuration. Selecting a built-in preset doesn't destroy the custom state.

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

3. **Serialization toggle**: radio group for JSON / Binary.

4. **Serialized size**: displays the total byte count of the serialized metadata.

The Metadata Assembly also appears as a selectable stage in the pipeline strip and pane dropdowns. When selected, the pane shows the serialized metadata bytes in hex or flat view — so you can see exactly what the metadata looks like as bytes.

Serialized metadata bytes are then placed according to the Write step's configuration (header, footer, or sidecar).

## Write Step

The write step assembles the final file(s). It combines:

1. **Magic number** (optional): user-defined bytes at the start of the file. Could also appear at the end (configurable). Default: `00 C0 DE C5` (the tool's own name as a hex literal — and itself a demonstration of the concept).

2. **Metadata bytes**: the serialized metadata from the Metadata Assembly step, placed as header (before data), footer (after data), or in a separate sidecar file.

3. **Chunk data**: the encoded bytes from the codec pipeline, ordered according to the chunk ordering setting (row-major or column-major).

4. **Chunk index**: a table of byte offsets for each chunk. This is part of the metadata and is critical for random access. If metadata is a header, the chunk index can only be written after all chunks are written (requiring a two-pass write or a placeholder that gets filled in — worth discussing in the talk). If metadata is a footer, the chunk index is natural to write.

5. **Partitioning**: in "single file" mode, everything goes in one file. In "per-chunk" mode, each chunk is a separate file (named by chunk coordinates), and metadata lives in a root file or sidecar. This mirrors zarr's directory structure.

The output is one or more "virtual files" displayed in a file explorer view. Each file shows its name, size, and byte content (viewable in the hex/flat viewers).

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
- **Maximum data size**: the tool is for learning, not production. Reasonable limits: ~10K elements per variable, ~10 variables. Display a warning if configuration exceeds this.

## Accessibility

- All interactive controls should be keyboard-navigable
- Color is used for variable identification but should not be the only differentiator (add icons or labels)
- Hex view hover targets should be large enough to hit on touch devices (may need a touch-friendly mode)

## Edge Cases and Validation

The tool should handle degenerate configurations gracefully rather than crashing or producing blank output.

| Scenario | Behavior |
|----------|----------|
| Zero variables | Show an empty pipeline with a prompt: "Add a variable to get started." Panes show placeholder text. Pipeline stages produce 0-byte outputs. |
| Empty shape (e.g., `[0]` or `[]`) | Treat as invalid input. Keep the previous valid shape. Show input border in warning color. |
| Shape with very large dimensions (> 10K total elements) | Allow but show a warning below the shape input: "Large datasets may be slow. This tool is for learning, not production." Cap rendering at ~10K values in table/grid views. |
| Chunk shape larger than data shape on any dimension | Clamp each chunk dimension to the data shape dimension silently (one chunk on that axis). This is not an error — it just means no splitting on that axis. |
| Chunk shape of 1 on any dimension | Valid (maximally chunked). May produce many chunks. Warn if total chunk count exceeds ~1000. |
| Variable name collision (two variables with same name) | Show input border in warning color on the duplicate. The pipeline uses names as keys, so duplicates will cause data loss. |
| Variable name empty | Show input border in warning color. Use a fallback like `"unnamed_0"` internally. |
| Codec pipeline produces 0 bytes | Valid (e.g., RLE on empty input). Show "0B" in pipeline strip. Hex view shows empty state. |
| Codec pipeline produces bytes larger than input | Valid (not an error). Byte count shown in warning color as noted in Codec Applicability section. |
| All variables deleted | Same as zero variables case. |
| Interleaving switched from column to row with existing per-field pipelines | The per-field pipelines are preserved in state but become inactive. The UI switches to show the per-chunk pipeline editor. If the user switches back to column, the per-field pipelines reappear. |
| Shape dimensions changed (e.g., from 1-d to 2-d) while chunk shape is still 1-d | Pad chunk shape with the data shape's new dimensions (i.e., default new chunk dimensions to full extent). |

## Open Questions for Implementation

These are decisions left to the implementer's judgment:

1. **Chunk index representation**: the chunk index in metadata maps chunk coordinates to byte offsets. Recommended: a JSON array of objects `[{ coords: [0, 0], offset: 128, size: 512 }, ...]` for JSON serialization, and the same structure flattened for binary. But the implementer may find a more compact representation.

2. **File explorer interaction**: when partitioned into per-chunk files, clicking a file in the explorer should show that file's bytes in the selected pane. Whether there should also be a "show all files concatenated" option is left to the implementer.

3. **Pipeline strip interactivity**: currently spec'd as non-interactive (visual only). A reasonable enhancement would be: clicking a stage scrolls the sidebar to the corresponding config section. This is optional for v1.

4. **Metadata preview truncation**: for large metadata (many chunks → large chunk index), the sidebar preview should truncate. The exact truncation threshold and "show more" behavior is left to the implementer.

5. **Hex view column count**: the doc assumes 16 bytes per row. On narrow panes this may overflow. The implementer may want to make this responsive (e.g., 8 bytes per row on narrow panes).

## Implementation Order

Build in this order. Each phase should be functional and testable before moving to the next.

**Phase 1: Engine + Tests**
1. `src/types/` — all type definitions (dtypes, codecs, pipeline, state)
2. `src/engine/generate.ts` — PRNG data generation
3. `src/engine/elements.ts` — value → binary element conversion
4. `src/engine/chunk.ts` — chunking logic
5. `src/engine/linearize.ts` — interleaving
6. `src/engine/codecs.ts` — codec pipeline execution (all 6 codecs)
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
