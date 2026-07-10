# Performance Architecture Implementation Plan (Spec Phases 1–3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-byte trace materialization with arithmetic layout lookups, move pipeline compute into a coalescing Web Worker, and add build-info/About-modal/service-worker infrastructure — so the app handles ~1M-element datasets without OOM or UI freezes.

**Architecture:** Each pipeline stage carries a compact `StageLayout` (O(variables + chunks) plain data) instead of `ByteTrace[]` (O(bytes) objects); pure functions in `src/engine/layout.ts` compute any byte's `ByteTrace` on demand and invert traceIds to byte ranges. `computePipelineStages` runs in a module worker behind a latest-wins client; the UI keeps the last good result with a "recomputing" indicator. Behavior is pinned by an equivalence test suite that compares lookups against the current trace-building code (preserved as a test-only reference) byte-for-byte before the old path is deleted.

**Tech Stack:** React 19 + TypeScript + Vite (base `/0x00c0dec5/`), vitest (node env), Playwright scenario harness (`tests/ui/scenario-helpers.mjs`), no new runtime dependencies.

**Covers spec Phases 1–3.** Spec Phases 4–5 (canvas GridView, hex overview+jump, LZ hash-chain, caps) are a follow-up plan, gated on this plan's profiling numbers.

## Global Constraints

- **No new runtime dependencies.** `vite-node` (ships with vitest) may be used for scripts.
- **Engine before UI** (CLAUDE.md): every engine module lands with passing vitest tests before any component consumes it.
- **Behavior pinning:** viewer-visible tracing behavior must not change in this plan — the equivalence suite (Task 2's harness) is the arbiter. That includes current quirks (e.g. byte-shuffle traces do NOT follow the transpose — `propagateTracesValuePreserving` is a 1:1 copy; reproduce, don't "fix").
- **Styling:** inline styles from `src/theme.ts`; new interactive elements get `data-testid`s per CLAUDE.md conventions.
- **All existing tests and scenarios stay green after every task:** `npx vitest run` and (where a task says so) the `tests/ui/scenario-*.mjs` suite against `npm run dev`.
- **Commit after every task** (steps below include the commit).
- **TraceId formats are frozen:** `${variableName}:${coords.join(',')}` (value), `chunk:${chunkId}` (chunk), `magic:start`/`magic:end`/`metadata` (structural) — see `src/engine/trace.ts`.

---

## Phase A — Profiling harness

### Task 1: Profiling harness (`scripts/profile.ts`)

**Files:**
- Create: `scripts/profile.ts`
- Modify: `package.json` (add `profile` script)

**Interfaces:**
- Consumes: `computeValuesStage`, `computeTypedStage`, `computeLinearizedStage`, `computeEncodedStage`, `computeMetadataStage`, `computeFilesStage`, `computeReadStage` from `src/hooks/usePipeline.ts`; `DEFAULT_STATE` from `src/types/state.ts`.
- Produces: `npm run profile [-- --sizes=10000,100000,1000000]` printing a per-stage wall-time + heap-delta table. No production code.

- [ ] **Step 1: Write the script**

```typescript
// scripts/profile.ts — per-stage timing/heap harness (spec Phase 1).
// Run: npm run profile            (all sizes; 1M may OOM pre-lazy-traces — that IS the baseline finding)
//      npm run profile -- --sizes=10000,100000
// For heap numbers, prefix: NODE_OPTIONS=--expose-gc
import { DEFAULT_STATE } from '../src/types/state.ts';
import type { AppState } from '../src/types/state.ts';
import {
  computeValuesStage, computeTypedStage, computeLinearizedStage,
  computeEncodedStage, computeMetadataStage, computeFilesStage, computeReadStage,
} from '../src/hooks/usePipeline.ts';

const sizesArg = process.argv.find((a) => a.startsWith('--sizes='));
const SIZES = sizesArg
  ? sizesArg.slice('--sizes='.length).split(',').map(Number)
  : [10_000, 100_000, 1_000_000];

function makeState(totalElements: number): AppState {
  // Square-ish 2D array shape; 3 variables from DEFAULT_STATE keep the run
  // representative (float dtypes, default pipelines).
  const side = Math.round(Math.sqrt(totalElements));
  return { ...DEFAULT_STATE, dataModel: 'array', shape: [side, side], chunkShape: [side, side] };
}

function heap(): number {
  (globalThis as { gc?: () => void }).gc?.();
  return process.memoryUsage().heapUsed;
}

function measure<T>(label: string, fn: () => T, rows: string[][]): T {
  const h0 = heap();
  const t0 = performance.now();
  const out = fn();
  const ms = performance.now() - t0;
  const dMB = (heap() - h0) / (1024 * 1024);
  rows.push([label, ms.toFixed(1), dMB.toFixed(1)]);
  return out;
}

for (const size of SIZES) {
  const state = makeState(size);
  const total = state.shape.reduce((a, b) => a * b, 1);
  console.log(`\n=== ${total.toLocaleString()} elements (shape ${state.shape.join('x')}, ${state.variables.length} variables) ===`);
  const rows: string[][] = [['stage', 'ms', 'heapΔ MB']];
  try {
    const values = measure('values', () => computeValuesStage(state.shape, state.variables), rows);
    const typed = measure('typed', () => computeTypedStage(state.shape, state.variables, values.variableValues), rows);
    const lin = measure('linearized', () => computeLinearizedStage(state.shape, state.chunkShape, state.interleaving, state.variables, typed.typedVariableValues), rows);
    const enc = measure('encoded', () => computeEncodedStage(lin.chunks, lin.linearizedChunks, state.interleaving, state.variables, state.fieldPipelines, state.chunkPipeline), rows);
    measure('metadata', () => computeMetadataStage(state, enc.encodedChunks, typed.variableStats), rows);
    const files = measure('write', () => computeFilesStage(state, enc.encodedChunks, typed.variableStats), rows);
    measure('read', () => computeReadStage(files.files, state.shape, state.variables, state.write.magicNumber), rows);
  } catch (err) {
    rows.push(['FAILED', String(err instanceof Error ? err.message : err), '']);
  }
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => (r[c] ?? '').length)));
  for (const r of rows) console.log(r.map((cell, c) => (cell ?? '').padEnd(widths[c] + 2)).join(''));
}
```

- [ ] **Step 2: Add the npm script**

In `package.json` `"scripts"`, add:

```json
"profile": "vite-node scripts/profile.ts"
```

- [ ] **Step 3: Run at small sizes and verify output**

Run: `npm run profile -- --sizes=10000,100000`
Expected: two tables with 7 stage rows each, non-zero ms values. Then run `NODE_OPTIONS=--expose-gc npm run profile` and record the full baseline (including a likely failure or multi-GB heap at 1,000,000 — paste the output into the commit message body; it is the Wall-1 evidence).

- [ ] **Step 4: Commit**

```bash
git add scripts/profile.ts package.json
git commit -m "feat: per-stage profiling harness (perf plan Task 1)"
```

---

## Phase B — Lazy traces (spec Pillar 1)

The layout module is built bottom-up (Tasks 2–6), wired in alongside the existing traces (Task 7), viewers converted (Tasks 8–9), and only then is the old path deleted (Task 10). The equivalence harness pins every byte at every stage to the current behavior.

### Task 2: Layout types, value-block layouts, `traceAt` + equivalence harness

**Files:**
- Create: `src/engine/layout.ts`
- Create: `src/__tests__/engine/layout.equivalence.test.ts`
- Create: `src/__tests__/helpers/equivalence.ts`

**Interfaces:**
- Consumes: `ByteTrace`, `ChunkRegion` from `src/types/pipeline.ts`; `getDtype`, `DtypeKey`, `LogicalValue` from `src/types/dtypes.ts`; `makeTraceId` from `src/engine/trace.ts`; `formatValue`, `formatLogicalValue` from `src/engine/elements.ts`; `flatIndexToCoords`, `coordsToFlatIndex` from `src/engine/chunk.ts`.
- Produces (used by every later task — exact signatures):

