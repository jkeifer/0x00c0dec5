# Read-Process View + Granular Metadata — Design Spec

**Date:** 2026-07-10
**Status:** Approved for planning
**Context docs:** `docs/design.md` (core spec), `docs/extension-read-step.md`
(read step + failure taxonomy), `notes/improvement-ideas.md` §1 (exploration),
`notes/Codecs.transcript.md` (the motivating memo).

## Goal

Answer the memo's central question on screen: **what does a reader need to
know to read a file, and why do format drivers exist?** Two halves, one
feature:

1. **Read-process view.** The reader narrates its work as an ordered step
   checklist — check magic → locate metadata → parse → read schema → read
   layout → locate chunks → decode → reassemble — showing what each step
   needed, what it found, and exactly where it stopped and why on failure.
2. **Granular metadata.** The all-or-nothing "include metadata" decision
   becomes five per-group toggles (schema / layout / codecs / chunk index /
   descriptive), each mapping to a *specific* reader step that fails — or
   deliberately doesn't — without it.

The talk moment: flip one toggle, watch the reader march down the checklist
and die at a named step with an educational explanation. The standing lesson:
structural metadata (needed to read bytes) vs descriptive metadata (needed to
*understand* data — omitting it costs the reader nothing).

## Non-goals

- **No geo step.** The "georeference" reader step belongs to the geo project
  (`notes/improvement-ideas.md` §5); this spec's step list is designed so a
  later step can be appended without rework (steps are an ordered list keyed
  by id, not a fixed enum baked into UI positions).
- **No demo presets.** Live toggling is the demo (decided 2026-07-10); the
  guide panel's Read step gets one sentence pointing at the toggles, nothing
  more.
- **No change to the magic-number contract (D2).** The reader still receives
  the format's magic out-of-band; `verify-magic` is a checklist step, not a
  new mechanism.
- **No fully-itemized per-key toggles.** Five groups, decided; the chunk
  index keeps its existing independent semantics (D3) and simply joins the
  group UI.

## Current state (verified 2026-07-10)

- `src/engine/read.ts` (~900 lines) already executes the exact ordered
  sequence with a typed failure taxonomy (`ReadFailureReason`:
  `no-metadata` / `metadata-not-found` / `bad-magic` / `corrupt-metadata` /
  `no-chunk-index` / `decode-error`) and per-reason educational messages
  (`FAILURE_MESSAGES`). It does not narrate — `ReadFileResult` is terminal
  state only.
- `src/engine/metadata.ts` `collectMetadata` emits a flat entry list; keys
  group naturally (see table below). `metadata.includeChunkIndex` (D3) and
  `write.includeMetadata` already exist as the two current knobs.
- The Read pane failure display is a plain message block in
  `src/components/viewers/StagePane.tsx` (~188–205). Success routes to the
  normal value viewers. View modes are per-pane radios (`view-mode-{mode}`).
- `ReadStatus.tsx` is the sidebar Read section.
- `readFile` runs inside the worker (`computeReadStage` in
  `src/engine/pipelineCompute.ts`) — anything added to its result must be
  plain structured-cloneable data.

## Design

### 1. Engine: the step log

`readFile` gains a step recorder. New types in `src/types/pipeline.ts`:

```typescript
export type ReadStepId =
  | 'verify-magic'      // leading (and trailing, per footerLocator) magic check
  | 'locate-metadata'   // header probe / footer trailer seek / scan / sidecar
  | 'parse-metadata'    // JSON or binary envelope deserialization
  | 'read-schema'       // variables + storage dtypes + type assignments present?
  | 'read-layout'       // shape/chunking/interleaving/ordering present?
  | 'locate-chunks'     // chunk index lookup, or computed offsets when possible (D3)
  | 'decode-chunks'     // reverse codec pipelines (or assume-identity; see §3)
  | 'reassemble';       // deinterleave + reverse type assignment → logical values

export interface ReadStep {
  id: ReadStepId;
  label: string;        // display name, e.g. "Verify magic number"
  needed: string;       // what the reader required, in plain language
  found: string;        // what it actually found (or didn't)
  outcome: 'ok' | 'failed' | 'skipped';
  /** failed steps only: the educational explanation (reuses/extends the
   *  FAILURE_MESSAGES voice); ok steps may carry a short note (e.g.
   *  "no codec info — assuming raw bytes"). */
  detail?: string;
}
```

