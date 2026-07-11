# Read-Process View + Granular Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The reader narrates an 8-step checklist (verify magic → reassemble) with per-step needed/found/outcome, and the all-or-nothing metadata toggle becomes five per-group toggles (schema/layout/codecs/chunk-index/descriptive), each mapping to a specific reader step.

**Architecture:** `readFile` (src/engine/read.ts) gains a step recorder threaded through its existing helper boundaries; two new failure reasons (`missing-schema`, `missing-layout`) come from presence checks split out of `parseStructure`; codec omission uses assume-identity semantics (already latent — `codec_pipelines` is optional in `parseStructure`; this plan makes it explicit and adds the byte-count mismatch check). `collectMetadata` filters entries by a key→group map driven by `metadata.include`. UI: a `process` view mode on the Read stage (`ReadProcessView`), the failure message block replaced by the checklist, five toggle rows in the Metadata section, and a progress line in ReadStatus.

**Tech Stack:** React 19 + TypeScript + Vite; vitest (unit tests in `tests/unit/`); Playwright scenario harness (`tests/ui/scenario-helpers.mjs`); no new dependencies.

## Global Constraints

- **No new dependencies.** **Unit tests live in `tests/unit/`** (never `src/`).
- **Frozen contracts:** existing `ReadFailureReason` values keep their meaning; existing testids (`include-chunk-index-toggle`, `read-status`, `view-mode-{mode}` convention) keep working; the reader still receives the magic out-of-band (D2); chunk-index semantics (D3) unchanged.
- **Spec decisions (binding, decided 2026-07-10):** Process view mode (no auto-switching; failure shows the checklist regardless of mode); five groups exactly (schema/layout/codecs/chunkIndex/descriptive); codec omission = assume identity (garbled success for non-size-changing pipelines; size-mismatch `decode-error` for size-changing); no demo presets.
- **The layout-equivalence suite must stay green untouched** (`tests/unit/engine/layout.equivalence.test.ts`, `layout.reverse.test.ts`) — metadata content changes flow through both production and reference sides identically.
- **Educational voice:** new `FAILURE_MESSAGES` entries and step copy match the existing entries' tone (read `FAILURE_MESSAGES` at src/engine/read.ts:315 before writing any).
- **All existing tests and the seven standing scenarios stay green after every task** (`npx vitest run`; scenario files per CLAUDE.md's list). Commit after every task with the given message. No branch changes.

---

### Task 1: Metadata groups — state, migration, collectMetadata filtering

**Files:**
- Modify: `src/types/state.ts` (metadata config ~lines 70-80, DEFAULT_STATE ~135-145)
- Modify: `src/state/persistence.ts` (`migrateState` ~line 62, default-merge path ~297-310)
- Modify: `src/engine/metadata.ts` (`collectMetadata` — the `entries.push` sites at lines 33-120)
- Test: `tests/unit/engine/metadataGroups.test.ts` (new), `tests/unit/state/persistence.test.ts` (extend if it exists — grep `tests/unit/state/`; else create `tests/unit/state/metadataMigration.test.ts`)

**Interfaces:**
- Consumes: existing `MetadataEntry {key, value}`, `collectMetadata(state, encodedChunks, variableStats)`, `dedupeCustomKey`.
- Produces (later tasks rely on these exact names):

```typescript
// src/types/state.ts — replaces metadata.includeChunkIndex
export interface MetadataIncludeConfig {
  schema: boolean;       // schema, type_assignments, logical_types
  layout: boolean;       // shape, chunk_shape, chunk_grid, chunk_order, partitioning, interleaving
  codecs: boolean;       // codec_pipelines
  chunkIndex: boolean;   // chunk_index (absorbs includeChunkIndex — D3 semantics unchanged)
  descriptive: boolean;  // variable_statistics + ALL customEntries
}
// metadata: { serialization; customEntries; include: MetadataIncludeConfig }
// DEFAULT_STATE: all five true.

// src/engine/metadata.ts
export const METADATA_KEY_GROUPS: Record<string, keyof MetadataIncludeConfig> = {
  schema: 'schema', type_assignments: 'schema', logical_types: 'schema',
  shape: 'layout', chunk_shape: 'layout', chunk_grid: 'layout',
  chunk_order: 'layout', partitioning: 'layout', interleaving: 'layout',
  codec_pipelines: 'codecs',
  chunk_index: 'chunkIndex',
  variable_statistics: 'descriptive',
  // metadata_format and byte_order are envelope keys: ALWAYS written
  // (they describe the metadata blob itself; parse-metadata needs them).
};
```

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/engine/metadataGroups.test.ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_STATE } from '../../../src/types/state.ts';
import type { AppState } from '../../../src/types/state.ts';
import { collectMetadata, METADATA_KEY_GROUPS } from '../../../src/engine/metadata.ts';
import { computePipelineStages } from '../../../src/engine/pipelineCompute.ts';