```typescript
export type ValueArray = LogicalValue[] | Float64Array;

export interface ValueBlockRegion {
  kind: 'values';
  start: number;              // byte offset in stage bytes
  byteLength: number;
  variableName: string;
  variableColor: string;
  dtype: string;              // ByteTrace.dtype label: 'float64'/'text' (Values/Read) or storage dtype (Typed)
  stride?: number;            // fixed-width bytes per element; undefined => use offsets
  offsets?: Uint32Array;      // text only: length N+1, cumulative byte offsets relative to start
  elementCount: number;
}

export interface ChunkFieldLayout {
  variableName: string;
  variableColor: string;
  dtype: string;
  size: number;               // dtype byte size
  offset: number;             // column: field block offset within chunk; row: offset within record
}

export interface ChunkBlockRegion {
  kind: 'chunk';
  start: number;
  byteLength: number;
  chunkId: string;            // 'chunk:'-prefixed, matches linearize.ts
  variableName: string;       // single-var (column) chunks; '' otherwise
  variableColor: string;      // '' when variableName is ''
  mode: 'value-preserving' | 'chunk-level';
  interleaving: 'row' | 'column';
  fields: ChunkFieldLayout[]; // value-preserving only; [] for chunk-level
  origin: number[];           // element-space origin: chunkCoords[d] * chunkShape[d]
  elementDims: number[];      // this chunk's (edge-clipped) element dims
}

export interface StructuralRegion {
  kind: 'structural';
  start: number;
  byteLength: number;
  traceId: string;            // 'magic:start' | 'magic:end' | 'metadata' | write.ts's chunk-index id
  label: string;              // ChunkRegion label (usually === traceId)
  byteInValueMode?: 'offset' | 'zero'; // reproduce the reference site's byteInValue rule (Task 5)
}

export type LayoutRegion = ValueBlockRegion | ChunkBlockRegion | StructuralRegion;

export interface StageLayout {
  byteLength: number;
  shape: number[];            // dataset shape (global flat index <-> coords)
  regions: LayoutRegion[];    // ordered, contiguous from byte 0
}

export interface ValueSources {
  values: Map<string, ValueArray>;   // per-variable arrays for displayValue
  format: 'logical' | 'typed';       // formatLogicalValue vs formatValue(v, dtype)
}

export function buildValueBlocksLayout(
  variables: { name: string; color: string }[],
  shape: number[],
  valuesByName: Map<string, ValueArray>,
  dtypeFor: (variableName: string) => string,   // 'float64'/'text' at Values/Read; storage dtype at Typed
): StageLayout;

export function regionAt(layout: StageLayout, byteIndex: number): LayoutRegion | null; // binary search
export function traceAt(layout: StageLayout, byteIndex: number, sources: ValueSources): ByteTrace | null;
```

- Also produces the shared test harness `src/__tests__/helpers/equivalence.ts`:

```typescript
/** Assert traceAt(layout, i, sources) deep-equals reference[i] for every byte. */
export function expectTraceEquivalence(
  layout: StageLayout, sources: ValueSources, reference: ByteTrace[],
): void;
```

- [ ] **Step 1: Write the failing equivalence tests**

`src/__tests__/helpers/equivalence.ts`:

```typescript
import { expect } from 'vitest';
import type { ByteTrace } from '../../types/pipeline.ts';
import { traceAt, type StageLayout, type ValueSources } from '../../engine/layout.ts';

export function expectTraceEquivalence(
  layout: StageLayout, sources: ValueSources, reference: ByteTrace[],
): void {
  expect(layout.byteLength).toBe(reference.length);
  for (let i = 0; i < reference.length; i++) {
    const got = traceAt(layout, i, sources);
    // One expect per byte would drown output; compare and report the first mismatch.
    if (JSON.stringify(got) !== JSON.stringify(reference[i])) {
      expect(got, `byte ${i}`).toEqual(reference[i]);
    }
  }
}
```

`src/__tests__/engine/layout.equivalence.test.ts` — Values/Typed/Read coverage. The reference traces come from the CURRENT stage functions (still trace-materializing at this point):

```typescript
import { describe, it, expect } from 'vitest';
import { DEFAULT_STATE } from '../../types/state.ts';
import { computeValuesStage, computeTypedStage } from '../../hooks/usePipeline.ts';
import { buildValueBlocksLayout, traceAt } from '../../engine/layout.ts';
import { expectTraceEquivalence } from '../helpers/equivalence.ts';

// A text variable exercises the variable-stride offsets path.
const TEXT_VAR = {
  ...DEFAULT_STATE.variables[0],
  id: 'label', name: 'label', color: '#c678dd',
  logicalType: { type: 'text', min: 0, max: 0, wordSet: 'names', generation: 'random' },
  typeAssignment: { storageDtype: 'char8' },
} as typeof DEFAULT_STATE.variables[0];

const CASES = [
  { name: 'default 3-var', state: DEFAULT_STATE },
  { name: 'with text var', state: { ...DEFAULT_STATE, variables: [...DEFAULT_STATE.variables, TEXT_VAR] } },
  { name: 'zero variables', state: { ...DEFAULT_STATE, variables: [] } },
];

describe('values-stage layout equivalence', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const values = computeValuesStage(c.state.shape, c.state.variables);
      const layout = buildValueBlocksLayout(
        c.state.variables, c.state.shape, values.variableValues,
        (name) => (values.variableValues.get(name) ?? []).some((v) => typeof v === 'string') ? 'text' : 'float64',
      );
      expectTraceEquivalence(layout, { values: values.variableValues, format: 'logical' }, values.stage.traces);
    });
  }
});

describe('typed-stage layout equivalence', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const values = computeValuesStage(c.state.shape, c.state.variables);
      const typed = computeTypedStage(c.state.shape, c.state.variables, values.variableValues);
      const layout = buildValueBlocksLayout(
        c.state.variables, c.state.shape, typed.typedVariableValues,
        (name) => c.state.variables.find((v) => v.name === name)!.typeAssignment.storageDtype,
      );
      expectTraceEquivalence(layout, { values: typed.typedVariableValues, format: 'typed' }, typed.stage.traces);
    });
  }
});

describe('traceAt bounds', () => {
  it('returns null out of range', () => {
    const values = computeValuesStage(DEFAULT_STATE.shape, DEFAULT_STATE.variables);
    const layout = buildValueBlocksLayout(DEFAULT_STATE.variables, DEFAULT_STATE.shape, values.variableValues, () => 'float64');
    const sources = { values: values.variableValues, format: 'logical' as const };
    expect(traceAt(layout, -1, sources)).toBeNull();
    expect(traceAt(layout, layout.byteLength, sources)).toBeNull();
  });
});
```

Adjust the `TEXT_VAR` literal to the actual `Variable`/`LogicalTypeConfig` types in `src/types/state.ts` (read them; the fields above are from the presets and `generate.ts` and may need `id`/optional-field tweaks to typecheck).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/engine/layout.equivalence.test.ts`
Expected: FAIL — `layout.ts` does not exist.

- [ ] **Step 3: Implement `src/engine/layout.ts`**

Types exactly as the Interfaces block above, plus:

```typescript
import type { ByteTrace } from '../types/pipeline.ts';
import type { DtypeKey, LogicalValue } from '../types/dtypes.ts';
import { getDtype } from '../types/dtypes.ts';
import { makeTraceId } from './trace.ts';
import { formatValue, formatLogicalValue } from './elements.ts';
import { flatIndexToCoords, coordsToFlatIndex } from './chunk.ts';

export function buildValueBlocksLayout(
  variables: { name: string; color: string }[],
  shape: number[],
  valuesByName: Map<string, ValueArray>,
  dtypeFor: (variableName: string) => string,
): StageLayout {
  const regions: LayoutRegion[] = [];
  let cursor = 0;
  for (const v of variables) {
    const vals = valuesByName.get(v.name) ?? [];
    const dtype = dtypeFor(v.name);
    if (dtype === 'text') {
      // Variable stride: mirror buildLogicalValuesStage — byteCount = str.length.
      const offsets = new Uint32Array(vals.length + 1);
      let acc = 0;
      for (let i = 0; i < vals.length; i++) {
        acc += String(vals[i]).length;
        offsets[i + 1] = acc;
      }
      regions.push({
        kind: 'values', start: cursor, byteLength: acc,
        variableName: v.name, variableColor: v.color,
        dtype: 'text', offsets, elementCount: vals.length,
      });
      cursor += acc;
    } else {
      const stride = getDtype(dtype as DtypeKey).size;
      const byteLength = vals.length * stride;
      regions.push({
        kind: 'values', start: cursor, byteLength,
        variableName: v.name, variableColor: v.color,
        dtype, stride, elementCount: vals.length,
      });
      cursor += byteLength;
    }
  }
  return { byteLength: cursor, shape, regions };
}

export function regionAt(layout: StageLayout, byteIndex: number): LayoutRegion | null {
  if (byteIndex < 0 || byteIndex >= layout.byteLength) return null;
  let lo = 0, hi = layout.regions.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = layout.regions[mid];
    if (byteIndex < r.start) hi = mid - 1;
    else if (byteIndex >= r.start + r.byteLength) lo = mid + 1;
    else return r;
  }
  return null;
}

function formatDisplay(value: LogicalValue | number, dtype: string, format: 'logical' | 'typed'): string {
  return format === 'logical' ? formatLogicalValue(value) : formatValue(value, dtype as DtypeKey);
}

/** Upper-bound binary search: largest i with offsets[i] <= rel. */
function offsetIndex(offsets: Uint32Array, rel: number): number {
  let lo = 0, hi = offsets.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= rel) lo = mid; else hi = mid - 1;
  }
  return lo;
}

