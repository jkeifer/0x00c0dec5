# Row Mode Single Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Row/interleaved mode runs no per-variable codec pipelines: cast to `storageDtype` → interleave → one shared chunk pipeline. Delete the structured-prefix mechanism end to end.

**Architecture:** Pure deletion. `splitStructuredPrefix`/`isElementStructured`/`rowModeChunkInputDtype` are removed from `src/engine/codecs.ts`; `encodeRowChunk` interleaves raw storage-dtype bytes; metadata reverts to a bare chunk-pipeline array in row mode; the reader reverses one pipeline per chunk; the row-mode UI shows only the shared editor. Column mode is untouched.

**Tech Stack:** React + TypeScript + Vite, vitest, Playwright scenario scripts.

**Spec:** `docs/superpowers/specs/2026-08-20-row-mode-single-pipeline-design.md`

## Global Constraints

- Do NOT commit anything under `docs/superpowers/` (user instruction — spec and this plan stay uncommitted). `git add` explicit paths only; never `git add -A`.
- Unit tests live in `tests/unit/`, never in `src/` (user preference).
- Column-mode behavior, codec unification (`outputDtypeFor`, `sizeEffect`, transform codecs in `CODEC_REGISTRY`), tracing modes, and `write.ts`/`layout.ts` are all out of scope — do not touch.
- `SET_INTERLEAVING` must continue to touch neither `fieldPipelines` nor `chunkPipeline` state.
- No migration for `{chunk, fields}`-envelope metadata: written files are in-session artifacts.
- Run tests with `npx vitest run <file>`; the full suite is `npx vitest run`.
- Suggested models for subagent dispatch: Task 1 = opus (engine + read path), Tasks 2–4 = sonnet.

---

### Task 1: Engine — encode, metadata, read path (single coherent change)

Encode, metadata, and read must change together: if the encoder stops running
prefixes while metadata still records them, every row-mode roundtrip test fails
in between. This task is the whole engine side plus its tests.

