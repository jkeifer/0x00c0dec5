# Codec Unification — Design Spec

Date: 2026-08-19. Status: drafted from design conversation; not yet planned or
implemented.

## Goal

The tool needs quantization and rounding, and it needs them composable with
scale/offset (quantize *before* scale is a different — and instructive — result than
the reverse). Today scale/offset and bit-rounding are not composable with anything:
they live on `Variable.typeAssignment` and are applied exactly once, in a fixed
internal order, at the Typed stage (`assignType`). They are also invisible to the
metadata round-trip lesson — a reader must undo them, yet they serialize into the
schema group rather than `codec_pipelines`.

This redesign deletes the transform half of `typeAssignment` and makes value
transforms first-class codecs — **quantize**, **bitround**, **scale-offset** — in the
one existing registry, with metadata additions to `CodecDefinition` that let the
pipeline machinery reason about them. CLAUDE.md pitfall 3's "two separate mechanisms"
split shrinks to one mechanism plus a plain cast.

## Principle: everything is a bytes codec

There is no array-codec/bytes-codec taxonomy (contra Zarr v3). An "array codec" is a
bytes codec with a stride, and the stride is supplied by the input dtype — which the
existing interface already passes: `encode(bytes, inputDtype, params)`. Delta and
zigzag prove this today; they are value transforms running through the bytes
interface. Scale/offset fits verbatim: interpret bytes at the input stride,
transform, emit at the output stride.

The constraint Zarr encodes as a type hierarchy is *derived* here from declared
codec metadata: a codec whose output retains fixed-width element structure can run
anywhere elements exist (including per-variable under row interleaving, §4); a codec
whose output is an opaque blob forces itself and everything after it to be
chunk-scoped. Same physics, but as a theorem instead of an axiom — a pipeline
crosses the "boundary" wherever its dtypes actually cross it.