export function traceAt(layout: StageLayout, byteIndex: number, sources: ValueSources): ByteTrace | null {
  const r = regionAt(layout, byteIndex);
  if (!r) return null;
  if (r.kind === 'values') {
    const rel = byteIndex - r.start;
    const arr = sources.values.get(r.variableName) ?? [];
    if (r.offsets) {
      const el = offsetIndex(r.offsets, rel);
      const coords = flatIndexToCoords(el, layout.shape);
      const str = String(arr[el]);
      return {
        traceId: makeTraceId(r.variableName, coords),
        variableName: r.variableName, variableColor: r.variableColor,
        coords, displayValue: str, dtype: r.dtype, chunkId: '',
        byteInValue: rel - r.offsets[el], byteCount: r.offsets[el + 1] - r.offsets[el],
      };
    }
    const stride = r.stride!;
    const el = Math.floor(rel / stride);
    const coords = flatIndexToCoords(el, layout.shape);
    return {
      traceId: makeTraceId(r.variableName, coords),
      variableName: r.variableName, variableColor: r.variableColor,
      coords, displayValue: formatDisplay(arr[el], r.dtype, sources.format),
      dtype: r.dtype, chunkId: '', byteInValue: rel % stride, byteCount: stride,
    };
  }
  // 'chunk' and 'structural' regions: implemented in Tasks 3–5.
  return null;
}
```

Compare the produced `ByteTrace` fields against `buildLogicalValuesStage`/`computeTypedStage` in `src/hooks/usePipeline.ts:48-204` and match them exactly (that is what the tests assert).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/engine/layout.equivalence.test.ts` → PASS. Then `npx vitest run` → all green.

- [ ] **Step 5: Commit**

```bash
git add src/engine/layout.ts src/__tests__/helpers/equivalence.ts src/__tests__/engine/layout.equivalence.test.ts
git commit -m "feat: layout descriptors + traceAt for value-block stages (perf plan Task 2)"
```

### Task 3: Linearized-stage layout (chunk regions, row + column)

**Files:**
- Modify: `src/engine/layout.ts`
- Modify: `src/__tests__/engine/layout.equivalence.test.ts`

**Interfaces:**
- Consumes: `Chunk`, `LinearizedChunk` from `src/types/pipeline.ts`; `linearizeChunk`/`buildTraces` behavior from `src/engine/linearize.ts` (reference); Task 2's types.
- Produces:

```typescript
/** Build the Linearized stage layout from the already-computed chunks.
 *  chunkShape is needed for origin computation; chunk element order must
 *  mirror chunkData/chunkDataPerVariable's sourceCoords enumeration. */
export function buildLinearizedLayout(
  chunks: Chunk[],
  linearizedChunks: LinearizedChunk[],
  interleaving: 'row' | 'column',
  shape: number[],
  chunkShape: number[],
): StageLayout;
```

and `traceAt` support for `kind: 'chunk'`, `mode: 'value-preserving'`.

- [ ] **Step 1: Add failing equivalence tests**

Append to `layout.equivalence.test.ts` a linearized describe block over a config matrix. Build each case's stages with the existing `computeValuesStage`/`computeTypedStage`/`computeLinearizedStage`, then:

```typescript
import { computeLinearizedStage } from '../../hooks/usePipeline.ts';
import { buildLinearizedLayout } from '../../engine/layout.ts';

const LINEARIZED_CASES = [
  { name: 'column single chunk', interleaving: 'column' as const, shape: [4, 8], chunkShape: [4, 8] },
  { name: 'column multi chunk', interleaving: 'column' as const, shape: [4, 8], chunkShape: [2, 4] },
  { name: 'column clipped edge chunks', interleaving: 'column' as const, shape: [5, 7], chunkShape: [2, 4] },
  { name: 'row multi chunk', interleaving: 'row' as const, shape: [4, 8], chunkShape: [2, 4] },
  { name: 'row clipped', interleaving: 'row' as const, shape: [5, 7], chunkShape: [2, 4] },
  { name: 'tabular 1d', interleaving: 'row' as const, shape: [13], chunkShape: [4] },
];

describe('linearized-stage layout equivalence', () => {
  for (const c of LINEARIZED_CASES) {
    it(c.name, () => {
      const state = { ...DEFAULT_STATE, shape: c.shape, chunkShape: c.chunkShape, interleaving: c.interleaving };
      const values = computeValuesStage(state.shape, state.variables);
      const typed = computeTypedStage(state.shape, state.variables, values.variableValues);
      const lin = computeLinearizedStage(state.shape, state.chunkShape, state.interleaving, state.variables, typed.typedVariableValues);
      const layout = buildLinearizedLayout(lin.chunks, lin.linearizedChunks, state.interleaving, state.shape, state.chunkShape);
      expectTraceEquivalence(layout, { values: typed.typedVariableValues, format: 'typed' }, lin.stage.traces);
    });
  }
});
```

Also add one case with a text (`char8`) variable in the variable list (fixed stride at this stage — charN is a fixed-size dtype), reusing `TEXT_VAR`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/__tests__/engine/layout.equivalence.test.ts`
Expected: new tests FAIL (`buildLinearizedLayout` not exported; chunk regions return null).

- [ ] **Step 3: Implement**

In `layout.ts`:

```typescript
export function buildLinearizedLayout(
  chunks: Chunk[],
  linearizedChunks: LinearizedChunk[],
  interleaving: 'row' | 'column',
  shape: number[],
  chunkShape: number[],
): StageLayout {
  const regions: LayoutRegion[] = [];
  let cursor = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const lc = linearizedChunks[i];
    const elementDims = chunk.coords.map((c, d) =>
      Math.min(chunkShape[d], shape[d] - c * chunkShape[d]));
    const origin = chunk.coords.map((c, d) => c * chunkShape[d]);
    const fields: ChunkFieldLayout[] = [];
    if (interleaving === 'column') {
      let fieldOffset = 0;
      for (const cv of chunk.variables) {
        const size = getDtype(cv.dtype as DtypeKey).size;
        fields.push({ variableName: cv.variableName, variableColor: cv.variableColor, dtype: cv.dtype, size, offset: fieldOffset });
        fieldOffset += size * cv.values.length;
      }
    } else {
      let rec = 0;
      for (const cv of chunk.variables) {
        const size = getDtype(cv.dtype as DtypeKey).size;
        fields.push({ variableName: cv.variableName, variableColor: cv.variableColor, dtype: cv.dtype, size, offset: rec });
        rec += size;
      }
    }
    const isSingleVar = interleaving === 'column' && chunk.variables.length === 1;
    regions.push({
      kind: 'chunk', start: cursor, byteLength: lc.bytes.length,
      chunkId: lc.chunkId,
      variableName: isSingleVar ? chunk.variables[0].variableName : '',
      variableColor: isSingleVar ? chunk.variables[0].variableColor : '',
      mode: 'value-preserving', interleaving, fields, origin, elementDims,
    });
    cursor += lc.bytes.length;
  }
  return { byteLength: cursor, shape, regions };
}

/** Chunk-local flat element index -> global coords. Must mirror the
 *  enumeration order chunkData/chunkDataPerVariable use for sourceCoords
 *  (row-major over elementDims) — the equivalence tests are the check. */
export function chunkElementCoords(origin: number[], elementDims: number[], elemFlat: number): number[] {
  const local = flatIndexToCoords(elemFlat, elementDims);
  return local.map((l, d) => origin[d] + l);
}
```

And in `traceAt`, replace the `return null` for chunk regions with the value-preserving branch:

```typescript
if (r.kind === 'chunk' && r.mode === 'value-preserving') {
  const rel = byteIndex - r.start;
  const elementCount = r.elementDims.reduce((a, b) => a * b, 1);
  let field: ChunkFieldLayout; let elemFlat: number; let byteInValue: number;
  if (r.interleaving === 'column') {
    // fields are consecutive blocks: find by offset range
    let f = r.fields.length - 1;
    while (f > 0 && rel < r.fields[f].offset) f--;
    field = r.fields[f];
    const fieldRel = rel - field.offset;
    elemFlat = Math.floor(fieldRel / field.size);
    byteInValue = fieldRel % field.size;
  } else {
    const recordSize = r.fields.reduce((a, f) => a + f.size, 0);
    elemFlat = Math.floor(rel / recordSize);
    const inRecord = rel % recordSize;
    let f = r.fields.length - 1;
    while (f > 0 && inRecord < r.fields[f].offset) f--;
    field = r.fields[f];
    byteInValue = inRecord - field.offset;
  }
  if (elemFlat >= elementCount) return null;
  const coords = chunkElementCoords(r.origin, r.elementDims, elemFlat);
  const arr = sources.values.get(field.variableName) ?? [];
  const globalFlat = coordsToFlatIndex(coords, layout.shape);
  return {
    traceId: makeTraceId(field.variableName, coords),
    variableName: field.variableName, variableColor: field.variableColor,
    coords, displayValue: formatDisplay(arr[globalFlat], field.dtype, sources.format),
    dtype: field.dtype, chunkId: r.chunkId,
    byteInValue, byteCount: field.size,
  };
}
```

Note `displayValue` in `linearize.ts` formats `cv.values[i]` (the chunk-local value) — identical to the global array at `globalFlat`; the tests verify.

- [ ] **Step 4: Run to verify pass**

`npx vitest run src/__tests__/engine/layout.equivalence.test.ts` → PASS (fix any element-order mismatch by reading `chunkData`/`chunkDataPerVariable` in `src/engine/chunk.ts` and matching their coord enumeration). Then full `npx vitest run` → green.

- [ ] **Step 5: Commit**

```bash
git add src/engine/layout.ts src/__tests__/engine/layout.equivalence.test.ts
git commit -m "feat: linearized-stage chunk layout + traceAt arithmetic (perf plan Task 3)"
```

### Task 4: Encoded-stage layout (value-preserving relabel + chunk-level)

**Files:**
- Modify: `src/engine/layout.ts`
- Modify: `src/__tests__/engine/layout.equivalence.test.ts`

**Interfaces:**
- Consumes: `CODEC_REGISTRY`, `outputDtypeFor` from `src/engine/codecs.ts`; `EncodedChunk` from `src/types/pipeline.ts`; Task 3's linearized layout.
- Produces:

```typescript
/** Per-chunk encoded layout: entropy anywhere in the chunk's pipeline =>
 *  chunk-level region over the encoded bytes; otherwise the linearized
 *  region re-based to the encoded offset with dtype labels relabeled to the
 *  pipeline's output dtype (same byte size — non-entropy codecs preserve
 *  dtype, mirroring propagateTracesValuePreserving's 1:1 copy). */