function stateWith(include: Partial<AppState['metadata']['include']>): AppState {
  return {
    ...DEFAULT_STATE,
    metadata: {
      ...DEFAULT_STATE.metadata,
      customEntries: [{ key: 'author', value: 'test' }],
      include: { ...DEFAULT_STATE.metadata.include, ...include },
    },
  };
}

// Build encodedChunks/variableStats once via the real pipeline.
function collectFor(state: AppState) {
  const result = computePipelineStages(state);
  // Re-derive the inputs collectMetadata needs. Check pipelineCompute.ts for
  // how computeMetadataStage sources encodedChunks + variableStats and mirror
  // it here (computeEncodedStage output + typed-stage stats).
  // Simplest faithful approach: call the exported stage functions directly,
  // exactly as tests/unit/engine/layout.equivalence.test.ts does.
  void result;
  throw new Error('replace with the stage-function pattern from layout.equivalence.test.ts');
}

const GROUP_KEYS: Record<string, string[]> = {
  schema: ['schema', 'type_assignments', 'logical_types'],
  layout: ['shape', 'chunk_shape', 'chunk_grid', 'chunk_order', 'partitioning', 'interleaving'],
  codecs: ['codec_pipelines'],
  chunkIndex: ['chunk_index'],
};

describe('collectMetadata group filtering', () => {
  it('all-on emits every key plus envelope + custom entries', () => {
    const entries = collectFor(stateWith({}));
    const keys = entries.map((e) => e.key);
    for (const k of ['schema', 'shape', 'codec_pipelines', 'metadata_format', 'byte_order', 'author']) {
      expect(keys).toContain(k);
    }
  });

  for (const [group, keys] of Object.entries(GROUP_KEYS)) {
    it(`${group} off omits exactly its keys`, () => {
      const off = collectFor(stateWith({ [group]: false } as never)).map((e) => e.key);
      const on = collectFor(stateWith({})).map((e) => e.key);
      for (const k of keys) expect(off).not.toContain(k);
      // nothing else disappears:
      expect(on.filter((k) => !keys.includes(k)).every((k) => off.includes(k))).toBe(true);
    });
  }

  it('descriptive off omits variable_statistics AND custom entries', () => {
    const off = collectFor(stateWith({ descriptive: false })).map((e) => e.key);
    expect(off).not.toContain('variable_statistics');
    expect(off).not.toContain('author');
  });

  it('envelope keys are always present regardless of toggles', () => {
    const allOff = collectFor(stateWith({ schema: false, layout: false, codecs: false, chunkIndex: false, descriptive: false }));
    const keys = allOff.map((e) => e.key);
    expect(keys).toContain('metadata_format');
    expect(keys).toContain('byte_order');
  });

  it('METADATA_KEY_GROUPS covers every non-envelope auto key collectMetadata emits', () => {
    const keys = collectFor(stateWith({})).map((e) => e.key);
    const envelope = new Set(['metadata_format', 'byte_order']);
    for (const k of keys) {
      if (envelope.has(k) || k === 'author') continue;
      expect(METADATA_KEY_GROUPS[k], `unmapped auto key: ${k}`).toBeDefined();
    }
  });
});
```

Migration tests (same or separate file):

```typescript
// legacy shape loads: metadata.includeChunkIndex: false → include.chunkIndex false, others true
// legacy shape loads: includeChunkIndex absent → all five true
// modern shape roundtrips unchanged
// use validateExternalState (src/state/persistence.ts) on hand-built JSON objects
// derived from DEFAULT_STATE with metadata.include deleted and includeChunkIndex set.
```

Write these as real assertions (build the raw object via JSON.parse(JSON.stringify(DEFAULT_STATE)), delete/patch fields, call `validateExternalState`).

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/unit/engine/metadataGroups.test.ts` → FAIL (`include` not in state; `METADATA_KEY_GROUPS` not exported). Fix the `collectFor` helper against the real stage-function pattern while here.

