# Row mode: single shared pipeline (delete per-variable codec support)

**Date:** 2026-08-20
**Status:** Approved
**Supersedes:** `2026-08-19-codec-unification-design.md` §4 ("Placement: the one hard rule (row interleaving)") and the corresponding plan's Tasks 8–9. Those docs remain as history; this spec removes the structured-prefix mechanism they introduced.

## Motivation

Row/interleaved mode currently runs each field pipeline's "maximal element-structured
prefix" per-variable before interleaving (`splitStructuredPrefix`), renders N per-field
editors plus a shared chunk editor, and dims the inactive remainder. Pedagogically this
undercuts the one lesson row mode exists to teach: interleave per element → you give up
per-field encoding freedom → you compress the combined stream once.

The two modes should map onto the two real ecosystems:

- **Column mode** — per-field codec pipelines, scale/offset as a filter (Zarr/numcodecs,
  Parquet-world). Unchanged.
- **Row mode** — no per-field filters; value fidelity is whatever the type carries
  (Avro-world, where precision lives in the type). One shared pipeline on the
  interleaved stream.

"You can't scale-offset in row mode" is not a missing feature; it is the lesson. The
codec-unification refactor itself (transforms as ordinary codecs, `outputDtypeFor`,
`sizeEffect`) is **kept in full** — only the row-mode structured-prefix mechanism is
deleted.

## New row-mode semantics

```
per variable: cast values to typeAssignment.storageDtype (valuesToBytes)
→ byte-interleave per element at raw storageDtype widths
→ run the shared chunkPipeline once on the interleaved stream
```

Field pipelines do not run at all in row mode. `SET_INTERLEAVING` continues to touch
neither `fieldPipelines` nor `chunkPipeline` state — switching back to column mode
reactivates the full field pipelines unchanged.

## Changes by area

### 1. Engine — encode (`src/engine/codecs.ts`, `src/engine/pipelineCompute.ts`)

- **Delete** `splitStructuredPrefix`, `isElementStructured`, `rowModeChunkInputDtype`
  (`codecs.ts`). `foldUniformDtype` survives — it is now fed raw schema storage dtypes
  instead of `pipelineOutputDtype` results.
- `encodeRowChunk` (`pipelineCompute.ts:369-444`): delete the per-variable prefix loop.
  Each variable contributes `valuesToBytes(cv.values, cv.dtype, byteOrder)` directly;
  interleave at raw dtype widths; `inputDtype = foldUniformDtype(raw dtypes)`;
  `encodedChunkMeta(chunkPipeline, inputDtype)` and `runCodecPipeline(interleaved,
  chunkPipeline, ...)` as today. `ChunkFieldLayout` slots built at raw dtype widths.
- `collectEncodedWarnings` (`pipelineCompute.ts:311-330`) row branch: check only the
  chunk pipeline (input dtype = the raw-dtype fold). No per-field warnings — nothing
  per-field runs.
- `layout.ts` and `write.ts` are untouched (already interleaving-agnostic).

### 2. Metadata (`src/engine/metadata.ts`)

- `collectMetadata` row branch: write `codec_pipelines` as the **bare chunk-pipeline
  array** (`JSON.stringify(activeSteps(state.chunkPipeline))`). The `{chunk, fields}`
  envelope is deleted — nothing per-field runs, so there is nothing to record.
- No migration/legacy support for envelope-shaped files: written files are in-session
  artifacts (standing project preference: drop, don't migrate).

### 3. Read path (`src/engine/read.ts`, `src/engine/readReassemble.ts`)

- `parseStructure` (`read.ts:277-309`): back to two-way `codec_pipelines`
  disambiguation — bare array = row (chunk pipeline only), plain object = column
  (by-name field pipelines). Delete the `{chunk, fields}` envelope branch and the
  column-dataset-named-`chunk`/`fields` disambiguation hazard with it.
- `readReassemble.ts`: delete per-field prefix reversal in `reconstructValues`'s row
  branch (`:288-331`), `rowModeEncodedSchema` (`:365-373`). `rowModeInputDtype` /
  `deinterleaveRowChunkBytes` operate on raw `storageDtype` widths straight from the
  parsed schema. Record width for offset derivation (`:215-239`) = sum of raw dtype
  widths — always derivable, so the size-changing-prefix `NoChunkIndexError` case in
  row mode disappears.
- `computeCodecLossyVariables` (`read.ts:478-515`) row branch: only the chunk-pipeline
  check remains; a lossy chunk step still marks **all** variables (unattributable to
  one field).
- `reverseCodecPipeline` (`decode.ts`) unchanged; row mode calls it once per chunk.

### 4. UI (`src/components/config/CodecSection.tsx`, `CodecPipelineEditor.tsx`)

- `CodecSection.tsx` row branch renders **only the shared pipeline editor** (input
  dtype = fold of raw storage dtypes). Delete the per-field editor loop,
  `postPrefixDtypes`, and post-prefix mixed-dtype gating. The mixed-dtype warning
  (`codec-mixed-dtype-warning`) stays, gated on the raw `storageDtype`s.
- Banner text: field pipelines apply in column mode only; the interleaved stream gets
  one shared pipeline. Include a preserved-state note (column-mode field pipelines are
  kept and reactivate on switch back).
- `CodecPipelineEditor.tsx`: delete the `inactiveFrom` prop, its dimming, and the
  `codec-row-inactive-note-{variable}` rendering. Column mode never used them.
- Interleave section's "Forces a single codec pipeline" helper text is now accurate;
  keep as-is.
- Removed testids: `codec-row-inactive-note-{variable}`; per-field `codec-*-{variable}-*`
  testids simply don't render in row mode (only `codec-add-chunk` and
  `codec-step-chunk-{i}` remain there).