export function buildEncodedLayout(
  linearizedLayout: StageLayout,
  encodedChunks: { chunkId: string; bytes: Uint8Array }[],
  outputDtypes: string[],        // final pipeline output dtype per chunk, in chunk order
  chunkHasEntropy: boolean[],    // per chunk, in chunk order
): StageLayout;
```

and `traceAt` support for `mode: 'chunk-level'` — which must reproduce `degradeTracesToChunkLevel` exactly: `{ traceId: chunkId, variableName/-Color preserved only for single-var chunks, coords: [], displayValue: '', dtype: 'uint8', chunkId, byteInValue: 0, byteCount: 1 }`.

- [ ] **Step 1: Add failing equivalence tests**

Append an encoded describe block. Matrix (all with `shape: [4, 8]`, `chunkShape: [2, 4]`):

| case | interleaving | pipeline |
|---|---|---|
| no codecs | column | `[]` |
| delta | column | `[{codec:'delta', params:{order:1}}]` |
| shuffle | column | `[{codec:'shuffle', params:{elementSize:4}}]` |
| delta+shuffle | column | both |
| rle (entropy) | column | `[{codec:'rle', params:{}}]` |
| shuffle+lz | column | `[{codec:'shuffle',params:{elementSize:4}},{codec:'lz',params:{}}]` |
| row chunk pipeline rle | row | chunkPipeline `[{codec:'rle',params:{}}]` |

(Confirm codec keys/params against `CODEC_REGISTRY` in `src/engine/codecs.ts:285` before writing; adjust literals to the real `CodecStep` type in `src/types/codecs.ts`.) For column cases, set the pipeline on every variable id in `fieldPipelines`. Test body mirrors Task 3's but calls `computeEncodedStage` and compares against `encoded.stage.traces`, using:

```typescript
const outputDtypes = enc.encodedChunks.map((_, i) => /* run computeDtypeFlow equivalent: */
  state.interleaving === 'column'
    ? finalDtypeFor(stepsForChunk(i), inputDtypeForChunk(i))
    : finalDtypeFor(state.chunkPipeline, inputDtypeForChunk(i)));
```

Rather than re-deriving dtype flow in the test, export a helper from `layout.ts` in Step 3 (`encodedChunkMeta`, below) and call it from both the test and (in Task 7) `computeEncodedStage`. The test builds `buildEncodedLayout(linLayout, enc.encodedChunks, meta.outputDtypes, meta.hasEntropy)`.

- [ ] **Step 2: Run to verify failure**

`npx vitest run src/__tests__/engine/layout.equivalence.test.ts` → new tests FAIL.

- [ ] **Step 3: Implement**

In `layout.ts` (imports `CODEC_REGISTRY`, `outputDtypeFor` from `./codecs.ts`):

```typescript
export interface EncodedChunkMeta { outputDtype: string; hasEntropy: boolean }

/** Single source of truth for what a codec pipeline does to a chunk's
 *  tracing: final output dtype (via outputDtypeFor, per CLAUDE.md pitfall 3)
 *  and whether any entropy step degrades traces to chunk level. */
export function encodedChunkMeta(steps: CodecStep[], inputDtype: DtypeKey): EncodedChunkMeta {
  let dtype: DtypeKey = inputDtype;
  let hasEntropy = false;
  for (const step of steps) {
    const codec = CODEC_REGISTRY[step.codec];
    if (!codec) continue;
    if (codec.category === 'entropy') hasEntropy = true;
    dtype = outputDtypeFor(codec, dtype);
  }
  return { outputDtype: dtype, hasEntropy };
}

export function buildEncodedLayout(
  linearizedLayout: StageLayout,
  encodedChunks: { chunkId: string; bytes: Uint8Array }[],
  outputDtypes: string[],
  chunkHasEntropy: boolean[],
): StageLayout {
  const regions: LayoutRegion[] = [];
  let cursor = 0;
  linearizedLayout.regions.forEach((r, i) => {
    if (r.kind !== 'chunk') throw new Error('linearized layout must be all chunk regions');
    const encBytes = encodedChunks[i].bytes.length;
    if (chunkHasEntropy[i]) {
      regions.push({
        ...r, start: cursor, byteLength: encBytes,
        mode: 'chunk-level', fields: [],
      });
    } else {
      regions.push({
        ...r, start: cursor, byteLength: encBytes,
        fields: r.fields.map((f) => ({ ...f, dtype: outputDtypes[i] })),
      });
    }
    cursor += encBytes;
  });
  return { byteLength: cursor, shape: linearizedLayout.shape, regions };
}
```

`traceAt` chunk-level branch:

```typescript
if (r.kind === 'chunk' && r.mode === 'chunk-level') {
  return {
    traceId: r.chunkId,
    variableName: r.variableName, variableColor: r.variableColor,
    coords: [], displayValue: '', dtype: 'uint8', chunkId: r.chunkId,
    byteInValue: 0, byteCount: 1,
  };
}
```

- [ ] **Step 4: Run to verify pass**

`npx vitest run` → all green. If the delta case fails on `displayValue`: `propagateTracesValuePreserving` keeps the ORIGINAL value's display through delta — which is what the layout produces too (it formats from the typed value arrays, not the delta'd bytes). If shuffle fails on positions: current behavior does NOT permute traces (1:1 copy); the layout must not either. Investigate any mismatch against `runCodecPipeline` (`src/engine/codecs.ts:398-440`) before changing the layout code.

- [ ] **Step 5: Commit**

```bash
git add src/engine/layout.ts src/__tests__/engine/layout.equivalence.test.ts
git commit -m "feat: encoded-stage layout with chunk-level degradation (perf plan Task 4)"
```

### Task 5: Metadata + Write + Read layouts

**Files:**
- Modify: `src/engine/layout.ts` (metadata helper only)
- Modify: `src/engine/write.ts`
- Modify: `src/types/pipeline.ts` (`VirtualFile` gains `layout`)
- Modify: `src/__tests__/engine/layout.equivalence.test.ts`

**Interfaces:**
- Consumes: `assembleFiles(state, encodedChunks, chunkGrid, variableStats): VirtualFile[]` in `src/engine/write.ts`; encoded layout from Task 4.
- Produces:

```typescript
// layout.ts
export function buildMetadataLayout(byteLength: number): StageLayout;
// => { byteLength, shape: [], regions: byteLength > 0 ? [{ kind:'structural', start:0, byteLength, traceId:'metadata', label:'metadata' }] : [] }