`ReadSuccess` and `ReadFailure` both gain `steps: ReadStep[]` (always all 8,
in order; steps after a failure are `'skipped'`). `ReadFailure.reason` /
`message` remain — the failed step's `detail` carries the same text, so the
existing sidebar/pane consumers keep working during the transition.

**Step ↔ failure-reason mapping** (existing reasons keep their meaning):

| Step | Fails with |
|---|---|
| verify-magic | `bad-magic` |
| locate-metadata | `no-metadata` (master toggle off), `metadata-not-found` (D1 scan miss) |
| parse-metadata | `corrupt-metadata` |
| read-schema | **new** `missing-schema` |
| read-layout | **new** `missing-layout` |
| locate-chunks | `no-chunk-index` (D3) |
| decode-chunks | `decode-error` (incl. the assume-identity size-mismatch case, §3) |
| reassemble | `decode-error` (existing reassembly/deinterleave errors) |

The two new `ReadFailureReason` values get `FAILURE_MESSAGES` entries in the
established voice, e.g. `missing-schema`: *"Metadata was found and parsed,
but nothing describes the variables — their names, storage types, or how
logical values were converted for storage. The reader can locate bytes but
cannot interpret a single one of them."*

### 2. Granular metadata: five groups

`AppState.metadata` gains an `include` map (all default `true`), absorbing
the existing chunk-index toggle:

```typescript
metadata: {
  serialization: 'json' | 'binary';
  customEntries: MetadataEntry[];
  include: {
    schema: boolean;       // schema, type_assignments, logical_types
    layout: boolean;       // shape, chunk_shape, chunk_grid, chunk_order,
                           // partitioning, interleaving
    codecs: boolean;       // codec_pipelines
    chunkIndex: boolean;   // chunk_index (absorbs metadata.includeChunkIndex — D3 semantics unchanged)
    descriptive: boolean;  // variable_statistics + ALL customEntries
  };
}
```

- **Persistence migration:** persisted states with the old
  `includeChunkIndex` field migrate to `include.chunkIndex` via the existing
  `validateExternalState` migrate → default-merge → validate path; old
  presets/checkpoints/share payloads must load cleanly (test required).
- `collectMetadata` filters entries by group. The envelope keys
  (`metadata_format`, `byte_order`) are always written when the master
  toggle is on — they describe the metadata blob itself, not the data, and
  `parse-metadata` needs them; the spec calls this out in the Metadata
  section's UI copy rather than pretending they're optional.
- `write.includeMetadata` (the master, in the Write section) is unchanged
  and supreme: off means no metadata at all (current behavior), and the five
  group toggles render disabled with a "metadata is not being written" note.
- The Metadata pane view and byte counts update for free (fewer entries →
  smaller serialized blob → honest size numbers, which is itself a lesson:
  metadata has a cost).

### 3. Reader semantics per omission

- **schema off** → `read-schema` fails (`missing-schema`). Bytes located,
  nothing interpretable.
- **layout off** → `read-layout` fails (`missing-layout`). Reader knows the
  types but not the geometry — can't even say how many elements exist.
- **codecs off** → **assume identity** (decided 2026-07-10: garbage is the
  lesson). The reader proceeds as if no codecs were applied:
  - actual pipelines empty → honest success, `decode-chunks` notes
    *"no codec info — none was needed"*;
  - only non-size-changing codecs were applied (delta, byte-shuffle) →
    the read *"succeeds"* with garbled values — the diff view lights up,
    reproducing the design doc's "the garbled output IS the lesson"
    philosophy; `decode-chunks` outcome is `ok` with detail *"no codec info —
    assumed raw bytes"* (the checklist is honest about what the reader
    believed, not what was true);
  - size-changing codecs (RLE/LZ) were applied → chunk byte counts don't
    match the layout's expectation → `decode-chunks` fails (`decode-error`)
    with a size-mismatch detail naming expected vs actual bytes. **Spike
    (plan item):** verify `read.ts` performs an expected-vs-actual byte-count
    check at this point today; add one if reassembly currently relies on
    implicit length math.
- **chunkIndex off** → existing D3 behavior, unchanged, surfaced at
  `locate-chunks` (fails only for the configurations where offsets can't be
  computed — variable-size chunks in a single file).
- **descriptive off** → nothing fails, ever. The checklist's success run
  makes the point explicitly: `read-schema`'s `found` notes that statistics
  and custom entries were absent and *not needed*. This is the
  structural-vs-descriptive metadata lesson, stated where the user is
  looking.