### 5. Presets

- `avroesque.json`: drop the three scale-offset field steps (tmax/tmin/prcp) — all
  `fieldPipelines` empty. Variables store as raw float32; deflate runs on the
  interleaved stream. Preset description/guide text names the tradeoff explicitly:
  row formats put precision in the type, so the int16-tenths trick is unavailable —
  compare with Parquet-adjacent, which keeps it as a per-field codec step.
- `parquet-adjacent.json` (column), `cog-esque.json` / `geotiffesque.json` (row but
  empty field pipelines), `zarrish.json` (column): unaffected, verified.

### 6. Docs

- CLAUDE.md pitfall 4: rewrite — "row mode runs no field pipelines: cast to
  storageDtype, interleave, one shared pipeline. `SET_INTERLEAVING` touches no
  pipeline state." Remove `splitStructuredPrefix` / post-prefix-warning content.
- `docs/design.md`: update the row-oriented/BIP description (~:83), the summary table
  (~:96), the mixed-dtype warning callout (~:342), the `codec_pipelines` metadata
  format section (~:676), and the Edge Cases row (~:910).
- This spec and its plan are **not committed** (user instruction); the 2026-08-19
  codec-unification docs remain untracked history.

### 7. Tests

Delete:
- `splitStructuredPrefix` unit tests (`tests/unit/engine/codecs.test.ts:335-367`).
- `tests/unit/components/codecInactiveFrom.test.tsx`.

(The `{chunk, fields}` parser disambiguation test at `read.test.ts:939-956` is
**kept**: a pathological column dataset with variables named `chunk`/`fields`
parses identically under the two-way rule, so the test still guards the parse.)

Rewrite:
- `tests/unit/components/codecSectionMixedDtype.test.tsx`: warning gates on raw
  storage dtypes.
- `pipeline.integration.test.ts` row-mode block (`:259-337`): field pipelines do NOT
  run in row mode; interleave at raw widths; chunk pipeline applies.
- `read.test.ts` row-mode block (`:160-378`): roundtrip with chunk pipeline only;
  codecs-group-off byte-count mismatch still covered via a size-changing chunk step;
  chunk-lossy marks all variables; offsets derivable without chunk index (raw widths).
- `tests/ui/scenario-transform-codecs.mjs`: switching to row hides per-field editors
  entirely (no `codec-add-{variable}`, one `codec-add-chunk`); switching back restores
  the field pipeline intact.

Unchanged: `layout.equivalence`, `layout.reverse`, `roundtrip.matrix`,
`resyncDtypeParams` (generic, not prefix-specific).

## Non-goals

- No decimal storage dtype (deferred; revisit if the row-mode fidelity gap hurts).
- No changes to column mode, codec unification (`outputDtypeFor`, `sizeEffect`,
  transform codecs in `CODEC_REGISTRY`), tracing modes, or the write step.
- No migration of envelope-shaped `codec_pipelines` metadata.

## Success criteria

- `npx vitest run` green.
- `node tests/ui/scenario-transform-codecs.mjs` and `scenario-real-codecs.mjs` green
  against a dev server.
- Row-mode UI shows exactly one codec chain; column mode is pixel-identical to before.
- Avro-esque preset loads, round-trips (Read succeeds), and its description names the
  row-mode precision tradeoff.
- `grep -r splitStructuredPrefix src tests` returns nothing.