// types/pipeline.ts
export interface VirtualFile {
  name: string;
  bytes: Uint8Array;
  traces: ByteTrace[];      // removed in Task 10
  layout: StageLayout;      // NEW — per-file regions
}
```

`assembleFiles` populates `VirtualFile.layout` as it concatenates: structural regions for magic start/end, metadata, and the chunk index (use the exact traceIds write.ts already emits — read `makeMagicTraces` at `src/engine/write.ts:388-410` and the chunk-index trace construction); chunk-data regions are the encoded layout's region for that chunk re-based to the file offset (copy the region object with a new `start`).

**Important:** metadata-stage traces built in `computeMetadataStage` (`usePipeline.ts:340-350`) set `byteInValue: i` and `byteCount: metaBytes.length`. The structural `traceAt` branch must reproduce whatever write.ts/metadata actually emit — check both sites and encode the rule per structural region (add an optional `byteInValueMode: 'offset' | 'zero'` field to `StructuralRegion` if the two sites differ; the equivalence tests decide).

- [ ] **Step 1: Add failing equivalence tests**

Metadata: compare `buildMetadataLayout(metaBytes.length)` lookups against `computeMetadataStage(...).stage.traces` for both serializations (`json`, `binary`).

Write: matrix over `{ partitioning: single|per-chunk } × { metadataPlacement: header|footer|sidecar } × { includeMetadata: true|false } × { includeChunkIndex: true|false }` with an entropy codec on one variable (mixed per-value + chunk-level traces in one file). For each `VirtualFile`, `expectTraceEquivalence(file.layout, typedSources, file.traces)`.

Read: on a config that reads successfully (includeMetadata true, header), build the read stage and compare `buildValueBlocksLayout(variables, shape, readValues, () => 'float64' | 'text')` against `read.stage.traces` (reuses Task 2's builder; sources = reconstructed values, format 'logical').

- [ ] **Step 2: Run to verify failure** — `npx vitest run` → new tests FAIL (no `layout` on VirtualFile).

- [ ] **Step 3: Implement**

Add `buildMetadataLayout` and the structural `traceAt` branch to `layout.ts`:

```typescript
if (r.kind === 'structural') {
  const rel = byteIndex - r.start;
  return {
    traceId: r.traceId, variableName: '', variableColor: '',
    coords: [], displayValue: r.label, dtype: 'uint8', chunkId: '',
    byteInValue: r.byteInValueMode === 'zero' ? 0 : rel,
    byteCount: r.byteLength,
  };
}
```

Then match field-by-field against the reference traces (magic traces, metadata traces, chunk-index traces in write.ts — e.g. if `displayValue` there is `''` or a label, mirror it; the equivalence tests are the contract). In `write.ts`, thread a running `cursor` through each file-assembly site (`assembleFiles` and its per-placement helpers around lines 139-260) and push regions alongside the existing `traces.push(...)` calls; for chunk data, take the Task 4 encoded region for that chunk and re-base: `{ ...encRegion, start: cursor }`. `assembleFiles` gains a parameter for the encoded layout regions (`encodedLayout: StageLayout`) — update its two callers (`computeFilesStage` in `usePipeline.ts`; check for others with `grep -rn "assembleFiles" src/`).

- [ ] **Step 4: Run to verify pass** — `npx vitest run` → all green.

- [ ] **Step 5: Commit**

```bash
git add src/engine/layout.ts src/engine/write.ts src/types/pipeline.ts src/hooks/usePipeline.ts src/__tests__/engine/layout.equivalence.test.ts
git commit -m "feat: metadata/write/read layouts; VirtualFile.layout (perf plan Task 5)"
```

### Task 6: Reverse lookups + region derivation + chunk membership

**Files:**
- Modify: `src/engine/layout.ts`
- Create: `src/__tests__/engine/layout.reverse.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5 layouts; `parseTraceId` from `src/engine/trace.ts`; `buildChunkRegions` from `src/components/viewers/viewerUtils.ts` (reference only, in tests).
- Produces:

```typescript
export interface ByteRange { start: number; end: number } // end exclusive

/** All byte ranges in this stage belonging to traceId (value, chunk, or structural). */
export function byteRangesForTrace(layout: StageLayout, traceId: string): ByteRange[];

/** Reproduces buildChunkRegions(traces) output from the layout alone. */
export function chunkRegionsOf(layout: StageLayout): ChunkRegion[];

/** Does element `coords` of `variableName` live in chunk `chunkId`? Pure math. */
export function elementInChunk(chunkId: string, variableName: string, coords: number[], chunkShape: number[]): boolean;

/** The chunkId containing element coords (mirrors linearize.ts id construction). */
export function chunkIdForElement(variableName: string, coords: number[], chunkShape: number[], interleaving: 'row' | 'column'): string;
```

- [ ] **Step 1: Write failing tests**

`layout.reverse.test.ts`:
- **byteRangesForTrace inverts traceAt** (property test): for each config in a reduced matrix (Task 3's column-multi, row-multi + Task 4's rle case + Task 5's single-file write case), for every byte i: `byteRangesForTrace(layout, traceAt(layout, i, sources)!.traceId)` includes i; and for every returned range, every byte in it has that traceId.
- **chunkRegionsOf equivalence:** `expect(chunkRegionsOf(layout)).toEqual(buildChunkRegions(stage.traces))` for values/linearized/encoded/write stages of the same matrix.
- **membership:** for the linearized layouts, for every element coords: `elementInChunk(chunkIdForElement(name, coords, chunkShape, interleaving), name, coords, chunkShape)` is true, and false for a neighboring chunk's id.

- [ ] **Step 2: Run to verify failure** — functions not exported.

- [ ] **Step 3: Implement**

`byteRangesForTrace`: `parseTraceId(traceId)`; chunk kind → the region(s) with matching `chunkId` (full range). Value kind → for each region: `values` region with matching variableName → one range from stride/offsets math; `chunk` value-preserving region containing the coords (`origin[d] <= coords[d] < origin[d]+elementDims[d]`, and a field for that variable) → compute the element's byte offset (invert Task 3's arithmetic: column `field.offset + localFlat*size`, row `localFlat*recordSize + field.offset`). Structural ids → matching structural regions. `chunkRegionsOf`: fold consecutive regions to `{label, startByte, endByte, byteCount}`, reproducing `buildChunkRegions`'s label/merging rules (read `viewerUtils.ts:buildChunkRegions` first; the test pins it). Membership helpers are `Math.floor(coords[d]/chunkShape[d])` + the linearize.ts id format.

- [ ] **Step 4: Run to verify pass** — `npx vitest run` → green.

- [ ] **Step 5: Commit**

```bash
git add src/engine/layout.ts src/__tests__/engine/layout.reverse.test.ts
git commit -m "feat: reverse trace lookup, chunkRegionsOf, chunk membership math (perf plan Task 6)"
```

### Task 7: Wire layouts into the pipeline stages (parallel to traces)

**Files:**
- Modify: `src/types/pipeline.ts` (`PipelineStage` gains `layout: StageLayout`)
- Modify: `src/hooks/usePipeline.ts` (every `compute*Stage` builds its layout; `makeStage` takes it; `chunkRegions` now from `chunkRegionsOf(layout)`)
- Create: `src/__tests__/hooks/pipelineLayouts.test.ts`

**Interfaces:**
- Consumes: all Task 2–6 builders. `computeEncodedStage` uses `encodedChunkMeta` per chunk (column: that variable's `fieldPipelines[id]` with the chunk variable's dtype; row: `chunkPipeline` with the same `inputDtype` fallback logic already at `usePipeline.ts:300-305`).
- Produces: `PipelineResult.stages[i].layout` populated for all 7 stages; `PipelineResult` additionally exposes `valueSourcesFor(stageName)` data — concretely, add to `PipelineResult`:

```typescript
export interface PipelineResult {
  // ...existing fields...
  /** Per-stage ValueSources for traceAt: values/read stages -> logicalValues
   *  (format 'logical'; read uses its reconstructed map), others -> typedValues
   *  (format 'typed'). */
  stageSources: Map<StageName, ValueSources>;
}
```