- [ ] **Step 3: Implement**
  - `state.ts`: add `MetadataIncludeConfig` + replace `includeChunkIndex` with `include` (DEFAULT_STATE all-true). Fix ALL compile fallout: grep `includeChunkIndex` across src/ and tests/ — consumers (metadata.ts:47ish gate, WriteConfig/MetadataEditor UI, any tests) switch to `metadata.include.chunkIndex`.
  - `persistence.ts` `migrateState`: when `raw.metadata` exists without `include`, synthesize `include` from defaults and, if legacy `includeChunkIndex === false`, set `include.chunkIndex = false`; delete the legacy key. The default-merge path then fills anything else.
  - `metadata.ts`: export `METADATA_KEY_GROUPS`; gate each auto `entries.push` on `state.metadata.include[group]` (inline gating at the existing push sites — the file is sequential and readable that way; do NOT build-then-filter, which would run chunk-offset computation for a group that's off). Custom entries + `variable_statistics` gate on `include.descriptive`. Envelope keys unconditional.
- [ ] **Step 4: Run** — new tests + full `npx vitest run` green; `npm run build` clean.
- [ ] **Step 5: Commit** — `git add -A src tests && git commit -m "feat: five-group metadata include config with migration (read plan Task 1)"`

### Task 2: Step-log engine — recorder, types, existing-reason mapping

**Files:**
- Modify: `src/types/pipeline.ts` (ReadStep types; `steps` on ReadSuccess/ReadFailure)
- Modify: `src/engine/read.ts` (readFile:65-128, makeFailure:359, reconstruct:236 threading)
- Test: `tests/unit/engine/readSteps.test.ts` (new)

**Interfaces:**
- Consumes: Task 1's state shape (tests build partial-metadata files via it).
- Produces (exact, spec §1):

```typescript
// src/types/pipeline.ts
export type ReadStepId =
  | 'verify-magic' | 'locate-metadata' | 'parse-metadata' | 'read-schema'
  | 'read-layout' | 'locate-chunks' | 'decode-chunks' | 'reassemble';
export interface ReadStep {
  id: ReadStepId; label: string; needed: string; found: string;
  outcome: 'ok' | 'failed' | 'skipped'; detail?: string;
}
// ReadSuccess and ReadFailure each gain: steps: ReadStep[];

// src/engine/read.ts
export const READ_STEP_ORDER: { id: ReadStepId; label: string; needed: string }[]; // 8 entries, display copy
interface StepRecorder {
  ok(id: ReadStepId, found: string, detail?: string): void;
  fail(id: ReadStepId, found: string, detail: string): ReadStep[]; // marks failed, fills the rest 'skipped', returns steps
  finish(): ReadStep[];  // all recorded; asserts all 8 covered (dev-time invariant)
}
function createStepRecorder(): StepRecorder;
```

- [ ] **Step 1: Write the failing tests.** Build states via Task 1's helpers and the write pipeline (`computeFilesStage` etc. — copy the file-building pattern from the existing read tests: grep `readFile` under `tests/unit/engine/` and reuse their fixture style). Cases:
  - success (default state, includeMetadata on): `steps.length === 8`, all `outcome: 'ok'`, ids in READ_STEP_ORDER order.
  - `bad-magic` (corrupt first byte): steps[0] failed, steps[1..7] skipped, `steps[0].detail === result.message`.
  - `no-metadata` (master off): verify-magic ok, locate-metadata failed, rest skipped.
  - `metadata-not-found` (footer + footerLocator 'none' + binary — the D1 scan-miss config; copy from existing read tests if one exists): locate-metadata failed.
  - `corrupt-metadata`: locate ok, parse failed. (Corrupt the metadata bytes in the assembled file the way existing tests do; if none does, flip a byte inside the JSON blob.)
  - `no-chunk-index` (D3 config: single file, entropy codec, chunkIndex off): fails at locate-chunks with prior steps ok. NOTE: with Task 1 only, schema/layout groups are on — this must reach locate-chunks.
  - `decode-error` (existing reassembly failure case from current tests): fails at decode-chunks or reassemble; assert the failed step's id is one of the two and prior steps ok.
  - Both success AND failure results carry steps (type-level: no optionality).
- [ ] **Step 2: Run to verify failure** — `steps` missing from results.
- [ ] **Step 3: Implement.**
  - Types per the interface block.
  - `createStepRecorder` + `READ_STEP_ORDER` (labels/needed copy in the established educational voice — read FAILURE_MESSAGES:315 first).
  - Thread through `readFile`: record `verify-magic` after the magic check (found: the actual leading bytes as hex vs expected); `locate-metadata` after `locateMetadata` (found: "header at offset 0" / "trailer-located footer at N" / "sidecar file <name>" / what the scan concluded); `parse-metadata` after entries parse (found: "N entries, json|binary"). `read-schema`/`read-layout`: recorded as `ok` in this task right after parse (presence checks split out in Task 3 — until then parseStructure's combined throw still maps to `corrupt-metadata`; the test list above deliberately avoids missing-field configs). Thread the recorder into `reconstruct` (parameter): mark `locate-chunks` ok once chunk readers resolve (or fail on NoChunkIndexError), `decode-chunks` ok after codec reversal completes across chunks, `reassemble` ok at the end.
  - `makeFailure` gains a `steps` parameter; every call site passes `recorder.fail(...)` output. The failed step's `detail` is the reason's message (single source: compute the message first, use it for both).
- [ ] **Step 4: Run** — new tests + full suite green; build clean.
- [ ] **Step 5: Commit** — `git add -A src tests && git commit -m "feat: readFile narrates an 8-step log (read plan Task 2)"`

### Task 3: Granular reader semantics — missing-schema/missing-layout + assume-identity

**Files:**
- Modify: `src/engine/read.ts` (parseStructure:189-235, FAILURE_MESSAGES:315, reconstruct byte-count check), `src/types/pipeline.ts` (two new ReadFailureReason values)
- Test: `tests/unit/engine/readSteps.test.ts` (extend), `tests/unit/engine/readGranular.test.ts` (new — the toggle matrix)

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: `ReadFailureReason` gains `'missing-schema' | 'missing-layout'`; `ParsedStructure` gains `codecInfoPresent: boolean`.

- [ ] **Step 1: SPIKE (recorded in the report, not committed as behavior):** confirm what `parseStructure` does today when `codec_pipelines` is absent (line 196 area — expected: defaults to empty pipelines, i.e. latent assume-identity) and whether any byte-count validation exists between chunk bytes and layout expectations in `reconstruct`/`scatterChunkValues`. State both findings in the report; they determine how much of Step 3 is new code vs. making latent behavior explicit.
- [ ] **Step 2: Write the failing tests** (`readGranular.test.ts`), building files via Task 1's include toggles:
  - schema off → `reason: 'missing-schema'`, step `read-schema` failed, `read-layout`+ skipped; message mentions variables/types (educational voice).
  - layout off → `'missing-layout'`, `read-layout` failed. (schema on so read-schema is ok first.)
  - schema AND layout off → fails at `read-schema` (first check wins).
  - codecs off × three pipeline realities:
    - (a) no codecs configured → `success: true`, decode-chunks `ok` with detail containing "no codec info";
    - (b) delta or byte-shuffle configured (non-size-changing) → `success: true` AND reconstructed values differ from the originals (assert at least one differing value vs `computePipelineStages(state).logicalValues`) — the garbled-success case; decode-chunks detail notes assumed raw bytes;
    - (c) rle configured (size-changing) → `success: false`, `reason: 'decode-error'`, failed step `decode-chunks`, detail contains expected vs actual byte counts.
  - chunkIndex off, entropy codec, single file → unchanged D3 `no-chunk-index` (regression pin).
  - descriptive off → `success: true`, 8× ok; the read-schema step's `found` mentions statistics/custom entries were absent and not needed.
  - Matrix breadth: run the schema-off and codecs-off(b) cases across {json, binary} × {header, sidecar} at least (placement × serialization spot coverage; the full placement matrix lives in the scenario suite).
- [ ] **Step 3: Run to verify failure**, then implement:
  - Split presence checks out of `parseStructure`'s combined throw: check schema-group keys first (`schema`, `type_assignments` — treat `logical_types` as optional-descriptive-adjacent if the reader doesn't consume it; check what parseStructure actually reads and gate on exactly those), throw typed `MissingSchemaError`; then layout-group keys (`shape`, `chunk_shape`; `interleaving` already defaults — keep that default, it predates this work), throw `MissingLayoutError`. readFile maps them to the new reasons at the read-schema/read-layout steps. Genuinely-corrupt parses (bad JSON in a present key) stay `corrupt-metadata`.
  - `codecInfoPresent` on ParsedStructure; decode step detail per spec §3 (three variants). Add the byte-count check if the spike found none: before scattering, expected bytes per chunk = elementCount × dtype size (per geometry + schema); mismatch → error with both numbers → `decode-error` at decode-chunks.
  - Two new `FAILURE_MESSAGES` entries (spec §1 has the missing-schema draft; write missing-layout to match).
- [ ] **Step 4: Run** — new + full suite green (note: `scenario-placement-matrix.mjs` gets re-run in Task 6; unit green suffices here); build clean.
- [ ] **Step 5: Commit** — `git add -A src tests && git commit -m "feat: granular read failures + assume-identity codec semantics (read plan Task 3)"`

### Task 4: ReadProcessView + Process view mode + failure replacement

**Files:**
- Create: `src/components/viewers/ReadProcessView.tsx`
- Modify: `src/components/viewers/StagePane.tsx` (failure block ~188-205; view-mode radio source — grep `view-mode-` to find where modes are enumerated)
- Test: `tests/unit/components/readProcessView.test.tsx` (follow `aboutModal.test.tsx`'s environment/setup idiom)

**Interfaces:**
- Consumes: `readResult.steps` (Tasks 2–3), theme tokens, testid conventions.
- Produces: `<ReadProcessView steps={ReadStep[]} />`; testids `read-process-view`, `read-step-{id}`; view mode `process` (radio testid `view-mode-process` via the existing convention) available ONLY when the pane's stage is Read.

- [ ] **Step 1: Write the failing component test:** render ReadProcessView with (a) 8×ok steps — all rows render with ✓ and needed/found text; (b) a failed-at-decode-chunks fixture — rows 0-5 ✓, row 6 ✗ with its `detail` visible, row 7 marked skipped (–, muted); assert testids `read-step-verify-magic` … exist.
- [ ] **Step 2: Run to verify failure**, then implement the component: header row ("What the reader did"), one row per step (icon / label / needed → found), failed row expanded with detail in the failure styling idiom (`colors.warningDim` background block like CodecSection's banner), skipped rows muted (`colors.textTertiary`). Inline styles from theme.ts only.
- [ ] **Step 3: Wire into StagePane:** (a) add `process` to the view-mode options ONLY when the selected stage is Read (find the mode-list source; other stages must not show it — and a persisted `process` selection on a non-Read stage must fall back gracefully to the pane default, check how view-mode state is stored/validated); (b) when Read is selected AND `!readResult.success`, render `<ReadProcessView steps={readResult.steps} />` in place of the current message block (~188-205) regardless of mode; (c) when Read is selected AND mode is `process`, render it too (success case). No auto-switching.
- [ ] **Step 4: Verify** — vitest green; build clean; quick probe: dev server, select Read stage, toggle `include-metadata-toggle` off → checklist shows locate-metadata failed (screenshot in report); toggle back on → switch to Process mode → 8 ✓ rows. Kill server.
- [ ] **Step 5: Commit** — `git add -A src tests && git commit -m "feat: read-process checklist view (read plan Task 4)"`

### Task 5: Metadata section toggles UI

**Files:**
- Modify: `src/components/config/MetadataEditor.tsx` (READ IT FIRST — it holds the existing chunk-index toggle with testid `include-chunk-index-toggle`)
- Test: `tests/unit/components/metadataToggles.test.tsx`

**Interfaces:**
- Consumes: Task 1's `metadata.include`; the app-state dispatch pattern MetadataEditor already uses (find its action type in src/state/useAppState.ts — likely a SET_METADATA-style action; extend or reuse, matching the reducer's idiom).
- Produces: five toggle rows, testids `include-schema-toggle`, `include-layout-toggle`, `include-codecs-toggle`, `include-chunk-index-toggle` (existing id preserved, now driving `include.chunkIndex`), `include-descriptive-toggle`; each row has a one-line consequence hint ("without this, the reader stops at: read schema" / layout / decode chunks / "…locate chunks (single-file entropy configs)" / "nothing — the reader doesn't need it"); all five disabled with a "metadata is not being written" note when `write.includeMetadata` is false.

- [ ] **Step 1: Failing component test:** render with include-metadata on: five toggles present, enabled, checked per state; flip schema toggle → dispatch observed (assert via state change through the real provider, mirroring how existing config-component tests assert edits — grep tests/unit/components/ for a config-section test to copy the harness from; if none exists, use the aboutModal provider idiom and assert on the rendered checked state after a click). Render with `write.includeMetadata: false`: all five disabled + note visible.
- [ ] **Step 2: Run to verify failure**, implement per the existing MetadataEditor idiom (the chunk-index toggle row is the template — replicate its row structure five times with a small map, don't copy-paste five blocks).
- [ ] **Step 3: Run** — vitest green; build clean.
- [ ] **Step 4: Commit** — `git add -A src tests && git commit -m "feat: five metadata group toggles with consequence hints (read plan Task 5)"`

### Task 6: ReadStatus progress line, guide sentence, docs

**Files:**
- Modify: `src/components/config/ReadStatus.tsx`, `src/components/guide/steps.ts` (Read step's text), `docs/extension-read-step.md` (addendum section), `CLAUDE.md` (testids + the metadata-toggle description line if it names includeChunkIndex semantics)
- Test: `tests/unit/components/readStatus.test.tsx` (extend if exists, else create minimal)

- [ ] **Step 1:** ReadStatus gains the progress line above the existing message: success `"8/8 steps"`, failure `"N/8 steps · failed at: {label}"` (N = ok count). Testid `read-status-progress`. Component test with an ok fixture and a failed fixture.
- [ ] **Step 2:** Guide `steps.ts` Read step: one added sentence pointing at the group toggles and the Process view (match the file's teaching-text voice; it's data, no React).
- [ ] **Step 3:** `docs/extension-read-step.md`: a short "Step log and granular metadata (2026-07)" addendum — the 8 steps, the five groups, assume-identity semantics, two new failure reasons. Accurate, not aspirational. CLAUDE.md: add `read-process-view`, `read-step-{id}`, `read-status-progress`, the four new toggle testids to the list (existing style).
- [ ] **Step 4:** vitest green; build clean. Commit — `git add -A src tests docs CLAUDE.md && git commit -m "feat: read progress line, guide + docs for step log (read plan Task 6)"`

### Task 7: Scenario + full verification

**Files:**
- Create: `tests/ui/scenario-read-process.mjs`
- Modify: `CLAUDE.md` (scenario list)

- [ ] **Step 1: Write the scenario** on `scenario-helpers.mjs` (launch, seedStateAndReload, waitForPipelineIdle, check harness). Coverage, each with concrete assertions:
  - default state + includeMetadata ON: select Read stage, switch to Process mode (`view-mode-process`), assert 8 `read-step-*` rows all ✓ and `read-status-progress` shows "8/8".
  - master toggle OFF (`include-metadata-toggle`): checklist replaces the pane content in ANY mode; `read-step-locate-metadata` shows failed; progress line "1/8 … locate metadata".
  - `include-schema-toggle` off (master on): failed at `read-step-read-schema`, message text mentions variables/types.
  - `include-layout-toggle` off: failed at `read-step-read-layout`.
  - garbled-success: seed a state with a byte-shuffle codec on one variable, then turn `include-codecs-toggle` off: read SUCCEEDS (pipeline strip Read node ✓), Process view decode-chunks row shows the assumed-raw detail, and enabling the diff view (`show-diff` control — grep its testid) reports differences.
  - rle + codecs off: failed at `read-step-decode-chunks` with byte-count text.
  - `include-descriptive-toggle` off: 8/8 success.
- [ ] **Step 2: Run it** against the dev server → all PASS; then ALL standing scenarios (per CLAUDE.md's list, including scenario-placement-matrix — the migration/compat proof) → green; `npx vitest run` green; `npm run build` clean. Kill servers.
- [ ] **Step 3:** CLAUDE.md scenario list gains the new file (matching style).
- [ ] **Step 4: Commit** — `git add tests/ui/scenario-read-process.mjs CLAUDE.md && git commit -m "test: read-process + granular metadata scenario (read plan Task 7)"`
