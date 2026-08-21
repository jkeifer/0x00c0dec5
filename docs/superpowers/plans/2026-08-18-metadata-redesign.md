# Metadata Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make metadata the discovery arc of the tool: default-off assembly with a per-group ladder, override-wins custom entries, a truly binary tag serialization, a key/value Entries view, per-chunk/no-index and chunk-order reader fixes, and geo/attribution seeding from curated sources.

**Architecture:** `MetadataEntry { key, value: string }` stays the universal interchange; a new per-key binary spec table converts value strings ↔ typed payloads at the serialization boundary only, so `parseStructure` and all consumers are untouched. The metadata master switch moves from `write.includeMetadata` to `metadata.enabled`; Write gains placement `'omit'`. The reader starts consuming `partitioning` and `chunk_order` from metadata.

**Tech Stack:** React + TypeScript + Vite, vitest (`npx vitest run`), Playwright scenarios (`node tests/ui/scenario-*.mjs` against `npm run dev`).

**Spec:** `docs/superpowers/specs/2026-08-18-metadata-redesign-design.md` — read it first; it argues every decision here.

## Global Constraints

- **NEVER commit anything under `docs/superpowers/`** (spec + this plan stay uncommitted). Implementation commits are per-task and must not `git add` those paths.
- Unit tests live in `tests/unit/` (never beside `src/`).
- Drop-migrations policy: old persisted states/share links with the removed shape return `null` from `migrateState` — no field conversion.
- Inline styles from `src/theme.ts` only; no CSS libs.
- Components never call `src/engine/` compute directly (CLAUDE.md pitfall 8) — new pane data rides the worker payload.
- Keep `data-testid` conventions from CLAUDE.md; new ids listed per task.
- Binary metadata framing is fixed little-endian everywhere (a format constant, like TIFF's `II`); only chunk data follows `state.byteOrder`.
- After each task: `npx vitest run` must be green before commit.
- Suggested models: Task 5, 6, 7 → opus; all others → sonnet. Never fable.

---

### Task 1: State shape — `metadata.enabled`, placement `'omit'`, default-off include groups, persistence drop, presets, test sweep

**Files:**
- Modify: `src/types/state.ts` (AppState types + `DEFAULT_STATE`)
- Modify: `src/state/persistence.ts` (`migrateState`, any placement/metadata validators)
- Modify: `src/state/useAppState.ts` (`UPDATE_METADATA_CONFIG` action type; remove `includeMetadata` handling from `UPDATE_WRITE` typing if enumerated)
- Modify: `src/presets/parquet-adjacent.json`, `src/presets/geotiffesque.json`, `src/presets/zarrish.json`, `src/presets/avroesque.json`
- Modify (mechanical sweep): every file `grep -rln includeMetadata src tests --include='*.ts*'` returns EXCEPT `src/engine/write.ts`, `src/engine/pipelineCompute.ts`, `src/components/**` (those are Tasks 3 and 8; leave them compiling by keeping reads guarded — see Step 4)
- Test: `tests/unit/state/persistence.test.ts`

**Interfaces:**
- Produces: `AppState['metadata']` gains `enabled: boolean` (DEFAULT false). `AppState['write']['metadataPlacement']` type becomes `'header' | 'footer' | 'sidecar' | 'omit'`. `write.includeMetadata` deleted from the type. `MetadataIncludeConfig` defaults all `false`. `UPDATE_METADATA_CONFIG`'s `changes` becomes `Partial<Pick<AppState['metadata'], 'serialization' | 'include' | 'enabled'>>`.
- Later tasks rely on: `state.metadata.enabled`, placement `'omit'` being valid through persistence/share validation.

- [ ] **Step 1: Write failing persistence tests** in `tests/unit/state/persistence.test.ts` (follow the file's existing helpers for building raw saved payloads):

```ts
it('drops saves carrying the removed write.includeMetadata field', () => {
  const raw = JSON.parse(JSON.stringify(DEFAULT_STATE)) as Record<string, any>;
  raw.write.includeMetadata = true; // old shape
  expect(loadStateFromRaw(JSON.stringify(raw))).toBeNull(); // use the file's actual load/validate entry point
});

it('round-trips metadata.enabled and placement omit', () => {
  const s = structuredClone(DEFAULT_STATE);
  s.metadata.enabled = true;
  s.write.metadataPlacement = 'omit';
  // save → load via the file's actual persistence helpers; expect fields preserved
});

it('defaults: metadata disabled, all include groups off', () => {
  expect(DEFAULT_STATE.metadata.enabled).toBe(false);
  expect(Object.values(DEFAULT_STATE.metadata.include).every((v) => v === false)).toBe(true);
});
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/state/persistence.test.ts` — new tests FAIL (field doesn't exist / no drop rule).

- [ ] **Step 3: Implement type + defaults + reducer typing.** In `src/types/state.ts`: add `enabled: boolean;` to the `metadata` object type (documented as the assembly master switch — off means the Metadata stage is zero-length, overriding every include group and the envelope key); delete `includeMetadata: boolean;` from `write`; widen `metadataPlacement`; set `DEFAULT_STATE.metadata.enabled = false`, `DEFAULT_STATE.metadata.include` all `false`, and delete `includeMetadata: false` from `DEFAULT_STATE.write`. In `src/state/useAppState.ts` extend the `UPDATE_METADATA_CONFIG` Pick.

- [ ] **Step 4: Persistence drop + validation.** In `migrateState` (`src/state/persistence.ts`), before other handling: if `raw.write` is a plain object containing an `includeMetadata` key → `return null` (comment: metadata master switch moved to `metadata.enabled`; drop, don't migrate). Grep the file for `metadataPlacement` / include-config validation and make `'omit'` and `metadata.enabled` validate; `deepMergeDefaults` supplies `enabled: false` for absent keys automatically.

- [ ] **Step 5: Presets.** In all four preset JSONs: delete `"includeMetadata": true` from `write`, add `"enabled": true` inside `metadata`. (Spatial seed entries land in Task 11.)

- [ ] **Step 6: Mechanical sweep.** `grep -rn includeMetadata src tests --include='*.ts*'`. For every **test** hit: replace state construction `write: { ...includeMetadata: true }` with `metadata: { ...enabled: true }` (most tests build full states via spread of `DEFAULT_STATE` — they now also need `include` groups on where the test expects metadata written: use `include: { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true, endianness: true }`). Add a shared helper if one place is imported by many tests (check `tests/unit/helpers/`). For `src/engine/write.ts` / `src/engine/pipelineCompute.ts` / components: **temporary shim only** — replace reads of `state.write.includeMetadata` with `state.metadata.enabled` verbatim (Task 3 gives them real semantics). `src/types/pipeline.ts` comment mentioning includeMetadata: update wording.

- [ ] **Step 7: Run** `npx vitest run` — full suite green. Fix stragglers (expect many default-state read tests to now need `enabled/include` set — that's the point of the new defaults).

- [ ] **Step 8: Commit** `feat(state): metadata.enabled master switch, placement omit, default-off include groups`

---

### Task 2: Assembly — override-wins, delete `chunk_grid`, ungate custom entries

**Files:**
- Modify: `src/engine/metadata.ts`
- Modify: `src/components/config/MetadataEditor.tsx` (only the `customKeyInfo` compile fix — full rework is Task 8)
- Test: `tests/unit/engine/metadata.test.ts` (or wherever `collectMetadata`/`dedupeCustomKey` tests live — grep `dedupeCustomKey tests/`), `tests/unit/engine/metadata-adversarial.test.ts`

**Interfaces:**
- Produces: `collectMetadata` (same signature) with new semantics: no `chunk_grid` entry ever; custom entries written whenever called (no `include.descriptive` gate on them; `descriptive` gates only `variable_statistics`); a custom entry whose key matches an earlier entry **replaces that entry's value in place** (position preserved); duplicate custom keys → last wins. `dedupeCustomKey` deleted (no export). New export: `overriddenAutoKeys(state: AppState): Set<string>` — the auto keys the current custom entries would override (for UI notes; pure, no serialization).
- Consumes: Task 1's `metadata.enabled` (collectMetadata itself does NOT check `enabled` — callers do; keep it pure).

- [ ] **Step 1: Write failing tests:**

```ts
it('custom entry overrides auto entry in place', () => {
  const state = mkState({ customEntries: [{ key: 'shape', value: '[999]' }] }); // helper: enabled + all groups on
  const entries = collectMetadata(state, [], undefined, undefined);
  const shapeEntries = entries.filter((e) => e.key === 'shape');
  expect(shapeEntries).toHaveLength(1);
  expect(shapeEntries[0].value).toBe('[999]');
  // position preserved: 'shape' still appears before 'chunk_shape'
  expect(entries.findIndex((e) => e.key === 'shape')).toBeLessThan(entries.findIndex((e) => e.key === 'chunk_shape'));
});

it('no chunk_grid entry is ever written', () => {
  expect(collectMetadata(mkState({}), [], undefined, undefined).some((e) => e.key === 'chunk_grid')).toBe(false);
});

it('custom entries are written even with descriptive off; stats are not', () => {
  const state = mkState({ include: { ...allOn, descriptive: false }, customEntries: [{ key: 'crs', value: 'EPSG:4326' }] });
  const entries = collectMetadata(state, [], someStatsMap, undefined);
  expect(entries.some((e) => e.key === 'crs')).toBe(true);
  expect(entries.some((e) => e.key === 'variable_statistics')).toBe(false);
});

it('duplicate custom keys: last wins', () => { /* two customEntries keyed 'a' → one entry, second value */ });
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement in `collectMetadata`:** delete the `chunk_grid` push and its `METADATA_KEY_GROUPS` row; move the custom-entries loop out of `if (include.descriptive)`; replace the DC-5 block with:

```ts
// Custom entries: override-wins (spec §2). A custom key matching an existing
// entry replaces its value in place — users can lie to the reader; the include
// toggles already let them starve it. Duplicate custom keys: last wins.
for (const entry of state.metadata.customEntries) {
  if (!entry.key) continue;
  const existing = entries.find((e) => e.key === entry.key);
  if (existing) existing.value = entry.value;
  else entries.push({ key: entry.key, value: entry.value });
}
```

Delete `dedupeCustomKey`. Add:

```ts
/** Auto keys the current custom entries would override — UI note only. */
export function overriddenAutoKeys(state: AppState): Set<string> {
  const autoKeys = new Set(Object.keys(METADATA_KEY_GROUPS));
  autoKeys.add('metadata_format');
  return new Set(state.metadata.customEntries.map((e) => e.key).filter((k) => autoKeys.has(k)));
}
```

In `MetadataEditor.tsx`, minimal compile fix: replace the `dedupeCustomKey` import/use — `customKeyInfo` becomes `{ overrides: autoEntries.some((a) => a.key === entry.key) }` and the warning text "key collides… will be written as…" becomes "overrides auto-collected {key}" (keep the existing testid until Task 8 renames it).

- [ ] **Step 4: Sweep dependents.** Grep `chunk_grid` and `dedupeCustomKey` across `src tests docs/design.md` — update reader-side mentions (`read.ts`'s `describeSchemaFound` knownKeys derives from `METADATA_KEY_GROUPS`, so it self-updates; check tests pinning entry counts/keys, e.g. `metadata-adversarial`, `readGranular`, `pipeline.integration`).

- [ ] **Step 5: Run full suite — green. Commit** `feat(metadata): override-wins custom entries, drop chunk_grid, descriptive gates stats only`

---

### Task 3: Write path — `enabled` short-circuit + placement `'omit'`

**Files:**
- Modify: `src/engine/write.ts`, `src/engine/pipelineCompute.ts`
- Test: `tests/unit/engine/write.test.ts`

**Interfaces:**
- Produces: `computeMetadataStage` returns a zero-length-bytes stage when `!state.metadata.enabled`. `assembleFiles`: `enabled: false` → identical output to old `includeMetadata: false`; placement `'omit'` → metadata assembled nowhere in any file (no header/footer/trailer bytes, no sidecar) but chunk layout/offsets identical to the sidecar case (chunks start right after leading magic).
- Consumes: Task 1 fields; Task 2 `collectMetadata`.

- [ ] **Step 1: Failing tests:**

```ts
it('metadata disabled → Metadata stage bytes are zero-length', () => {
  const r = computeMetadataStage({ ...state, metadata: { ...state.metadata, enabled: false } }, [], new Map());
  expect(r.stage.bytes.length).toBe(0);
});

it('placement omit writes no metadata anywhere but chunks are intact', () => {
  const files = assembleFiles(mkState({ enabled: true, placement: 'omit' }), chunks, grid, stats, layout);
  expect(files.some((f) => f.name === 'metadata')).toBe(false);
  // total bytes = magic + chunks + magic exactly; and readFile fails 'no-metadata'
  const read = readFile(files, { magic });
  expect(read.success).toBe(false);
  expect(read.failureReason).toBe('no-metadata'); // use the actual ReadFileResult failure field name from types/pipeline.ts
});
```

- [ ] **Step 2: Run — FAIL. Step 3: Implement.** `pipelineCompute.computeMetadataStage`: `if (!state.metadata.enabled) return { stage: makeStage('Metadata', new Uint8Array(0), buildMetadataLayout(0)) };`. `write.ts`: the Task-1 shim already maps the old `includeMetadata === false` branch to `!state.metadata.enabled`; now add `placement === 'omit'` to take the same no-metadata assembly path as disabled (metadata bytes computed but discarded is unnecessary — just don't compute; the Metadata *stage* still shows bytes because `computeMetadataStage` is separate). Check every `collectMetadata` call site in write.ts (lines ~123–366): header/footer/trailer/sidecar paths all skip when disabled or omitted.

- [ ] **Step 4: Run full suite — green. Commit** `feat(write): metadata enabled short-circuit and placement omit`

---

### Task 4: Reader parses `partitioning` + `chunk_order`

**Files:**
- Modify: `src/engine/read.ts` (`ParsedStructure`, `parseStructure`)
- Test: `tests/unit/engine/read.test.ts`

**Interfaces:**
- Produces: `ParsedStructure` gains `partitioning: 'single' | 'per-chunk'` (default `'single'` when key absent) and `chunkOrder: 'row-major' | 'column-major'` (default `'row-major'`). Unknown string values → the default (mirror the existing `linearization` guard pattern).
- Later tasks rely on exactly these field names: `structure.partitioning`, `structure.chunkOrder`.

- [ ] **Step 1: Failing tests:** `parseStructure(entriesWith({ partitioning: 'per-chunk', chunk_order: 'column-major' }))` → fields set; absent keys → defaults; garbage values (`'banana'`) → defaults.
- [ ] **Step 2: Run — FAIL. Step 3: Implement** (copy the `linearization` allow-list guard pattern at read.ts:244-248).
- [ ] **Step 4: Run — green. Commit** `feat(read): parse partitioning and chunk_order from metadata`

---

### Task 5 (opus): Synthetic chunk index — per-chunk needs no index; single-file honors chunk order; reader selection by partitioning

**Files:**
- Modify: `src/engine/readReassemble.ts` (`resolveChunkIndex`), `src/engine/read.ts` (`reconstruct`'s reader selection + `resolveChunkIndex` call)
- Test: `tests/unit/engine/read.test.ts`, `tests/unit/engine/readGranular.test.ts`

**Interfaces:**
- Consumes: Task 4's `structure.partitioning` / `structure.chunkOrder`.
- Produces: `resolveChunkIndex(chunkIndex, ctx, magicLength)` where `ctx` additionally carries `partitioning` and `chunkOrder` (extend the existing `Omit<ReassemblyContext,...>` param type accordingly, adding the two fields). Behavior:
  - real index present → returned unchanged (as today);
  - `partitioning === 'per-chunk'` → coords-only entries `{ coords, offset: 0, size: 0, variableName? }` for every chunk × variable (column) or chunk (row), **no `hasSizeChangingCodec` check**;
  - single-file → existing size-derivation logic, but coords enumerated in `chunkOrder` order (`column-major` = last dimension varies slowest… verify against how `write.ts` orders chunks for `chunkOrder: 'column-major'` — the synthetic order MUST match the written order; read `orderChunks`/equivalent in write.ts first and reuse/mirror it), `NoChunkIndexError` still thrown for entropy codecs.
- `reconstruct` (read.ts): `getChunkBytes` selection becomes `structure.partitioning === 'per-chunk' ? makePerChunkFileReader(...) : makeSingleFileChunkReader(...)`; when the partitioning key was absent from metadata fall back to the old `dataFiles.length === 1` heuristic (track presence — simplest: make `parseStructure` also expose `partitioningRecorded: boolean`, mirroring `byteOrderRecorded`; add it in this task).

- [ ] **Step 1: Failing tests** (write real files via `assembleFiles`, then read them back — the roundtrip harness in `read.test.ts` / `roundtrip.matrix.test.ts` shows how):

```ts
it('per-chunk files + deflate-like size-changing codec + no chunk index: read succeeds', () => {
  // state: partitioning 'per-chunk', include.chunkIndex false, an rle/entropy codec on a variable,
  // metadata enabled + schema/layout/codecs groups on. assembleFiles → readFile → success, values equal.
});

it('single file + column-major chunk order + no chunk index: read reconstructs correctly', () => {
  // ≥2 chunks in each of 2 dims so order matters; size-preserving pipeline; include.chunkIndex false;
  // write.chunkOrder 'column-major'. Pre-fix this reassembles scrambled — assert exact values roundtrip.
});

it('single chunk, per-chunk partitioning: read succeeds (reader selection by partitioning)', () => {
  // shape == chunkShape → 1 chunk file; previously dataFiles.length===1 chose the single-file reader.
});

it('single file + entropy codec + no chunk index still fails no-chunk-index', () => { /* unchanged lesson */ });
```

- [ ] **Step 2: Run — the first three FAIL** (first throws `NoChunkIndexError`, second silently mismatches values, third mis-slices). Confirm the second actually fails pre-fix — if it passes, the write side isn't ordering chunks column-major in single-file mode; investigate `write.ts` chunk ordering before proceeding (do NOT skip: this is the silent-corruption bug the spec calls out).
- [ ] **Step 3: Implement** per the Interfaces block. Keep `makePerChunkFileReader`/`makeSingleFileChunkReader` unchanged.
- [ ] **Step 4: Run full suite — green. Commit** `fix(read): per-chunk files need no chunk index; synthetic index honors chunk_order; reader selection by partitioning`

---

### Task 6 (opus): Binary tag serialization — `src/engine/metadataBinary.ts`

**Files:**
- Create: `src/engine/metadataBinary.ts`
- Test: `tests/unit/engine/metadataBinary.test.ts`

**Interfaces (Produces — Task 7 consumes these exact names):**

```ts
export const METADATA_TAGS: Record<string, number>; // schema:1 shape:2 chunk_shape:3 chunk_order:4 partitioning:5 interleaving:6 linearization:7 codec_pipelines:8 chunk_index:9 type_assignments:10 logical_types:11 variable_statistics:12 metadata_format:13 byte_order:14
export const TYPE_STRING = 0; export const TYPE_U32_ARRAY = 1; export const TYPE_ENUM = 2;
export const TYPE_CHUNK_INDEX = 3; export const TYPE_SCHEMA = 4;
export interface BinaryDecodedEntry { key: string; value: string; tag: number; type: number; }
export function encodeMetadataBinary(entries: MetadataEntry[]): Uint8Array;
export function decodeMetadataBinary(bytes: Uint8Array): { entries: BinaryDecodedEntry[]; bytesConsumed: number };
```

Format (all integers little-endian): `[u16 count]` then per entry `[u16 tag][u8 type][u32 payloadLen][payload]`. Tag 0 = unregistered key; its payload is `[u16 keyLen][key utf8][value bytes]`, and `payloadLen` covers all of it. Registered tags: payload is the value bytes directly.

Per-key native encodings (fall back to `TYPE_STRING` whenever the value string doesn't parse/fit — the type byte is authoritative on decode; user lies must serialize):

- Enum keys → `TYPE_ENUM`, payload `[u8 code]`, tables (order is the spec — never reorder):
  `chunk_order: ['row-major','column-major']`, `partitioning: ['single','per-chunk']`, `interleaving: ['column','row']`, `linearization: ['c','fortran','morton']`, `byte_order: ['little','big']`, `metadata_format: ['json','binary']`.
- `shape`, `chunk_shape` → `TYPE_U32_ARRAY` (`JSON.parse` to number[]; every element integer in [0, 2^32) else string fallback), payload `[u32 × n]`.
- `chunk_index` → `TYPE_CHUNK_INDEX`: `[u8 ndim][u32 entryCount]` then per entry `[u32 × ndim coords][u32 offset][u32 size][u8 varNameLen][varName utf8]` (no variableName → len 0). Fallback to string if entries are non-uniform ndim, any number out of u32 range/non-integer, or a name > 255 UTF-8 bytes.
- `schema` → `TYPE_SCHEMA`: `[u16 varCount]` per var `[u8 nameLen][name utf8][u8 dtypeCode]`. Dtype code table: a hardcoded literal array of every `DtypeKey` (copy the exact key set from `src/types/dtypes.ts` — do not import-and-derive, stability is the point); index = code. Fallback to string on unknown dtype/oversize name.
- Everything else (incl. all custom values) → `TYPE_STRING` UTF-8.

Decode: `TYPE_ENUM` needs the key's table — resolve tag→key first; enum type on a tag-0/unknown-table key, out-of-range enum code, unknown tag, unknown type, or any truncation → **throw** (caller maps to corrupt). Re-stringify native types exactly as `collectMetadata` emits them: u32 array → `JSON.stringify(arr)`; chunk_index → `JSON.stringify` of objects built in key order `coords, offset, size` then `variableName` only when non-empty; schema → `JSON.stringify` of `{ name, dtype }` objects.

- [ ] **Step 1: Failing tests:**

```ts
it('round-trips every native type to identical value strings', () => {
  const entries = collectMetadata(fullyLoadedState, [], statsMap, realChunkIndex); // all groups on, column mode, custom entries
  const decoded = decodeMetadataBinary(encodeMetadataBinary(entries));
  expect(decoded.entries.map(({ key, value }) => ({ key, value }))).toEqual(entries);
});
it('reports bytesConsumed even with trailing garbage', () => {
  const buf = encodeMetadataBinary(entries);
  const padded = new Uint8Array([...buf, 1, 2, 3]);
  expect(decodeMetadataBinary(padded).bytesConsumed).toBe(buf.length);
});
it('lie fallback: enum key with non-enum value encodes as string and round-trips', () => {
  const decoded = decodeMetadataBinary(encodeMetadataBinary([{ key: 'interleaving', value: 'banana' }]));
  expect(decoded.entries[0]).toMatchObject({ key: 'interleaving', value: 'banana', type: TYPE_STRING });
});
it('custom keys use tag 0 and round-trip', () => { /* key 'crs' → tag 0, value preserved */ });
it('key names are absent from the bytes for registered tags', () => {
  const buf = encodeMetadataBinary([{ key: 'shape', value: '[16,16]' }]);
  expect(new TextDecoder().decode(buf).includes('shape')).toBe(false);
});
it('throws on truncation and unknown type codes', () => { /* slice buffer short; poke type byte to 250 */ });
it('every DtypeKey has a dtype code', () => { /* pin table length === Object.keys(DTYPES).length and round-trip each */ });
```

- [ ] **Step 2: Run — FAIL (module missing). Step 3: Implement** the module. Follow the existing `serializeMetadataBinary` byte-assembly idiom (parts array + final copy) and `DataView` for framing.
- [ ] **Step 4: Run — green. Commit** `feat(metadata): TIFF-flavored binary tag serialization`

---

### Task 7 (opus): Wire binary format into serialize/deserialize + locator scans

**Files:**
- Modify: `src/engine/metadata.ts` (`serializeMetadataBinary`/`deserializeMetadataBinary` replaced by delegation; delete the old implementations)
- Modify: `src/engine/readLocate.ts` (`scanBinaryForward`, `scanBinaryBackward`, `looksLikeBinaryMetadataHeader`, trailer plausibility)
- Modify: `src/engine/write.ts` (`convergeHeaderMetadata` comment/behavior check only)
- Test: `tests/unit/engine/metadata.test.ts`, `tests/unit/engine/readLocate` tests (grep for existing scan tests — likely in `read.test.ts`/`metadata-adversarial.test.ts`), `tests/unit/engine/roundtrip.matrix.test.ts`

**Interfaces:**
- Consumes: Task 6's `encodeMetadataBinary`/`decodeMetadataBinary`.
- Produces: `serializeMetadataBinary(entries)` → `encodeMetadataBinary(entries)`; `deserializeMetadataBinary(bytes)` → `decodeMetadataBinary(bytes).entries` mapped to `MetadataEntry`. `deserializeMetadata`'s `{`-sniff unchanged. No old-format back-compat (delete old code, update tests that pinned the old framing).

- [ ] **Step 1: Failing tests:** full write→read roundtrips with `serialization: 'binary'` across placements (header, footer+trailer, footer+none [expect the honest metadata-not-found failure], sidecar, per-chunk sidecar) — extend the existing placement-coverage tests rather than writing a parallel harness. Header placement binary: `locateMetadata` must return the correct `chunkDataStart` via `bytesConsumed`.
- [ ] **Step 2: Run — FAIL. Step 3: Implement.** `scanBinaryForward`: plausibility = `u16` count at `start` in 1..999; then `try { decodeMetadataBinary(dataBytes.slice(start)) }` → entries + `headerByteLength = start + bytesConsumed` (delete the re-serialize trick); parse failure with plausible count → `{ entries: null, plausible: true }`. `looksLikeBinaryMetadataHeader`: `u16` count in 1..999. `scanBinaryBackward`: same window scan, reading `u16` (not `u32`) count-shaped values. `convergeHeaderMetadata`: verify binary converges (chunk_index payload width is offset-value-independent — fixed u32s) and keep the whitespace-padding branch JSON-only; add a comment. Run the header-placement fixed-point assertion tests.
- [ ] **Step 4: Run full suite — green.** Expect to fix tests pinning old binary bytes (`metadata-adversarial`, endianness, linearization roundtrips). **Commit** `feat(metadata): binary format wired through locate/parse; scans walk tag framing`

---

### Task 8: Sidebar UI — MetadataEditor rework, WriteConfig omit

**Files:**
- Modify: `src/components/config/MetadataEditor.tsx`, `src/components/config/WriteConfig.tsx`, `src/components/layout/Sidebar.tsx`
- Test: `tests/unit/components/metadataToggles.test.tsx`

**Interfaces:**
- Consumes: Task 1 state fields; Task 2's `overriddenAutoKeys` (or the inline `autoEntries.some` equivalent already in place).
- Produces (testids — CLAUDE.md sync happens in Task 13): `metadata-enabled-toggle` (Radio yes/no, same pattern as include toggles); include toggles keep their testids but render **label only — the `hint` field and its render line are deleted**; `metadata-key-override-note-{i}` replaces `metadata-key-collision-warning-{i}`; WriteConfig placement select gains `<option value="omit">Omit</option>`; the Write "Include Metadata" Radio and its `onIncludeMetadataChange` prop are deleted; `include-metadata-toggle` testid ceases to exist.

- [ ] **Step 1: Failing component tests** in `metadataToggles.test.tsx` (follow its existing render harness): enabled-toggle renders and dispatches `UPDATE_METADATA_CONFIG {enabled}`; include toggles render no hint text (assert the old hint strings are absent); controls below the enable toggle have reduced opacity / disabled inputs when `enabled` is false; override note appears for a custom entry keyed `shape`; "+ Entry" button precedes the first custom row in DOM order.
- [ ] **Step 2: Run — FAIL. Step 3: Implement.** MetadataEditor new render order top→bottom: (1) Enable metadata Radio; (2) include-group rows (label + Radio only), `disabled={!metadata.enabled}`; (3) Auto-collected collapsible (unchanged, but returns `[]` fast when disabled); (4) `+ Entry` button then custom rows beneath it (button moves above; note style: `fontSizes.xs`, `colors.textTertiary` — informational, not warning; empty-key warning border stays); (5) serialization Radio (`disabled={!metadata.enabled}`); (6) size line — when disabled show `Serialized: 0 bytes`. Delete the "metadata is not being written — enable in Write" span. `metadataDisabled` variable now means `!metadata.enabled`. Sidebar: pass `enabled` + `onEnabledChange` (dispatch `UPDATE_METADATA_CONFIG`), drop the Write-toggle prop plumbing. WriteConfig: delete the Include Metadata Radio block + prop; add omit option; footer-locator stays footer-only; when placement is omit nothing else changes (partitioning still applies).
- [ ] **Step 4: Run suite — green. Step 5: Visual check** (dev server + a quick Playwright poke or screenshot per CLAUDE.md UI workflow; `seedStateAndReload` from `tests/ui/scenario-helpers.mjs` for state seeding — never evaluate+reload). **Commit** `feat(ui): metadata section owns its master switch; write placement gains omit; spoiler hints removed`

---

### Task 9: Entries view — worker payload + `MetadataEntriesView`

**Files:**
- Modify: `src/engine/pipelineCompute.ts` (`MetadataStageResult` + `computeMetadataStage`), `src/worker/pipeline.worker.ts` + `src/worker/client.ts` + `src/hooks/usePipeline.ts` + the pipeline context (follow how `codecWarnings`/`files` already flow worker→context — mirror that path exactly)
- Create: `src/components/viewers/MetadataEntriesView.tsx`
- Modify: `src/components/viewers/StagePane.tsx`
- Test: `tests/unit/engine/pipelineCompute` test file (grep for existing `computeMetadataStage` coverage), `tests/unit/hooks/usePipeline.test.ts`

**Interfaces:**
- Produces: `MetadataStageResult` gains `entries: MetadataDisplayEntry[]` where `interface MetadataDisplayEntry { key: string; value: string; tag: number | null; type: number | null }` (exported from `pipelineCompute.ts`). JSON mode: `tag`/`type` null. Binary mode: from `decodeMetadataBinary(metaBytes)` — parsed from the actual serialized bytes, not from `collectMetadata`'s output, so the view shows what the bytes say. Disabled: `[]`.
- StagePane: metadata stage view modes become `[{ value: 'entries', label: 'Entries' }, { value: 'hex', label: 'Hex' }, { value: 'flat', label: 'Flat' }]` (entries first = default via the existing first-mode fallback). New `isMetadataStage` branch renders `<MetadataEntriesView entries={...} enabled={...} />` for `effectiveView === 'entries'`.
- Testids: `metadata-entries-view` on the container; `metadata-entry-{key}` per row.

- [ ] **Step 1: Failing tests:** `computeMetadataStage` returns entries matching the serialized bytes in both formats (binary rows carry numeric tag/type; a custom key row has `tag: 0`); disabled → `[]` and zero bytes.
- [ ] **Step 2: Run — FAIL. Step 3: Implement compute + plumbing.** In `computeMetadataStage`: JSON → map `metaEntries`; binary → `decodeMetadataBinary(metaBytes).entries`. Thread through worker message/client/hook/context by copying the `codecWarnings` pattern.
- [ ] **Step 4: Implement the view.** Monospace table (inline styles from theme): columns key | tag·type (only when tag non-null; render as `tag 2 · u32[]` with a small type-name map) | value in a `<pre>`-styled span, `whiteSpace: 'pre-wrap'`, `maxHeight` ~6 lines with `overflow: auto`, long JSON values pretty-printed via `JSON.stringify(JSON.parse(v), null, 1)` inside try/catch (fall back to raw). Empty states: disabled → "metadata is disabled — nothing is assembled"; enabled but zero entries → "no entries". Wire into StagePane.
- [ ] **Step 5: Playwright check:** temp script or extend a scenario in Task 14 — select Metadata stage, expect `metadata-entries-view` visible by default, rows present in both serializations. Run suite — green. **Commit** `feat(ui): metadata Entries view parsed from stage bytes`

---

### Task 10: Manifests + registry seed data

**Files:**
- Modify: `src/datasets/types.ts` (manifest `spatial`), `src/datasets/registry.ts` (seed entries), `scripts/datasets/etopo-dem.ts`, `scripts/datasets/sst-field.ts` (emit `spatial` into their manifests for future runs), `scripts/datasets/gen-fixtures.ts` + `tests/fixtures/datasets/*/manifest.json`, `data-branch-work/datasets/{etopo-dem,sst-field}/manifest.json` (hand-edit — extraction can't be re-run offline)
- Test: `tests/unit/datasets/catalog.test.ts`, `tests/unit/datasets/fixtures.test.ts`

**Interfaces:**
- Produces: `DatasetManifest.spatial?: { crs: string; bbox: [number, number, number, number]; transform?: number[] }`. Registry export consumed by Task 11:

```ts
export const DATASET_SEED_ENTRIES: Record<DatasetId, { key: string; value: string }[]>;
```

Values (attribution keys/values copied VERBATIM from the corresponding preset JSON `customEntries` so seeds and presets can never disagree — that equality is pinned by test):
- `etopo-dem`: source/source_url/retrieved/license (from geotiffesque.json) + `crs: "EPSG:4326"`, `bbox: "[75, 20, 92.05, 37.05]"`, `transform: "[75, 0.0166667, 0, 37.05, 0, -0.0166667]"` (from script constants LAT0 20, LON0 75, STEP 1/60, SIZE 1024 → span 1023/60 = 17.05; verify against the script and adjust if constants differ).
- `sst-field`: attribution (zarrish.json) + `crs: "EPSG:4326"`, `bbox: "[-150, -5, -139.77, 5.23]"`, `transform: "[-150, 0.01, 0, 5.23, 0, -0.01]"`.
- `ghcn-daily`: attribution + `date_units`/`temperature_units`/`precipitation_units` (from parquet-adjacent.json). No spatial.

- [ ] **Step 1: Failing tests:** extend `catalog.test.ts` — for each dataset: seed attribution values strictly equal the fixture manifest's `attribution` fields; spatial seed values `JSON.parse` to the fixture manifest's `spatial` (grids only); every seed key is unique per dataset. Extend `fixtures.test.ts` if it validates manifest schema (add `spatial` to `validateManifest` in `src/datasets/assets.ts` — optional field, shape-checked when present).
- [ ] **Step 2: Run — FAIL. Step 3: Implement** types + manifests (fixtures AND data-branch-work carry identical spatial values — fixtures' tiny shapes don't change the spatial block; it describes the real extract) + scripts (compute spatial from their own LAT0/LON0/STEP/SIZE constants at manifest-write time) + registry table.
- [ ] **Step 4: Run — green. Commit** `feat(datasets): spatial manifest block and per-dataset metadata seed entries`

---

### Task 11: Reducer seeding + preset spatial entries

**Files:**
- Modify: `src/state/useAppState.ts` (`UPDATE_VARIABLE` source-bind branch), `src/presets/geotiffesque.json`, `src/presets/zarrish.json`
- Test: `tests/unit/state/reducer.test.ts`

**Interfaces:**
- Consumes: Task 10's `DATASET_SEED_ENTRIES`.
- Produces: binding a source appends each seed entry whose key is not already present in `metadata.customEntries` (order preserved: existing entries first, new seeds in table order). Clearing a source removes nothing. Presets: geotiffesque + zarrish `customEntries` gain the same crs/bbox/transform values as their dataset's seeds.

- [ ] **Step 1: Failing tests:**

```ts
it('binding a curated source seeds attribution + spatial custom entries', () => {
  const s = reduce(DEFAULT_STATE, { type: 'UPDATE_VARIABLE', id, changes: { source: { datasetId: 'etopo-dem', variableName: 'elevation' } } });
  for (const seed of DATASET_SEED_ENTRIES['etopo-dem']) {
    expect(s.metadata.customEntries).toContainEqual(seed);
  }
});
it('seeding never clobbers an existing key and is idempotent', () => {
  // pre-seed customEntries with { key: 'crs', value: 'EPSG:9999' }; bind twice; expect crs still EPSG:9999, no duplicates
});
it('clearing a source keeps seeded entries', () => { /* bind then source: null → entries unchanged */ });
```

- [ ] **Step 2: Run — FAIL. Step 3: Implement** inside the existing `if (catalog)` block:

```ts
// Seed dataset-level metadata (attribution/spatial/units) as plain custom
// entries — visible, editable, deletable; never clobbers an existing key.
for (const seed of DATASET_SEED_ENTRIES[action.changes.source.datasetId] ?? []) {
  if (!draft.metadata.customEntries.some((e) => e.key === seed.key)) {
    draft.metadata.customEntries.push({ ...seed });
  }
}
```

Add a test-pinned equality between preset spatial entries and seeds (extend Task 10's catalog test or reducer test: load each preset JSON, for every seed key present in the preset expect value equality).

- [ ] **Step 4: Run — green. Commit** `feat(state): seed dataset attribution/spatial metadata on source bind`

---

### Task 12: Guide updates

**Files:**
- Modify: `src/components/guide/steps.ts` (metadata step; grep the write step for the removed Write toggle and placement list)
- Test: none (content); suite must stay green

**Interfaces:** none.

- [ ] **Step 1: Rewrite the metadata step.** Concrete content changes:
  - Binary option pros: "Compact tag records — a numeric tag, a type code, and a typed payload (packed u32s for shape and the chunk index, one-byte enum codes). What Parquet (Thrift) and GeoTIFF (tags) chose." Cons: "Opaque by construction: key names never appear in the bytes, so without the tag table — the spec — a hex dump is unreadable."
  - Chunk-index option cons gains the qualifier: "…the reader must compute offsets — impossible in a single file once any size-changing codec is in play. With per-chunk files each chunk is its own file, so no index is needed at all — which is exactly why Zarr gets away without one."
  - New try-it sentences: the enable-metadata ladder ("Start from defaults: enable metadata and watch Read fail at read-schema; turn groups on one at a time and watch each named step unlock") and the override lie ("Add a custom entry keyed `shape` with a wrong value — your entry wins, and Read trusts it").
  - Body: add one sentence — picking a curated spatial source seeds `crs`/`bbox`/`transform` as ordinary custom entries, "the same strings GeoTIFF carries in its tags."
- [ ] **Step 2: Sweep** `grep -n "Include Metadata\|includeMetadata\|include metadata" src/components/guide/steps.ts` and fix the write step's placement narrative to mention Omit. Run suite. **Commit** `docs(guide): metadata step matches redesign`

---

### Task 13: design.md + CLAUDE.md sync

**Files:**
- Modify: `docs/design.md` (metadata assembly + write + read-extension sections), `CLAUDE.md` (testid list + include-toggle bullets)

- [ ] **Step 1: design.md.** Update: default-off include groups + `metadata.enabled` (assembly master switch, zero-length override) + placement `omit` (assembled-but-discarded lesson, both paths reading `no-metadata`); DC-5 section replaced by override-wins semantics; `chunk_grid` removed from the auto-collected list; binary serialization section replaced with the tag format spec (copy the format block from `docs/superpowers/specs/2026-08-18-metadata-redesign-design.md` §3 — the spec file itself stays uncommitted, so design.md must carry the format independently); chunk index section gains the per-chunk-needs-no-index rule and chunk_order-honoring synthesis; reader notes `partitioning`/`chunk_order` now parsed.
- [ ] **Step 2: CLAUDE.md.** Testid list: add `metadata-enabled-toggle`, `metadata-entries-view`, `metadata-entry-{key}`, `metadata-key-override-note-{i}`; remove `include-metadata-toggle` and `metadata-key-collision-warning-{i}`; rewrite the six-include-toggle bullet (no hints; default off; descriptive gates stats only; custom entries always written when enabled; chunk-index bullet gets the per-chunk exception; endianness bullet unchanged in spirit); update the `variable-source-attribution-{index}` note (source binding now seeds metadata entries) and the preset-carried-provenance note (seeds + presets share values).
- [ ] **Step 3: Commit** `docs: metadata redesign reflected in design.md and CLAUDE.md`

---

### Task 14: Scenario sweep + new coverage

**Files:**
- Modify: every `tests/ui/scenario-*.mjs` that greps for `includeMetadata`, `include-metadata-toggle`, or relies on old defaults — known: `scenario-large-array.mjs`, `scenario-flatview-stages.mjs`, `scenario-hover-linking.mjs`, `scenario-text-variable.mjs`, `scenario-curated-variables.mjs`, `scenario-task4.7-fixes.mjs`, `scenario-diff-summary.mjs`, `scenario-real-codecs.mjs`, `scenario-perf1-large-boot.mjs`, `scenario-linearization-endianness.mjs`, `scenario-crash-inputs.mjs`, `scenario-placement-matrix.mjs`, `scenario-read-process.mjs`, `scenario-worker-pipeline.mjs`, `scenario-pane-defaults.mjs`
- Test: the scenarios themselves are the test

**Interfaces:** consumes everything.

- [ ] **Step 1: Mechanical seed fix.** In every scenario seeding state via `seedStateAndReload`: `write.includeMetadata: true` → `metadata: { ...enabled: true, include: { all six true } }` (old-shape seeds now DROP to defaults per Task 1 — a seed that still carries `includeMetadata` silently tests the wrong state; this is the failure mode to watch for). Toggling via `include-metadata-toggle` → `metadata-enabled-toggle` (+ its `-opt-*` Radio testids).
- [ ] **Step 2: Targeted upgrades.**
  - `scenario-placement-matrix.mjs`: add the `omit` row — expect no metadata in any file, read fails `no-metadata`, Metadata stage still shows nonzero bytes (Entries view populated).
  - `scenario-read-process.mjs`: add the ladder walk — fresh defaults → enable metadata → assert failure at read-schema via `read-status-progress`; enable schema → failure at read-layout; enable layout/codecs/chunkIndex → success. Also: per-chunk + entropy codec + chunkIndex off → success (Task 5's fix, end to end).
  - `scenario-curated-variables.mjs`: after binding a source, assert seeded `crs`/`source` keys appear in custom entries and in the written file's metadata.
  - New checks (in `scenario-read-process.mjs` or a new `scenario-metadata-entries.mjs` built on `scenario-helpers.mjs`): Entries view default for Metadata stage, rows in both serializations, tag column visible only for binary; override lie (`shape` custom entry) visible in Entries view and producing a read failure.
- [ ] **Step 3: Run all scenarios** against `npm run dev` (serves `http://localhost:5173/0x00c0dec5/`); reconcile any KNOWN-FAIL/UNEXPECTED flips per the harness rules in CLAUDE.md. **Step 4: Run `npx vitest run` one final time. Commit** `test(ui): scenarios for metadata redesign (ladder, omit, entries view, seeding)`

---

## Self-review notes (done at plan time)

- Spec coverage: §1→Tasks 1,3,8; §2→Task 2; §3→Tasks 6,7; §4→Tasks 4,5; §5→Task 8; §6→Task 9; §7→Tasks 10,11; §8→Tasks 12,13; §9→woven through + Task 14. No gaps found.
- Type consistency: `structure.partitioning`/`structure.chunkOrder` (Tasks 4→5), `DATASET_SEED_ENTRIES` (10→11), `decodeMetadataBinary`/`MetadataDisplayEntry` (6→7→9), `overriddenAutoKeys` (2→8) — names match across tasks.
- Ordering: 1→2→3 sequential; 4→5 sequential; 6→7 sequential (can run parallel to 1-5 EXCEPT Task 7's roundtrip tests want Task 3's omit/enabled semantics — run 7 after 3); 8 after 2; 9 after 7 and 8; 10→11 independent of 2–9 (after 1); 12–14 last.