- [ ] **Step 1: Write failing test** — `pipelineLayouts.test.ts`: run `computePipelineStages(DEFAULT_STATE)`; assert every stage has `layout.byteLength === stage.bytes.length`, `stage.chunkRegions` deep-equals `chunkRegionsOf(stage.layout)`, and (spot check) `traceAt(stage.layout, 0, stageSources.get(name)!)` equals `stage.traces[0]` for each non-empty stage.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** — thread layouts through each stage function (Values/Typed/Read use `buildValueBlocksLayout`; Linearized `buildLinearizedLayout`; Encoded `buildEncodedLayout` + `encodedChunkMeta`; Metadata `buildMetadataLayout`; Write: `stage.layout` = concatenation of the per-file layouts re-based to the write-stage byte offsets (files are concatenated in order in `computeFilesStage`). `makeStage(name, bytes, traces, layout)` sets `chunkRegions: chunkRegionsOf(layout)` and keeps `traces` untouched. Build `stageSources` in `computePipelineStages` and the memoized hook. Read-failure stage: `layout = { byteLength: 0, shape: state.shape, regions: [] }`.

- [ ] **Step 4: Run all tests** — `npx vitest run` → green (the old `buildChunkRegions(traces)`-based values must equal the new derivation; Task 6 already pinned this).

- [ ] **Step 5: Commit**

```bash
git add src/types/pipeline.ts src/hooks/usePipeline.ts src/__tests__/hooks/pipelineLayouts.test.ts
git commit -m "feat: pipeline stages carry layouts; chunkRegions derived (perf plan Task 7)"
```

### Task 8: Convert the hex stack to lookups

**Files:**
- Modify: `src/components/viewers/useHexData.ts`, `src/components/viewers/HexView.tsx`, `src/components/viewers/HexRowRenderer.tsx`, `src/components/viewers/viewerUtils.ts`
- Modify: `src/state/PipelineContext.tsx` (expose `stageSources`)
- Test: existing `src/__tests__/viewers/*` + `node tests/ui/scenario-hover-linking.mjs`, `scenario-pane-defaults.mjs`

**Interfaces:**
- Consumes: `traceAt`, `byteRangesForTrace`, `chunkRegionsOf`, `StageLayout`, `ValueSources` (Tasks 2–7).
- Produces: `HexSection` carries `{ bytes, layout, sources }` instead of `traces`; add to `viewerUtils.ts`:

```typescript
/** TraceGroups intersecting [startByte, endByte) — replaces whole-stage
 *  groupBytesByTrace for hex row rendering. Walks bytes via traceAt but only
 *  within the window (~16 bytes/row * visible rows). */
export function traceGroupsInRange(
  layout: StageLayout, bytes: Uint8Array, sources: ValueSources,
  startByte: number, endByte: number,
): TraceGroup[];
```

- [ ] **Step 1: Read the three hex files end to end.** List every use of `section.traces` / `stage.traces` (per-byte trace for color/tooltip, `traceIndex`/`chunkIndex` maps for scroll-to-trace, `regionByByte`). Note: `useHexData.computeRegions` builds `regionByByte: Uint8Array` — O(bytes) but 1 byte/byte; keep it for now (cheap), derived from `chunkRegionsOf`.

- [ ] **Step 2: Convert.** Row rendering: for each visible row, `traceGroupsInRange(layout, bytes, sources, rowStart, rowStart+16)` supplies per-byte color/trace info previously read from `traces[i]`. Hover highlight: replace "does `traces[i].traceId === hoveredTraceId`" with membership via `byteRangesForTrace(layout, hoveredTraceId)` computed once per hover (memoized on `hoveredTraceId`), then per-byte range test. `traceIndex`/`chunkIndex` (scroll-to-offset for a hovered trace from the other pane): replace the Maps with `byteRangesForTrace(...)[0]?.start`. Chunk-level hover (`hoveredChunkId`): ranges via `byteRangesForTrace(layout, hoveredChunkId)`.

- [ ] **Step 3: Verify visually and with scenarios.** Run `npm run dev`, then `node tests/ui/scenario-hover-linking.mjs` and `node tests/ui/scenario-pane-defaults.mjs` → all PASS/KNOWN-FAIL, no new FAIL. Manually screenshot hex hover on Encoded stage with an RLE codec (chunk-level highlight) via a quick Playwright script if scenarios don't cover it.

- [ ] **Step 4: Run unit tests** — `npx vitest run` → green.

- [ ] **Step 5: Commit**

```bash
git add src/components/viewers src/state/PipelineContext.tsx
git commit -m "refactor: hex stack reads layouts, not materialized traces (perf plan Task 8)"
```

### Task 9: Convert FlatView, TableView, GridView, HoverBar; retire trace maps

**Files:**
- Modify: `src/components/viewers/FlatView.tsx`, `TableView.tsx`, `GridView.tsx`, `StagePane.tsx`, the hover bar component (find with `grep -rn "hover-bar" src/components`), `src/components/viewers/viewerUtils.ts`
- Modify: `src/state/PipelineContext.tsx` (drop `chunkTraceMap`/`traceChunkMap` from the context value)
- Test: `node tests/ui/scenario-hover-linking.mjs` + full scenario suite

**Interfaces:**
- Consumes: `elementInChunk`, `chunkIdForElement`, `byteRangesForTrace`, `traceGroupsInRange` (Tasks 6, 8).
- Produces: no component reads `stage.traces`, `chunkTraceMap`, or `traceChunkMap`. `PipelineContextValue` loses both maps (grep consumers first: `grep -rn "chunkTraceMap\|traceChunkMap" src/`).

- [ ] **Step 1: Read each consumer and convert:**
  - **FlatView** (renders one entry per trace group): group count and group-at-index are derivable per region (`values` region → `elementCount` groups; value-preserving chunk → `elementCount × fields.length`; chunk-level/structural → 1). Add to `viewerUtils.ts`: `flatGroupCount(layout): number` and `flatGroupAt(layout, bytes, sources, index): TraceGroup` (region-relative arithmetic mirroring Task 3/6 math), and virtualize over `flatGroupCount` — this removes the O(bytes) `groupBytesByTrace` walk entirely.
  - **TableView** (cell hover → highlight chunk membership): replace `traceChunkMap.get(traceId)` with `chunkIdForElement(name, coords, chunkShape, interleaving)`; replace `chunkTraceMap.get(chunkId).has(traceId)` with `elementInChunk(chunkId, name, coords, chunkShape)` (chunkShape/interleaving come from app state already in context or props).
  - **GridView**: same membership substitution (keep its existing non-virtualized rendering — canvas conversion is the Phase-4 plan).
  - **HoverBar**: displays the hovered trace's fields — it receives a traceId; resolve display via `traceAt(layout, byteRangesForTrace(layout, traceId)[0].start, sources)` from the currently-selected stage, or keep passing the already-resolved `ByteTrace` from the hovering component (preferred — hover setters already have it in hand from their own lookup).
  - **groupBytesByTrace**: after FlatView converts, delete it if unreferenced (`grep -rn "groupBytesByTrace" src/`).

- [ ] **Step 2: Run scenarios + tests.** `npx vitest run` green; full `node tests/ui/scenario-*.mjs` suite green (hover-linking especially — it exercises exactly this wiring).

- [ ] **Step 3: Commit**

```bash
git add src/components src/state/PipelineContext.tsx
git commit -m "refactor: all viewers on layout lookups; chunk maps retired (perf plan Task 9)"
```

### Task 10: Delete materialized traces; preserve the reference tracer for tests

**Files:**
- Create: `src/__tests__/helpers/referenceTraces.ts` (verbatim copies of the deleted trace-building code)
- Modify: `src/hooks/usePipeline.ts`, `src/engine/linearize.ts`, `src/engine/codecs.ts`, `src/engine/write.ts`, `src/engine/trace.ts`, `src/types/pipeline.ts`
- Modify: `src/__tests__/engine/layout.equivalence.test.ts` (reference now imported from the helper)
- Modify: `CLAUDE.md` (pitfall #1: same semantics, new representation)

**Interfaces:**
- Produces: `PipelineStage`/`LinearizedChunk`/`EncodedChunk`/`VirtualFile` have **no `traces` field**; `runCodecPipeline` signature becomes `runCodecPipeline(inputBytes, steps, inputDtype): { bytes, outputDtype }` (drop `inputTraces` and the per-step `stages` array — no external consumers, verified); `buildTraces`, `propagateTracesValuePreserving`, `degradeTracesToChunkLevel`, `buildLogicalValuesStage`'s trace loop, `makeMagicTraces`, and `buildChunkRegions` move (copied, then deleted from src) into `referenceTraces.ts` which exports `referenceStageTraces(state): Map<StageName, ByteTrace[]>` built the old way.
- The equivalence tests keep running forever at small sizes against the reference helper — that's the permanent pin.

- [ ] **Step 1: Copy before deleting.** Assemble `referenceTraces.ts` from the current implementations (it may import engine pure functions like `valuesToBytes`/`formatValue` but must not import anything being deleted). Rewire `layout.equivalence.test.ts` + `layout.reverse.test.ts` to use it, run `npx vitest run` → green while production traces still exist (proves the copy is faithful).

- [ ] **Step 2: Delete.** Remove `traces` fields and all trace-building code paths from production files; fix compile errors (`tsc -b` is part of `npm run build`). `isChunkLevelTrace`/`parseTraceId`/`makeTraceId`/`makeChunkTraceId` STAY in `trace.ts` (layout.ts and viewers use them).

- [ ] **Step 3: Verify.** `npx vitest run` green; `npm run build` clean; full scenario suite green against dev server.

- [ ] **Step 4: Measure.** `NODE_OPTIONS=--expose-gc npm run profile` — record the new table in the commit message. Expected: heap collapse at 100K (traces gone); 1M likely completes now (chunk `sourceCoords`/`values` arrays remain — that's fine, they're bounded, and Phase-4 planning gets these numbers).

- [ ] **Step 5: Update CLAUDE.md pitfall #1** — one sentence noting traces are now computed on demand from `StageLayout` via `src/engine/layout.ts` (semantics unchanged: per-value everywhere, chunk-level after entropy codecs).

- [ ] **Step 6: Commit**

```bash
git add -A src docs CLAUDE.md
git commit -m "refactor!: delete materialized per-byte traces; layouts only (perf plan Task 10)"
```

### Task 11: Typed value arrays

**Files:**
- Modify: `src/hooks/usePipeline.ts` (`variableValues`/`typedVariableValues` become `ValueArray`), `src/engine/generate.ts` (`generateValues` returns `Float64Array` for numeric logical types, `string[]` for text), `src/engine/typeAssign.ts` + `src/engine/elements.ts` (`bytesToValues` returns typed arrays for numeric dtypes), `src/engine/read.ts` (reconstructed values), plus compile-error fallout (`tsc -b`).
- Test: existing engine tests (update return-type assertions), `src/__tests__/engine/*`

**Interfaces:**
- Produces: `PipelineResult.logicalValues`/`typedValues` are `Map<string, ValueArray>` (`ValueArray` from Task 2). All consumers already index positionally; `Array.isArray(x)` distinguishes text where needed.

- [ ] **Step 1:** Change `generateValues` numeric paths to fill a `Float64Array`; run `npx vitest run` and fix type fallout mechanically (assertions like `.toEqual([1,2,3])` on typed arrays need `Array.from(...)`).
- [ ] **Step 2:** Same for `bytesToValues` (numeric dtypes → appropriate typed array or `Float64Array` — keep it `Float64Array` uniformly for simplicity of `ValueArray`) and `read.ts` reconstruction.
- [ ] **Step 3:** `npx vitest run` green; `npm run build` clean; scenario suite green.
- [ ] **Step 4: Commit** — `git add -A src && git commit -m "perf: numeric value arrays as Float64Array (perf plan Task 11)"`

---

## Phase C — Worker compute + build-info/About + service worker (spec Pillar 2)

### Task 12: Worker protocol, worker entry, coalescing client

**Files:**
- Create: `src/worker/protocol.ts`, `src/worker/pipeline.worker.ts`, `src/worker/client.ts`
- Create: `src/__tests__/worker/client.test.ts`

**Interfaces:**
- Consumes: `computePipelineStages(state): PipelineResult` (pure, from Task 10's usePipeline.ts); `AppState`.
- Produces:

```typescript
// protocol.ts
export interface ComputeRequest { kind: 'compute'; id: number; state: AppState }
export type WorkerRequest = ComputeRequest;
export type StageTimings = Partial<Record<StageName, number>>; // ms per stage
export interface ProgressMsg { kind: 'progress'; id: number; stage: StageName }
export interface ResultOk { kind: 'result'; id: number; ok: true; result: PipelineResult; timings: StageTimings; totalMs: number }
export interface ResultErr { kind: 'result'; id: number; ok: false; error: string }
export type WorkerResponse = ProgressMsg | ResultOk | ResultErr;

/** Every ArrayBuffer reachable from the result, deduped — the transfer list. */
export function collectTransferables(result: PipelineResult): ArrayBuffer[];

// client.ts
export interface WorkerDiagnostics {
  status: 'idle' | 'computing' | 'crashed';
  respawnCount: number;
  lastTimings: StageTimings | null;
  lastTotalMs: number | null;
  lastError: string | null;
}
export interface WorkerLike { // structural subset of Worker, for test fakes
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message' | 'error', fn: (e: any) => void): void;
  terminate(): void;
}
export class PipelineWorkerClient {
  constructor(opts: {
    createWorker: () => WorkerLike;
    onResult: (result: PipelineResult, diag: WorkerDiagnostics) => void;
    onStatus?: (diag: WorkerDiagnostics) => void;
    watchdogMs?: number;             // default 10_000
  });
  compute(state: AppState): void;    // latest-wins; superseded queued states are dropped
  diagnostics(): WorkerDiagnostics;
  dispose(): void;
}
export function createPipelineWorker(): Worker; // new Worker(new URL('./pipeline.worker.ts', import.meta.url), { type: 'module' })
```

- [ ] **Step 1: Write failing client tests** with a `FakeWorker` implementing `WorkerLike` (records posted messages; test triggers `message`/`error` events manually):

```typescript
import { describe, it, expect, vi } from 'vitest';
import { PipelineWorkerClient, type WorkerLike } from '../../worker/client.ts';
import { DEFAULT_STATE } from '../../types/state.ts';

class FakeWorker implements WorkerLike {
  posted: any[] = [];
  listeners: Record<string, ((e: any) => void)[]> = { message: [], error: [] };
  terminated = false;
  postMessage(msg: unknown) { this.posted.push(msg); }
  addEventListener(type: 'message' | 'error', fn: (e: any) => void) { this.listeners[type].push(fn); }
  terminate() { this.terminated = true; }
  emitResult(id: number) { this.listeners.message.forEach((f) => f({ data: { kind: 'result', id, ok: true, result: {} as any, timings: {}, totalMs: 1 } })); }
  emitError(msg: string) { this.listeners.error.forEach((f) => f({ message: msg })); }
}

describe('PipelineWorkerClient coalescing', () => {
  it('posts immediately when idle', () => {
    const w = new FakeWorker();
    const c = new PipelineWorkerClient({ createWorker: () => w, onResult: () => {} });
    c.compute(DEFAULT_STATE);
    expect(w.posted).toHaveLength(1);
  });
  it('queues while busy and posts only the LAST queued state on result', () => {
    const w = new FakeWorker();
    const onResult = vi.fn();
    const c = new PipelineWorkerClient({ createWorker: () => w, onResult });
    c.compute(DEFAULT_STATE);                                        // in flight (id 1)
    c.compute({ ...DEFAULT_STATE, interleaving: 'row' });            // queued
    c.compute({ ...DEFAULT_STATE, interleaving: 'column' });         // overwrites queue
    expect(w.posted).toHaveLength(1);
    w.emitResult(w.posted[0].id);
    expect(onResult).toHaveBeenCalledTimes(1);                       // superseded result still published
    expect(w.posted).toHaveLength(2);                                // exactly one follow-up
    expect(w.posted[1].state.interleaving).toBe('column');
  });
  it('respawns on worker error and reposts the newest state', () => {
    const workers: FakeWorker[] = [];
    const c = new PipelineWorkerClient({ createWorker: () => { const w = new FakeWorker(); workers.push(w); return w; }, onResult: () => {} });
    c.compute(DEFAULT_STATE);
    workers[0].emitError('boom');
    expect(workers[0].terminated).toBe(true);
    expect(c.diagnostics().respawnCount).toBe(1);
    expect(workers).toHaveLength(2);                                 // respawned + reposted
    expect(workers[1].posted).toHaveLength(1);
  });
  it('watchdog terminates a stuck compute when newer state is queued', () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const c = new PipelineWorkerClient({ createWorker: () => { const w = new FakeWorker(); workers.push(w); return w; }, onResult: () => {}, watchdogMs: 1000 });
    c.compute(DEFAULT_STATE);
    c.compute({ ...DEFAULT_STATE, interleaving: 'row' });            // queued
    vi.advanceTimersByTime(1001);
    expect(workers[0].terminated).toBe(true);
    expect(workers[1].posted[0].state.interleaving).toBe('row');
    vi.useRealTimers();
  });
  it('ignores stale results (id mismatch after respawn)', () => {
    const workers: FakeWorker[] = [];
    const onResult = vi.fn();
    const c = new PipelineWorkerClient({ createWorker: () => { const w = new FakeWorker(); workers.push(w); return w; }, onResult });
    c.compute(DEFAULT_STATE);
    const staleId = workers[0].posted[0].id;
    workers[0].emitError('boom');
    workers[0].emitResult(staleId);   // late message from the dead worker
    expect(onResult).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.**

`protocol.ts` as specified; `collectTransferables` walks `result.stages[].bytes.buffer`, `result.files[].bytes.buffer`, and every `Float64Array`/`Uint32Array` in value maps and layout offsets, deduping via a `Set<ArrayBuffer>` (skip buffers that appear under two views — dedupe handles it).

`pipeline.worker.ts`:

```typescript
import { computePipelineStages } from '../hooks/usePipeline.ts';
import { collectTransferables, type WorkerRequest, type WorkerResponse, type StageTimings } from './protocol.ts';

// Whole-pipeline recompute per message; Task 13 adds per-stage memoization
// inside computePipelineStages (spec: metadata keystrokes must not re-run codecs).
self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.kind !== 'compute') return;
  const timings: StageTimings = {};
  const t0 = performance.now();
  try {
    const result = computePipelineStages(msg.state, (stage, ms) => {
      timings[stage] = ms;
      (self as unknown as Worker).postMessage({ kind: 'progress', id: msg.id, stage } satisfies WorkerResponse);
    });
    (self as unknown as Worker).postMessage(
      { kind: 'result', id: msg.id, ok: true, result, timings, totalMs: performance.now() - t0 } satisfies WorkerResponse,
      collectTransferables(result),
    );
  } catch (err) {
    (self as unknown as Worker).postMessage(
      { kind: 'result', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies WorkerResponse);
  }
};
```

`computePipelineStages` gains an optional `onStage?: (stage: StageName, ms: number) => void` parameter (wrap each stage call with `performance.now()` bracketing; no behavior change when omitted).

`client.ts`: fields `worker | null`, `inFlight: { id, state } | null`, `queued: AppState | null`, `nextId`, `respawnCount`, watchdog timer. `compute()`: if `inFlight` → `queued = state`; else post + arm watchdog. On `result` message: ignore unless `id === inFlight.id`; clear watchdog; update diagnostics; call `onResult`; if `queued` → post it. On `error` or watchdog fire (with `queued ?? inFlight.state`): terminate, `respawnCount++`, recreate via `createWorker()` on next post, repost newest state. Every transition calls `onStatus`.

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/__tests__/worker/client.test.ts` then full suite.

- [ ] **Step 5: Commit**

```bash
git add src/worker src/__tests__/worker src/hooks/usePipeline.ts
git commit -m "feat: pipeline worker protocol + latest-wins client (perf plan Task 12)"
```

### Task 13: Worker-backed usePipeline + recompute indicator

**Files:**
- Create: `src/hooks/useWorkerPipeline.ts`
- Modify: `src/components/layout/App.tsx` (swap `usePipeline` → `useWorkerPipeline`; null-result boot state), `src/state/PipelineContext.tsx` (accept `computing` + `diagnostics`), `src/components/layout/PipelineStrip.tsx` (indicator)
- Test: `src/__tests__/hooks/useWorkerPipeline.test.ts` (with FakeWorker via injected factory); scenario suite

**Interfaces:**
- Consumes: Task 12's client.
- Produces:

```typescript
export function useWorkerPipeline(
  state: AppState,
  createWorker?: () => WorkerLike,      // test injection; defaults to createPipelineWorker
): { result: PipelineResult | null; computing: boolean; diagnostics: WorkerDiagnostics };
```

`PipelineContextValue` gains `computing: boolean`; App passes `diagnostics` down to `Header` as a prop (for Task 14's About modal).

- [ ] **Step 1: Failing hook test** (`@testing-library/react` `renderHook`): initial `{result: null, computing: true}`; after FakeWorker emits a result → `result` set, `computing` false; state change → `computing` true again; last-good result retained while computing (stale-view contract).

- [ ] **Step 2: Implement.** Client in a `useRef` (created once with `onResult`/`onStatus` updating React state via `useState`); `useEffect([state])` → `client.compute(state)`; dispose on unmount. In `App.tsx`, when `result === null` render a minimal centered "starting…" div (theme colors) instead of the pane tree; `PipelineStrip` renders a small pulsing dot + "recomputing" label (testid `pipeline-computing-indicator`) when `computing` — subtle, no layout shift (reserve the space).

- [ ] **Step 2b: Worker-side stage memoization.** Replace the direct `computePipelineStages` export used by the worker with a stateful wrapper so a metadata keystroke does not re-run generation/typing/chunking/encoding (the spec's requirement; same dependency boundaries as the deleted `useMemo` chain, documented per-stage in `usePipeline.ts`):

```typescript
// usePipeline.ts
/** Stateful pipeline computer: caches each stage's output keyed by a JSON
 *  string of exactly the state slices that stage reads (the per-stage dep
 *  lists documented above each compute*Stage). One instance lives for the
 *  worker's lifetime. */
export function createPipelineComputer(): (state: AppState, onStage?: (s: StageName, ms: number) => void) => PipelineResult {
  const cache = new Map<StageName, { key: string; value: unknown }>();
  const memo = <T>(stage: StageName, deps: unknown, fn: () => T): T => {
    const key = JSON.stringify(deps);
    const hit = cache.get(stage);
    if (hit && hit.key === key) return hit.value as T;
    const value = fn();
    cache.set(stage, { key, value });
    return value;
  };
  return (state, onStage) => { /* same composition as computePipelineStages,
    each stage wrapped: memo('values', { shape: state.shape, variables: state.variables }, () => ...)
    etc. Downstream stages include the upstream memo KEY in their deps so an
    upstream change invalidates them (values key ⊂ typed deps ⊂ linearized deps ...).
    onStage timing brackets only run on cache misses; report ms 0 for hits. */ };
}
```

Add a vitest case: two consecutive calls where only `state.metadata.customEntries` changes → the returned `stages[0..3]` (values→encoded) are reference-identical (`toBe`) across calls; changing `state.shape` invalidates everything. The worker (`pipeline.worker.ts`) constructs one computer at module scope and calls it per message.

- [ ] **Step 3: Verify.** `npx vitest run` green. Dev server: confirm app boots, edits update, indicator pulses on shape change at a large-ish size (e.g. shape 300×300). Full scenario suite green — **the scenarios are the real gate here** (they exercise the whole UI against the now-async pipeline; expect and fix timing assumptions in scenarios only by waiting on `pipeline-computing-indicator` disappearing, added to `scenario-helpers.mjs` as `await waitForPipelineIdle(page)`).

- [ ] **Step 4: Commit**

```bash
git add src/hooks src/components src/state tests/ui/scenario-helpers.mjs src/__tests__/hooks
git commit -m "feat: worker-backed pipeline with stale-view recompute UX (perf plan Task 13)"
```

### Task 14: build-info + About modal

**Files:**
- Create: `scripts/get-git-info.js` (port from por-que, adjusted paths), `src/build-info.d.ts`, `src/components/layout/AboutModal.tsx`
- Modify: `package.json` (`predev`/`prebuild`), `.gitignore` (`src/build-info.js`), `src/components/layout/Header.tsx` (ⓘ button + modal state + diagnostics prop)
- Test: `src/__tests__/components/aboutModal.test.tsx`

**Interfaces:**
- Consumes: `WorkerDiagnostics` (Task 12), `BUILD_INFO: { commit: string; buildTime: string }`.
- Produces: `<AboutModal open onClose diagnostics elementCount />`; testids `about-button`, `about-modal`, `about-performance-toggle`.

- [ ] **Step 1: Port the script.** Copy por-que's `scripts/get-git-info.js` verbatim (it already handles missing git gracefully); add `"predev": "node scripts/get-git-info.js"` and `"prebuild": "node scripts/get-git-info.js"` to package.json scripts; add `src/build-info.js` to `.gitignore`; create `src/build-info.d.ts`:

```typescript
export declare const BUILD_INFO: { commit: string; buildTime: string };
```

Run `node scripts/get-git-info.js` once and verify `src/build-info.js` appears with a commit hash.

- [ ] **Step 2: Failing component test** — renders `AboutModal` with fake diagnostics; asserts commit text visible, performance section content NOT in the document until `about-performance-toggle` is clicked, then per-stage timings visible.

- [ ] **Step 3: Implement.** `AboutModal`: fixed-position overlay + centered panel (theme colors/spacing; close on overlay click and Escape). Body: app name, `BUILD_INFO.commit` (+title `Built ${buildTime}`), GitHub link (`https://github.com/jkeifer/0x00c0dec5` — verify the actual repo URL with `git remote get-url origin` and use that). Below, a `<details>`-style expandable (button + conditional block, collapsed default) labeled "Performance": worker status, respawn count, last total ms, per-stage ms table from `diagnostics.lastTimings`, element count (`shape product × variables.length` from app state), last error if any. `Header.tsx`: small ⓘ button (reuse `headerButtonStyle`), `useState` for open, renders the modal; diagnostics arrive via prop from App (Task 13).

- [ ] **Step 4: Verify** — `npx vitest run` green; dev server: modal opens, commit shows, section expands. Update CLAUDE.md's data-testid list (three new ids).

- [ ] **Step 5: Commit**

```bash
git add scripts/get-git-info.js src/build-info.d.ts src/components/layout package.json .gitignore CLAUDE.md src/__tests__/components
git commit -m "feat: build-info + About modal with collapsed worker diagnostics (perf plan Task 14)"
```

### Task 15: Service worker

**Files:**
- Create: `public/sw.js`
- Modify: `src/main.tsx` (registration), `docs/design.md` or `docs/architecture.md` (one paragraph: SW caching + invalidation model)

**Interfaces:**
- Consumes: `BUILD_INFO.commit` (Task 14).
- Produces: production-only offline cache, versioned `0xc-<commit>`.

- [ ] **Step 1: Port `public/sw.js`** from por-que's `static/sw.js` with: cache prefix `0xc-`; `CACHEABLE_ORIGINS = [self.location.origin]`; network-first for `request.mode === 'navigate'` (no manifest.json special case — delete that clause); everything else same-origin cache-first. Keep the header comment explaining WHY navigations are network-first (pinned-build bug).

- [ ] **Step 2: Register in `src/main.tsx`:**

```typescript
import { BUILD_INFO } from './build-info.js';

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js?v=${BUILD_INFO.commit}`)
      .catch((err: unknown) => console.warn('Service worker registration failed:', err));
  });
}
```

- [ ] **Step 3: Verify.** `npm run build` → `dist/sw.js` exists. `npx vite preview`, open the app, DevTools → Application → Service Workers shows it active with the `?v=` param; reload with DevTools offline → app still loads. Verify dev mode does NOT register (PROD gate).

- [ ] **Step 4: Commit**

```bash
git add public/sw.js src/main.tsx docs
git commit -m "feat: offline service worker with commit-versioned cache (perf plan Task 15)"
```

### Task 16: Playwright regression scenarios for the new surface

**Files:**
- Create: `tests/ui/scenario-worker-pipeline.mjs`
- Modify: `CLAUDE.md` (scenario list)

**Interfaces:**
- Consumes: `scenario-helpers.mjs` (`launch`, `check`, `seedStateAndReload`, Task 13's `waitForPipelineIdle`), testids from Tasks 13–14.
- Produces: a standing scenario, PASS/FAIL semantics per the harness.

- [ ] **Step 1: Write the scenario** covering: (a) app boots to idle (indicator absent) with default state; (b) changing a sidebar input shows then clears `pipeline-computing-indicator`; (c) About modal: opens, shows a commit string, performance section collapsed → expands with worker status text; (d) **large-tabular smoke**: `seedStateAndReload` with a tabular state of shape `[250000]` and 3 numeric variables, `waitForPipelineIdle` (generous timeout), assert no `pageerror`, table renders rows, hovering a table cell highlights hex bytes (existing hover-linking assertions pattern), byte counts in the pipeline strip show multi-MB sizes. Keep the array model modest here (GridView is still DOM until the Phase-4 plan).

- [ ] **Step 2: Run against dev server** — `node tests/ui/scenario-worker-pipeline.mjs` → all PASS; then the whole scenario suite → green.

- [ ] **Step 3: Rerun the profiler** (`NODE_OPTIONS=--expose-gc npm run profile`) and record final Phase 1–3 numbers in the commit body — these gate the Phase 4–5 follow-up plan.

- [ ] **Step 4: Commit**

```bash
git add tests/ui/scenario-worker-pipeline.mjs CLAUDE.md
git commit -m "test: worker-pipeline + About-modal regression scenario (perf plan Task 16)"
```

---

## Deferred to the follow-up plan (spec Phases 4–5)

Canvas GridView, hex overview + windowed jump navigation, LZ hash-chain rewrite, generation fast path, soft element cap + banner. All are gated on Task 16's profiling numbers; plan them once those exist.