**Files:**
- Modify: `src/engine/codecs.ts` (delete `isElementStructured` :746-753, `splitStructuredPrefix` :755-769, `rowModeChunkInputDtype` :845-863; update `foldUniformDtype` doc comment :833-839)
- Modify: `src/engine/pipelineCompute.ts` (`collectEncodedWarnings` :311-330, `encodeRowChunk` :362-444, `computeEncodedStage` row branch :484-490, `codecStats` doc comment :300-308)
- Modify: `src/engine/metadata.ts` (:102-115 row branch)
- Modify: `src/engine/read.ts` (`parseStructure` :285-309, `computeCodecLossyVariables` :478-515)
- Modify: `src/engine/readReassemble.ts` (derived chunk index :215-239, `reconstructValues` row branch :288-331, delete `rowModeEncodedSchema` :361-373, retarget `rowModeInputDtype` :357-359 and `deinterleaveRowChunkBytes` :375-396 comments/params to raw schema)
- Test: `tests/unit/engine/codecs.test.ts` (delete `splitStructuredPrefix` describe :335-367 + its import)
- Test: `tests/unit/engine/pipeline.integration.test.ts` (rewrite the Task 8 describe :259-337)
- Test: `tests/unit/engine/read.test.ts` (rewrite the Task 9 describe :160-378; KEEP the `chunk`/`fields` column-name test at :939-956 — it still passes under the two-way parse and guards it; trim its comment's envelope references)

**Interfaces:**
- Consumes: existing `foldUniformDtype(dtypes: DtypeKey[]): DtypeKey`, `activeSteps`, `runCodecPipeline`, `encodedChunkMeta`, `reverseCodecPipeline`, `encodedByteLength`.
- Produces (later tasks rely on): `foldUniformDtype` exported from `src/engine/codecs.ts` (unchanged signature — Task 2's UI imports it); row-mode `codec_pipelines` metadata = bare `CodecStep[]` JSON; `rowModeInputDtype(schema: SchemaEntry[]): DtypeKey` (unchanged signature, still exported from `readReassemble.ts`); `deinterleaveRowChunkBytes(bytes, schema: SchemaEntry[], chunkElementCount)` (param renamed `encSchema` → `schema`, same shape).

- [ ] **Step 1: Rewrite the row-mode engine tests to the new semantics (they will fail against current code)**

In `tests/unit/engine/pipeline.integration.test.ts`, replace the whole
`describe('Integration: row-mode structured prefix (Task 8)', ...)` block
(:259-337, keep the surrounding `baseVars`-style fixture inline) with:

```ts
describe('Integration: row mode ignores field pipelines', () => {
  // Two vars, one chunk: float32 `t` WITH a field pipeline and int32 `d`
  // without. Row mode must ignore field pipelines entirely — variables are
  // cast to storageDtype, interleaved at raw widths, and only the shared
  // chunk pipeline runs.
  const shape = [8];
  const baseVars = [
    {
      id: 't', name: 't', color: '#f00',
      logicalType: { type: 'decimal' as const, min: -50, max: 50, decimalPlaces: 1, generation: 'random' as const },
      typeAssignment: { storageDtype: 'float32' as const },
    },
    {
      id: 'd', name: 'd', color: '#0f0',
      logicalType: { type: 'integer' as const, min: -1000, max: 1000, generation: 'random' as const },
      typeAssignment: { storageDtype: 'int32' as const },
    },
  ];
  const elementCount = shape.reduce((a, b) => a * b, 1);

  it('interleaves at raw storage-dtype widths even when field pipelines exist', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      shape, chunkShape: shape,
      interleaving: 'row',
      variables: baseVars,
      fieldPipelines: { t: [{ codec: 'scale-offset', params: {} }], d: [] },
      chunkPipeline: [],
    };
    const { stages } = computePipelineStages(state);
    const encoded = stages[3];
    // per element 4 (float32, scale-offset IGNORED) + 4 (int32) = 8
    expect(encoded.stats.byteCount).toBe(elementCount * 8);
    const region = encoded.layout.regions[0] as ChunkBlockRegion;
    expect(region.fields.map((f) => ({ dtype: f.dtype, size: f.size, offset: f.offset })))
      .toEqual([
        { dtype: 'float32', size: 4, offset: 0 },
        { dtype: 'int32', size: 4, offset: 4 },
      ]);
  });

  it('a size-changing field pipeline step is also ignored; the chunk pipeline still runs', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      shape, chunkShape: shape,
      interleaving: 'row',
      variables: baseVars,
      fieldPipelines: { t: [{ codec: 'rle', params: {} }], d: [] },
      chunkPipeline: [{ codec: 'delta', params: {} }],
    };
    const { stages } = computePipelineStages(state);
    // rle (field) ignored → still raw widths; delta (chunk) preserves size.
    expect(stages[3].stats.byteCount).toBe(elementCount * 8);
  });
});
```

In `tests/unit/engine/read.test.ts`, replace the
`describe('readFile — row mode structured prefix (Task 9)', ...)` block
(:160-378) with a `describe('readFile — row mode single pipeline', ...)`
covering (reuse the existing block's fixture style — `DEFAULT_STATE` spread,
`ALL_INCLUDE`, `computePipelineStages` → `readFile`):

1. **Roundtrip, chunk pipeline only:** two variables (int32 `count`, int32
   `flag`), empty `fieldPipelines`, `chunkPipeline: [{ codec: 'rle', params: {} }]`,
   metadata all-on. `readFile` succeeds and both variables' reconstructed
   values equal `generateValues(...)` exactly (integer dtypes — use `toEqual`,
   not `toBeCloseTo`).
2. **Metadata shape:** from the same state, find the written
   `codec_pipelines` entry (parse the metadata stage or the read result's
   parsed structure) and assert it is a **bare array**
   (`Array.isArray(JSON.parse(value)) === true`) whose single step is `rle`.
   Assert a populated-but-ignored `fieldPipelines` never appears in metadata:
   set `fieldPipelines: { count: [{ codec: 'delta', params: {} }], flag: [] }`,
   recompute, and assert the `codec_pipelines` JSON is still the bare array.
3. **Codecs group off + size-changing chunk step hard-fails:** same state but
   `include.codecs: false` → `readFile` fails at decode with the
   assumed-identity size mismatch (mirror the existing test's assertions at
   the same spot in the old block).
4. **Chunk index off, size-preserving chunk pipeline derives offsets:**
   `chunkPipeline: [{ codec: 'delta', params: {} }]`,
   `include.chunkIndex: false`, single-file → read succeeds (record width =
   sum of raw dtype widths).
5. **Lossy chunk step marks all variables:** two float32 variables, empty
   field pipelines, chunk pipeline = one `quantize` step — check
   `CODEC_REGISTRY['quantize'].params` in `src/engine/codecs.ts` for the real
   param key/default rather than guessing (uniform float32 fold → quantize
   applies) → `codecLossyVariables` (or the result field the old block
   asserted) contains BOTH variable names.

Check the old block for the exact result-field names/assertion helpers and
keep them; only the semantics change. Delete the old
"prefix lossiness marks only the prefixed variable" case — unattributable
now — and the "fixed-ratio prefix" chunk-index case (replaced by #4).

In `tests/unit/engine/codecs.test.ts`: delete the
`describe('splitStructuredPrefix', ...)` block (:335-367) and remove
`splitStructuredPrefix` from the import at :11.

- [ ] **Step 2: Run the rewritten tests to verify they fail**

Run: `npx vitest run tests/unit/engine/pipeline.integration.test.ts tests/unit/engine/read.test.ts`
Expected: the new row-mode tests FAIL (current code still runs prefixes / writes the envelope). Pre-existing tests still pass.

- [ ] **Step 3: `src/engine/codecs.ts` — delete the prefix machinery**

Delete `isElementStructured` (:746-753 incl. comment), `splitStructuredPrefix`
(:755-769 incl. comment), and `rowModeChunkInputDtype` (:845-863 incl.
comment). Replace `foldUniformDtype`'s doc comment (:833-839) with:

```ts
/** TN-2: row mode's input-dtype fold — uniform dtypes collapse to that
 *  dtype, an empty or mixed set collapses to 'uint8' (an interleaved record
 *  with mixed field widths has no single element dtype, so codecs downstream
 *  treat it as an opaque byte stream). Shared by pipelineCompute's row
 *  encode/warnings, CodecSection's row-mode dtype label, and
 *  readReassemble.ts's `rowModeInputDtype`. */
```

Remove the now-unused `Variable` import if it was only used by
`rowModeChunkInputDtype` (check the imports at the top of the file).

- [ ] **Step 4: `src/engine/pipelineCompute.ts` — raw-width interleave**

Imports: drop `splitStructuredPrefix` and `rowModeChunkInputDtype`, keep/add
`foldUniformDtype`.

`collectEncodedWarnings` (:311-330) — replace the row branch:

```ts
  // Row mode: field pipelines don't run — the chunk pipeline is the only
  // pipeline, at the interleaved raw-storage-dtype input (uniform → that
  // dtype, mixed/empty → uint8).
  const inputDtype = foldUniformDtype(variables.map((v) => v.typeAssignment.storageDtype));
  return stepWarnings(chunkPipeline, inputDtype);
```

`encodeRowChunk` (:362-444) — new shape (no `nameToId`, no `fieldPipelines`,
no `prefixStats`):

```ts
/** Row-mode per-chunk encode: cast each variable's values to its storage
 * dtype, interleave records at raw dtype widths, then run the shared chunk
 * pipeline on the interleaved stream. Field pipelines never run in row mode
 * (they apply in column mode only); readReassemble.ts mirrors this exactly. */
function encodeRowChunk(
  chunk: Chunk,
  linearized: LinearizedChunk,
  chunkPipeline: CodecStep[],
  byteOrder: 'little' | 'big',
): {
  encoded: EncodedChunk;
  fields: ChunkFieldLayout[];
  traceMode: ChunkTraceMode;
  chunkStepStats: (CodecStepStats | null)[];
} {
  const perVar = chunk.variables.map((cv) => {
    const dtype = cv.dtype as DtypeKey;
    return {
      bytes: valuesToBytes(cv.values, dtype, byteOrder),
      dtype,
      size: getDtype(dtype).size,
      name: cv.variableName,
      color: cv.variableColor,
    };
  });

  // Empty-variables chunk: 0 elements, 0-size record — an empty valid output.
  const elementCount = chunk.variables[0]?.values.length ?? 0;
  const recordSize = perVar.reduce((a, p) => a + p.size, 0);
  const interleaved = new Uint8Array(elementCount * recordSize);
  let w = 0;
  for (let i = 0; i < elementCount; i++) {
    for (const p of perVar) {
      interleaved.set(p.bytes.subarray(i * p.size, (i + 1) * p.size), w);
      w += p.size;
    }
  }

  const inputDtype = foldUniformDtype(perVar.map((p) => p.dtype));
  const meta = encodedChunkMeta(chunkPipeline, inputDtype);
  const result = runCodecPipeline(interleaved, chunkPipeline, inputDtype, byteOrder);

  // Slot fields at raw dtype widths. If the chunk pipeline degraded the
  // mode, relabel every field's dtype to the frozen slotDtype (today's rule).
  let off = 0;
  const fields: ChunkFieldLayout[] = perVar.map((p) => {
    const f: ChunkFieldLayout = {
      variableName: p.name, variableColor: p.color,
      dtype: meta.traceMode === 'value-preserving' ? p.dtype : meta.slotDtype,
      size: p.size, offset: off,
    };
    off += p.size;
    return f;
  });

  return {
    encoded: { chunkId: linearized.chunkId, coords: linearized.coords, bytes: result.bytes },
    fields,
    traceMode: meta.traceMode,
    chunkStepStats: result.stepStats,
  };
}
```

`computeEncodedStage` row branch (:484-490) — drop the prefix stats:

```ts
    const { encoded, fields, traceMode, chunkStepStats } =
      encodeRowChunk(chunk, linearized, chunkPipeline, byteOrder);
    slotFields.push(fields);
    traceModes.push(traceMode);
    addStats('chunk', chunkStepStats);
    return encoded;
```

Update the `codecStats` doc comment (:300-308): keyed by `Variable.id` for
column-mode field pipelines and by the literal string `'chunk'` for the
row-mode chunk pipeline (delete the row-prefix/padding sentences).

- [ ] **Step 5: `src/engine/metadata.ts` — bare array in row mode**

Replace the row branch (:102-115) with:

```ts
    } else {
      // Row mode: field pipelines don't run — only the shared chunk pipeline
      // does, so a bare array records exactly what was applied. (Distinct
      // from column mode's by-name object; the reader disambiguates on
      // Array.isArray.)
      entries.push({
        key: 'codec_pipelines',
        value: JSON.stringify(activeSteps(state.chunkPipeline)),
      });
    }
```

Remove the `splitStructuredPrefix` import.

- [ ] **Step 6: `src/engine/read.ts` — two-way parse, chunk-only lossiness**

`parseStructure` (:285-309) — replace the three-way disambiguation:

```ts
  if (codecPipelinesStr) {
    const parsed = JSON.parse(codecPipelinesStr);
    if (Array.isArray(parsed)) {
      // Row mode: bare array — the shared chunk pipeline, the only pipeline
      // that runs in row mode.
      chunkPipeline = parsed;
    } else {
      // Column mode: plain by-name object of field pipelines.
      fieldPipelines = parsed;
    }
  }
```

`computeCodecLossyVariables` (:478-515) — replace the row branch:

```ts
  } else {
    // Row mode: one shared chunk pipeline on the interleaved stream — if any
    // step is lossy there is no way to isolate one variable's contribution,
    // so it marks all variables.
    if (isPipelineLossy(chunkPipeline ?? [], rowModeInputDtype(schema))) {
      for (const varInfo of schema) {
        lossy.add(varInfo.name);
      }
    }
  }
```

Update the function's doc comment (:470-477) to drop the prefix sentences.
Remove the `rowModeEncodedSchema` import (keep `rowModeInputDtype`).

- [ ] **Step 7: `src/engine/readReassemble.ts` — raw-width deinterleave**

Derived chunk index, row half (:215-239) — replace with:

```ts
  const steps = chunkPipeline ?? [];
  // Record width is the schema sum — field pipelines don't run in row mode,
  // so a record is each variable's raw storageDtype bytes side by side.
  const bytesPerElement = schema.reduce((sum, v) => sum + getDtype(v.dtype).size, 0);
  const entries: ChunkIndexEntry[] = [];
  let offset = magicLength;
  for (const coords of coordsList) {
    const raw = chunkGeometry(coords, chunkShape, shape).elementCount * bytesPerElement;
    const size = encodedByteLength(steps, rowModeInputDtype(schema), raw);
    if (size === null) {
      throw new NoChunkIndexError('row-mode chunk pipeline has a size-changing codec with no chunk index');
    }
    entries.push({ coords, offset, size });
    offset += size;
  }
  return entries;
```

`reconstructValues` row branch (:288-331) — replace with:

```ts
    // Row mode: each chunk_index entry covers all variables' interleaved
    // bytes for that chunk. Reverse the shared chunk pipeline, deinterleave
    // at raw schema dtype widths, decode each field's values, and scatter
    // into global position — the exact inverse of encodeRowChunk
    // (pipelineCompute.ts). Field pipelines never ran, so there is nothing
    // per-variable to reverse.
    const steps = chunkPipeline ?? [];
    const inputDtype = rowModeInputDtype(schema);
    const schemaBytesPerElement = schema.reduce((sum, v) => sum + getDtype(v.dtype).size, 0);

    for (const varInfo of schema) {
      result.set(varInfo.name, makeReconstructionTarget(varInfo.dtype, totalElements));
    }

    for (const entry of chunkIndex ?? []) {
      const chunkBytes = getChunkBytes(entry);
      if (!chunkBytes) continue;
      const chunkElementN = chunkGeometry(entry.coords, chunkShape, shape).elementCount;
      if (!codecInfoPresent) {
        const expectedBytes = chunkElementN * schemaBytesPerElement;
        checkAssumedIdentitySize(chunkBytes.length, expectedBytes, undefined, entry.coords);
      }
      const decoded = reverseCodecPipeline(chunkBytes, steps, inputDtype, byteOrder);
      const perVarBytes = deinterleaveRowChunkBytes(decoded.bytes, schema, chunkElementN);
      for (const varInfo of schema) {
        const chunkValues = bytesToValues(perVarBytes.get(varInfo.name)!, varInfo.dtype, byteOrder);
        scatterChunkValues(
          result.get(varInfo.name)!,
          chunkValues,
          entry.coords,
          chunkShape,
          shape,
          linearization,
        );
      }
    }
```

Delete `rowModeEncodedSchema` (:361-373). In `deinterleaveRowChunkBytes`
(:375-396), rename the `encSchema` param to `schema` and update its comment:
splits at raw schema dtype widths ("encoded"/post-prefix language goes).
`rowModeInputDtype` (:357-359) keeps its signature; its callers now pass the
raw schema. Note `fieldPipelines` is no longer read by the row branches —
remove it from the row-side destructuring only if TypeScript flags it unused
(column mode still uses it).

- [ ] **Step 8: Run engine tests**

Run: `npx vitest run tests/unit/engine/`
Expected: PASS, including the rewritten row-mode blocks. If
`layout.equivalence` / `layout.reverse` / `roundtrip.matrix` fail, their
fixtures assume row-mode prefixes — fix the FIXTURE expectations to raw-width
semantics, never the engine (they are generic tests; only expectations keyed
to prefix widths may change).

- [ ] **Step 9: Full unit suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: unit failures ONLY in `tests/unit/components/codecInactiveFrom.test.tsx` /
`codecSectionMixedDtype.test.tsx` (Task 2 rewrites them) and any UI-component
test importing deleted symbols — everything else green. `tsc` errors expected
only in `CodecSection.tsx` if it still imports deleted symbols (Task 2); if
so, note it in the report and let Task 2 clear it. Engine files must be clean.

- [ ] **Step 10: Commit (engine only)**

```bash
git add src/engine/codecs.ts src/engine/pipelineCompute.ts src/engine/metadata.ts src/engine/read.ts src/engine/readReassemble.ts tests/unit/engine/codecs.test.ts tests/unit/engine/pipeline.integration.test.ts tests/unit/engine/read.test.ts
git commit -m "feat(engine): row mode runs no field pipelines — cast, interleave, one shared pipeline"
```

(If Step 9 left `CodecSection.tsx` failing `tsc`, that is expected and fixed
in Task 2 — commit anyway; note it in the task report.)

---

### Task 2: UI — row mode shows only the shared pipeline

**Files:**
- Modify: `src/components/config/CodecSection.tsx` (imports :6, row branch :112-183, `VariableCodecEditor`'s `inactiveFrom` prop :22-71)
- Modify: `src/components/config/CodecPipelineEditor.tsx` (`inactiveFrom` prop :28-33/:78, `inactive` usages :170/:184, note block :294-307)
- Delete: `tests/unit/components/codecInactiveFrom.test.tsx`
- Test: `tests/unit/components/codecSectionMixedDtype.test.tsx` (rewrite)

**Interfaces:**
- Consumes: `foldUniformDtype(dtypes: DtypeKey[]): DtypeKey` from `src/engine/codecs.ts` (Task 1 kept it exported).
- Produces: row-mode DOM = exactly one pipeline editor (`codec-add-chunk`, `codec-step-chunk-{i}`), zero per-variable editors; `codec-mixed-dtype-warning` gated on raw `storageDtype`s; `codec-row-inactive-note-*` testid gone. Task 4's scenario asserts these.

- [ ] **Step 1: Rewrite the component tests (fail first)**

Delete `tests/unit/components/codecInactiveFrom.test.tsx`.

Rewrite `tests/unit/components/codecSectionMixedDtype.test.tsx` (keep its
existing render/fixture helpers — read it first) to three cases:

1. Row mode, variables with differing raw `storageDtype`s (float32 + int32),
   empty pipelines → `codec-mixed-dtype-warning` present.
2. Row mode, uniform raw dtypes (float32 + float32) → no warning.
3. Row mode renders NO per-variable editors and one shared editor:
   `queryByTestId('codec-add-{variableName}')` null for each variable,
   `getByTestId('codec-add-chunk')` present, and
   `queryByTestId('codec-row-inactive-note-{variableName}')` null even when a
   variable has a non-empty field pipeline.

Run: `npx vitest run tests/unit/components/codecSectionMixedDtype.test.tsx`
Expected: FAIL (current UI renders per-variable editors and gates the warning
on post-prefix dtypes).

- [ ] **Step 2: `CodecSection.tsx`**

Imports (:6): `import { foldUniformDtype } from '../../engine/codecs.ts';`
(drop `splitStructuredPrefix`, `pipelineOutputDtype`, `rowModeChunkInputDtype`).

`VariableCodecEditor` (:22-71): remove the `inactiveFrom` prop entirely (it
is now column-only; column never passed it) — both from the props type and
the `<CodecPipelineEditor>` call; update its TN-3 comment to say the block is
column-mode-only.

Replace everything from the row-mode comment (:112) through the end of the
component with:

```tsx
  // Row mode: field pipelines don't run — variables are cast to their
  // storage dtype and interleaved per element, and the interleaved stream
  // gets exactly one shared codec pipeline. Column-mode field pipelines are
  // preserved in state and reactivate on switching back (SET_INTERLEAVING
  // touches no pipeline state).
  const rawDtypes = variables.map((v) => v.typeAssignment.storageDtype);
  const mixedDtypes = new Set(rawDtypes).size > 1;
  const inputDtype: DtypeKey = foldUniformDtype(rawDtypes);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm }}>
      <div
        style={{
          background: colors.accentDim,
          borderLeft: `2px solid ${colors.accent}`,
          borderRadius: radii.sm,
          padding: spacing.xs,
          fontSize: fontSizes.xs,
          color: colors.textSecondary,
        }}
      >
        Row mode: variables are interleaved per element, then one shared codec
        pipeline applies to the combined stream. Per-variable pipelines apply
        in column mode only — yours are kept and restored on switching back.
      </div>
      {mixedDtypes && (
        <div
          data-testid="codec-mixed-dtype-warning"
          style={{
            background: colors.warningDim,
            borderLeft: `2px solid ${colors.warning}`,
            borderRadius: radii.sm,
            padding: spacing.xs,
            fontSize: fontSizes.xs,
            color: colors.textSecondary,
          }}
        >
          The interleaved stream mixes dtypes — codecs like Byte Shuffle and
          Delta that assume uniform element size will produce garbled output.
        </div>
      )}
      <CodecPipelineEditor
        steps={chunkPipeline}
        inputDtype={inputDtype}
        onChange={onChunkPipelineChange}
        variableSlot="chunk"
        runtimeStatus={runtimeStatus}
        stepStats={codecStats?.['chunk']}
      />
    </div>
  );
```

- [ ] **Step 3: `CodecPipelineEditor.tsx`**

Remove the `inactiveFrom` prop (interface :28-33, destructure :78), the
`inactive` const (:170), restore `opacity: enabled ? 1 : 0.45` (:184), delete
the note block (:294-307), and collapse the extra wrapper `<div key={i}>`
(:173/:308) back onto the step div (move `key={i}` to the
`codec-step-` div). Nothing else in the file changes.

- [ ] **Step 4: Run component tests + typecheck**

Run: `npx vitest run tests/unit/components/ && npx tsc --noEmit`
Expected: PASS / clean (this clears any Task 1 leftover `tsc` error).

- [ ] **Step 5: Commit**

```bash
git add src/components/config/CodecSection.tsx src/components/config/CodecPipelineEditor.tsx tests/unit/components/codecSectionMixedDtype.test.tsx
git rm tests/unit/components/codecInactiveFrom.test.tsx
git commit -m "feat(ui): row-mode codec section shows only the shared pipeline"
```

---

### Task 3: Avro-esque preset + docs

**Files:**
- Modify: `src/presets/avroesque.json` (`fieldPipelines` :108-144, `metadata.customEntries` :152-181)
- Modify: `CLAUDE.md` (pitfall 4; testid-list entries `codec-row-inactive-note-{variable}` and the `codec-mixed-dtype-warning` mention inside the pitfall-4 summary line of `codec-add-{variable}`/related entries — grep `codec-row-inactive-note` and `splitStructuredPrefix` in CLAUDE.md and update every hit)
- Modify: `docs/design.md` (:83 row-oriented description, :96 summary table row, :342 mixed-dtype callout, :676 `codec_pipelines` format, :910 edge-case row — grep `splitStructuredPrefix` and `prefix` nearby to catch all)

**Interfaces:**
- Consumes: row-mode metadata = bare chunk-array (Task 1); row-mode UI = single shared editor (Task 2).
- Produces: preset with empty `fieldPipelines` that Task 4's scenarios load and roundtrip.

- [ ] **Step 1: `avroesque.json`**

Set all five `fieldPipelines` entries to `[]` (the three scale-offset steps
go). Keep `chunkPipeline` (`deflate`) and everything else. Append one custom
entry after `precipitation_units`:

```json
      {
        "key": "note",
        "value": "Row format: no per-field codecs — precision must live in the type, so temperatures ship as float32 (4 bytes/value). Compare Parquet-adjacent, whose per-field Scale/Offset stores them as int16 tenths."
      }
```

- [ ] **Step 2: Verify the preset loads and roundtrips**

Run: `npx vitest run tests/unit/state/` (preset/persistence suites — locate
via `grep -rl resolvePreset tests/unit`) plus `npx vitest run tests/unit/engine/read.test.ts`.
Expected: PASS. (The preset's in-browser Pyodide roundtrip is Task 4's
scenario.)

- [ ] **Step 3: CLAUDE.md**

Rewrite pitfall 4 to (adjust surrounding prose to fit):

> **Interleaving mode switches — row mode runs no field pipelines.** Row mode
> is: cast each variable to its `typeAssignment.storageDtype`, byte-interleave
> per element at raw dtype widths, then run the single shared `chunkPipeline`
> on the interleaved stream (`encodeRowChunk`, `src/engine/pipelineCompute.ts`;
> mirrored by `readReassemble.ts`). Per-variable pipelines apply in column mode
> only. `SET_INTERLEAVING` never touches `fieldPipelines`/`chunkPipeline`
> state — switching back to column reactivates the full field pipelines
> unchanged. `CodecSection` renders only the shared editor in row mode; the
> mixed-dtype warning (`codec-mixed-dtype-warning`) gates on the variables'
> raw `storageDtype`s. Row-mode metadata records `codec_pipelines` as a bare
> chunk-pipeline array (column mode: by-name object).

Delete the `codec-row-inactive-note-{variable}` testid entry. Fix every other
`splitStructuredPrefix`/structured-prefix/post-prefix reference CLAUDE.md
makes (grep for them — at minimum the `codec-add-{variable}` and pitfall-3
adjacent mentions).

- [ ] **Step 4: docs/design.md**

Update each location to the new semantics (grep `splitStructuredPrefix` and
`structured prefix` to catch all):
- :83 — row-oriented/BIP: bytes interleaved per element at raw storage-dtype
  widths; field pipelines do not run; one shared chunk pipeline.
- :96 — matching summary-table cell.
- :342 — mixed-dtype callout: gates on raw storage dtypes.
- :676 — `codec_pipelines`: column = by-name object; row = bare
  chunk-pipeline array (delete the `{chunk, fields}` envelope paragraph).
- :910 — edge case: field pipelines preserved in state but entirely inactive
  in row mode; restored on switching back.

- [ ] **Step 5: Commit**

```bash
git add src/presets/avroesque.json CLAUDE.md docs/design.md
git commit -m "docs+preset: row mode single pipeline — avroesque drops dead field steps"
```

---

### Task 4: Scenario rewrite + full verification

**Files:**
- Modify: `tests/ui/scenario-transform-codecs.mjs` (row-mode section — read the whole file first)

**Interfaces:**
- Consumes: Tasks 1–3 landed. Dev server at `http://localhost:5173/0x00c0dec5/` (start with `npm run dev &`). Scenario helpers in `tests/ui/scenario-helpers.mjs` (use `seedStateAndReload` for any localStorage seeding — CLAUDE.md pitfall 7).
- Produces: green full verification.

- [ ] **Step 1: Rewrite the scenario's row-mode checks**

Current behavior (read the file — the row section is around the
`codec-row-inactive-note-temp` locator at :95): seeds a column-mode 2-step
structured field pipeline, switches to row, asserts both steps stay active.
Rewrite that section to assert the new contract:

1. After switching to Row-oriented: `codec-add-temp` (and any other
   per-variable add button) has count 0; `codec-add-chunk` count 1;
   `codec-step-temp-0` count 0; no `codec-row-inactive-note-*` anywhere.
2. Switch back to Column-oriented: the seeded field pipeline re-renders
   intact (`codec-step-temp-0` and `codec-step-temp-1` present with the same
   codec labels as seeded).
3. Keep the file's existing column-mode checks unchanged.

- [ ] **Step 2: Full unit suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all green.

- [ ] **Step 3: Scenario runs against dev server**

```bash
npm run dev &
sleep 3
node tests/ui/scenario-transform-codecs.mjs
node tests/ui/scenario-real-codecs.mjs
node tests/ui/scenario-curated-variables.mjs
kill %1
```
Expected: every check PASS (or pre-existing KNOWN-FAIL). `scenario-curated-variables.mjs`
covers the avroesque preset's in-browser Pyodide roundtrip.

- [ ] **Step 4: Deletion is total**

Run: `grep -rn "splitStructuredPrefix\|isElementStructured\|rowModeChunkInputDtype\|rowModeEncodedSchema\|codec-row-inactive-note\|inactiveFrom" src tests CLAUDE.md docs/design.md`
Expected: no hits. (Hits inside `docs/superpowers/` history docs are fine and
excluded from this grep.)

- [ ] **Step 5: Commit**

```bash
git add tests/ui/scenario-transform-codecs.mjs
git commit -m "test(ui): row-mode scenario asserts single shared pipeline"
```