Corollary: nonsense compositions are legal. Scale-offset after zstd interprets a
compressed blob as floats and produces garbage — that is an advisory ⚠ and a lesson,
not a blocked state (the tool's standing ethos: let the user do the wrong thing and
show them why it's wrong). The only hard rules are physical ones (§4). One
engineering consequence: a codec reading at stride N must handle byte lengths not
divisible by N without crashing (existing degrade-gracefully rule).

## 1. `CodecDefinition` metadata (`src/types/codecs.ts`)

Four additions:

- **Declared output dtype.** `outputDtype?: (inputDtype: DtypeKey, params) =>
  DtypeKey`. Scale-offset returns `params.targetDtype`. `outputDtypeFor`
  (`src/engine/codecs.ts`) stays the single source of truth for dtype flow but
  becomes: codec's declaration if present, else the current hardcoded rule
  (entropy/traceMode → `uint8`, else input). **Signature change:** `outputDtypeFor`
  gains a `params` argument — every caller (`computeDtypeFlow`,
  `reverseCodecPipeline`, `buildEncodedLayout`, `encodedChunkMeta`, editor labels)
  threads the step's params through. This is the mechanical bulk of the change.
- **`sizeEffect: 'preserving' | 'fixed-ratio' | 'variable'`.**
  - `preserving` — output byte length equals input (today's non-entropy codecs).
  - `fixed-ratio` — length changes but deterministically, from the input/output
    element widths (scale-offset float64→int16 = ¼). Offsets remain computable from
    geometry + codec metadata, so fixed-ratio does **not** demand a chunk index.
  - `variable` — data-dependent length (every entropy codec).
  Every "size-changing codec" check in the read path (`readReassemble.ts`'s
  `NoChunkIndexError` sites, `AssumedIdentitySizeMismatchError`'s expectation
  math) rekeys from `category === 'entropy'` to `sizeEffect === 'variable'` /
  expected-length computation that folds fixed ratios in.
- **Input expectation note.** `applicableTo(dtype)` already exists; add a
  human-readable `expects?: string` ("float input — integer input has no fractional
  part to quantize") surfaced by `stepWarnings` and in the picker. **Advisory only**:
  inapplicable codecs stay listed, selectable, and running — ⚠ plus the note, never
  filtered or hard-disabled. (Considered and rejected: filtering invalid codecs from
  the picker — it deletes lessons, e.g. zigzag-on-unsigned and scale-after-zstd.)
- **Stats channel.** `encode` may additionally return `stats?: { clipped: number;
  rounded: number }`. Transform codecs report them; feeds the lossy indicator (§7).
  `CodecDefinition.isLossy` stops being vestigial: the three transforms return
  `true` (delta/zigzag/shuffle/entropy stay `false`).

## 2. The three transform codecs (`src/engine/codecs.ts`)

New `category: 'transform'` alongside `reordering`/`entropy`. All three: no
`traceMode` (value-preserving — element i's value stays at slot i), pointwise
(order-independent), `isLossy: () => true`, decode present so the read path can
reverse or pass through.

- **`quantize`** — keep `digits` decimal digits (numcodecs `Quantize` analog).
  Dtype-preserving, `sizeEffect: 'preserving'`. Decode = identity (irrecoverable
  precision loss). Reports `rounded`.
- **`bitround`** — keep `keepBits` mantissa bits. `applyBitround` moves from
  `typeAssign.ts` verbatim (including the DC-6 keepBits===20 boundary fix). Float
  dtypes only (`applicableTo`), `sizeEffect: 'preserving'`, decode = identity.
- **`scale-offset`** — `v' = round((v − offset) × scale)`, clamped and cast into
  `params.targetDtype` (numcodecs `FixedScaleOffset` analog). Params: `scale`,
  `offset`, `targetDtype` (select over int dtypes). `outputDtype` returns
  `targetDtype`; `sizeEffect: 'fixed-ratio'`. Decode: read at `targetDtype`,
  `v = v'/scale + offset`, emit at the pre-step dtype. Reports `clipped`/`rounded`
  (the clamp/round bookkeeping currently in `assignType` moves here). NaN → 0 on
  int cast, counted, per the existing NF-4 behavior.

The pre-step dtype for decode comes from recomputing the forward dtype flow
(`reverseCodecPipeline` already walks `storageDtype` forward via `outputDtypeFor`
before reversing) — exact plumbing is an implementation-planning detail.

## 3. `TypeAssignment` shrinks to the cast (`src/types/state.ts`, `src/engine/typeAssign.ts`)

- `TypeAssignment = { storageDtype: DtypeKey }`. `scale`/`offset`/`keepBits` deleted.
- `assignType` keeps: the char branch, the cast with clamp/round/NaN stats (a plain
  float64→int16 cast still clips and rounds — those stats stay), min/max/mean
  accumulation. Drops: the scale/offset transform, `applyBitround`, the float
  read-back rounding check tied to scale.
- `reverseTypeAssignment` becomes a plain `bytesToValues` at `storageDtype`.
- The read handoff invariant is unchanged: the fully-reversed codec pipeline's
  output dtype must equal `typeAssignment.storageDtype`.
- **The GHCN scale lesson relocates, same shape:** storageDtype stays `float32` (4
  bytes/value); deriving the 2-byte encoding is now "add a scale-offset codec with
  scale 10 targeting int16" — composable, ordered, and visible in the written
  `codec_pipelines` metadata.

## 4. Placement: the one hard rule (row interleaving)

Define **element-structured** for a step: no `traceMode` declared and `sizeEffect
!== 'variable'` — its output is still a fixed-width-element stream (possibly at a
new width). Transforms and delta/zigzag qualify; shuffles (slot↔element identity
destroyed) and entropy codecs (no elements at all) do not.

- **Column mode: unchanged.** Whole field pipeline runs per-field on contiguous
  bytes, transforms anywhere in the order the user puts them.
- **Row mode:** each field pipeline's **maximal element-structured prefix** runs, on
  a strided view of the interleaved chunk (field offset within record, record
  stride); a fixed-ratio step changes that field's width and records repack. Because
  interleave order is element order, this is exactly equivalent to applying the
  prefix per-variable before interleaving — including for delta (strided delta
  across records differences the same field's consecutive elements). The remainder
  (first non-structured step onward) is inactive: preserved in state untouched,
  dimmed in the editor with a note. This *narrows* pitfall 4, which currently
  deactivates the entire field pipeline in row mode; `SET_INTERLEAVING` still never
  touches state.
- **Chunk pipeline: unchanged.** A transform there interprets the whole (possibly
  mixed-dtype interleaved) stream at its input dtype — legal nonsense, advisory ⚠.

This is what makes row-interleaved presets expressible: avroesque keeps per-variable
scale in row mode, which the deleted `typeAssignment.scale` could do and a
column-only codec could not.

## 5. Tracing: fixed-ratio value-preserving regions (`src/engine/layout.ts`)

New requirement (pitfall 1 extension): a value-preserving pipeline whose element
width changes. The current value-preserving path re-bases the linearized region 1:1,
which assumes byte length is unchanged. Fixed-ratio regions instead recompute slot
geometry at the post-pipeline element width: element i at `i × postWidth`, same
element order, still O(1)/O(log n) lookups. `mode` stays `'value-preserving'` —
hover linking works, because slot i genuinely is element i.

- `encodedChunkMeta`'s dtype fold consumes the params-aware `outputDtypeFor`;
  `slotDtype`/`traceMode` fold semantics unchanged (transforms declare no
  `traceMode`, so they never degrade the mode).
- Display values are already correct by construction: each stage decodes its own
  bytes, so the Encoded pane after scale-offset shows the scaled integers — the
  lesson, not a bug.
- `tests/unit/helpers/referenceTraces.ts` (frozen reference impl) and
  `encodedTracing.test.ts` gain the fixed-ratio case;
  `scenario-hover-linking.mjs` pins it in the UI.

## 6. Read path & metadata

- `codec_pipelines` now carries the transforms with their params (including
  `targetDtype`). The `typeAssignments` schema entry (`src/engine/metadata.ts`)
  reduces to `{ storageDtype }` — its `scale`/`offset`/`keepBits` keys are deleted.
- `reverseCodecPipeline` decodes transforms in reverse order: quantize/bitround
  decode as identity; scale-offset divides out and re-emits at the pre-step dtype.
- **The codecs-group-off lesson sharpens.** Scale-offset applied + `codecs` include
  group off → the reader assumes identity, expects `storageDtype`-width bytes, finds
  ¼ as many → honest hard fail (`AssumedIdentitySizeMismatchError`). Quantize or
  bitround + codecs off → the read *succeeds and is genuinely correct* (decode is
  identity; the stored values are simply the quantized ones) — a new, third behavior
  in that lesson family worth narrating in the decode step's detail text.
- **Chunk index:** fixed-ratio pipelines do not trigger `NoChunkIndexError` —
  offsets are computable from geometry + codec metadata. Only `sizeEffect ===
  'variable'` steps demand the index (rekeyed per §1).

## 7. UI

- `CodecPipelineEditor`/`CodecSection`: transforms appear in the picker under their
  category; expectation violations render ⚠ + the `expects` note (never hidden).
  Row-mode: the inactive suffix (§4) renders dimmed with a note, replacing the
  current all-or-nothing row-mode messaging.
- Per-step lossy badge when the step's stats report `clipped`/`rounded` > 0, with
  counts, sourced from the worker stage payload (pitfall 8: no engine calls in
  components).
- `TypeAssignConfig.tsx`: scale/offset/keepBits controls deleted. The observed-range
  note (`type-assign-range-{variableId}`) stays — it now informs both the
  storageDtype choice and the scale-offset codec's params. The lossless/lossy
  indicator aggregates the Typed stage's cast stats *and* the variable's codec-step
  stats.

## 8. Presets / persistence / share

- Three presets carry `typeAssignment.scale` (parquet-adjacent ×3 variables,
  avroesque ×3, cog-esque ×1; none use `offset`/`keepBits` — verified). Each
  rewrites to `storageDtype: 'float32'` + a leading scale-offset step
  (`scale: 10, targetDtype: 'int16'`) in that variable's field pipeline (cog-esque:
  ahead of its existing delta + entropy steps). Avroesque is row-interleaved — its
  scale steps run via §4's structured prefix.
- `migrateState` (`src/state/persistence.ts`): any persisted `typeAssignment`
  carrying `scale`/`offset`/`keepBits` → return `null` (drop to defaults — standing
  no-migration policy). Share links validate through the same path; the validator
  accepts `category: 'transform'` codec keys and their params.

## Docs to update on implementation

CLAUDE.md pitfall 3 (the two-mechanism split this deletes), the guide's type-assign
and codec steps, `docs/design.md`'s codec table and Edge Cases rows touching
scale/keepBits.

## Open questions (for implementation planning, not blockers)

- Decode dtype plumbing for scale-offset: recompute forward flow in
  `reverseCodecPipeline` (preferred — no serialized redundancy) vs. serializing the
  source dtype into params.
- Worker payload shape for per-step stats (extend `runCodecPipeline`'s per-step
  return vs. a parallel stats array).
- Whether the strided row-mode execution is implemented literally (strided views +
  repack) or as the equivalent hoist-before-interleave (simpler; identical results
  per §4) — an engine-internal choice invisible to users.