### 4. UI

- **Process view mode (decided).** The Read stage gains a `process` view
  mode (`view-mode-process` radio, rendered only when the pane's selected
  stage is Read). `ReadProcessView` (new,
  `src/components/viewers/ReadProcessView.tsx`) renders the 8 steps as rows:
  outcome icon (✓ / ✗ / – for skipped), label, needed → found columns, and
  the failed step expanded with its `detail`. Testids: `read-process-view`,
  `read-step-{id}`.
- **Failure replaces the plain message.** When the read fails, the Read pane
  shows the checklist regardless of selected view mode (it supersedes the
  current message block in `StagePane.tsx` ~188–205 — the failed step row
  carries the same message text). No auto-switching of view modes.
- **Metadata section UI.** Five toggle rows in the Metadata sidebar section,
  testids `include-schema-toggle`, `include-layout-toggle`,
  `include-codecs-toggle`, `include-chunk-index-toggle` (existing testid
  preserved — scenarios and CLAUDE.md already reference it),
  `include-descriptive-toggle`. Each row gets a one-line consequence hint
  (e.g. "without this the reader stops at: read schema"). Disabled state
  when master off, per §2.
- **Sidebar ReadStatus** gains a compact progress line: `"5/8 steps · failed
  at: decode chunks"` (success: `"8/8 steps"`), above the existing
  message.
- **Pipeline strip Read node:** unchanged (✓/✗ indicator).
- **Guide panel** (`src/components/guide/steps.ts`): the Read step's
  teaching text gains one sentence pointing at the granular toggles and the
  Process view.

### 5. Error handling

Every toggle combination (2^5 × master × placements × partitioning) must
produce a valid, non-crashing pipeline with a coherent checklist — degenerate
configs (zero variables, zero-byte output, sidecar-with-nothing-in-it)
included. The reader never throws past `readFile`'s boundary; unexpected
internal errors surface as the current `decode-error` catch-all with the step
log intact up to the failure point.

### 6. Testing strategy

Engine-first (CLAUDE.md):

1. **Step-log unit tests** (`tests/unit/engine/readSteps.test.ts`): for every
   existing `ReadFailureReason`, assert the step log shows ok-steps up to the
   mapped step, `failed` at it, `skipped` after; success shows 8× `ok`.
2. **Toggle-matrix tests**: each group off individually (and
   schema+layout off together) × {json, binary} × {header, footer, sidecar}
   × {single, per-chunk} — assert the failing step, reason, and that
   `collectMetadata` omits exactly the group's keys. The codec-omission
   three-way (empty / non-size-changing / size-changing pipelines) gets its
   own explicit cases including the garbled-success one (assert reconstructed
   values differ from originals while `success === true`).
3. **Migration test**: persisted state with legacy `includeChunkIndex`
   loads into `include.chunkIndex`; old presets still load.
4. **Equivalence suite untouched**: metadata bytes change with toggles, but
   the layout-equivalence tests derive both sides from the same state — no
   golden updates expected; they must stay green.
5. **Playwright scenario** (`tests/ui/scenario-read-process.mjs`): flip each
   toggle and assert the checklist shows the right failed step + message;
   success path shows 8/8; the shuffle-without-codec-metadata case shows a
   "successful" read whose diff summary reports differences; existing
   `scenario-placement-matrix.mjs` stays green (it exercises
   includeMetadata/chunk-index paths — migration compatibility proof).

### 7. Documentation

- `docs/extension-read-step.md`: a short addendum section describing the
  step log and the five groups (the failure taxonomy portion is already
  written as "generalized" — this makes it true).
- CLAUDE.md: new testids (`view-mode-process` follows the existing
  `view-mode-{mode}` convention and needs no new entry; `read-process-view`,
  `read-step-{id}`, the four new toggle ids), scenario list addition.

## Open questions (spike-sized, resolved during implementation)

- Exact insertion points for the step recorder in `read.ts` — whether the
  helper-function boundaries (`locateMetadata`, chunk location, decode) map
  1:1 to steps or one helper spans two steps (read-schema/read-layout are
  today implicit in metadata parsing and will need explicit presence checks
  split out).
- Whether the byte-count mismatch check for the assume-identity path exists
  or must be added (§3 spike).
- Whether `ReadFailure.byteCount` and the existing message block have other
  consumers that need the step log threaded (grep at plan time).
