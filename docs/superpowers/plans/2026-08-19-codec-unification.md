# Codec Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make value transforms (quantize, bitround, scale-offset) first-class codecs in the one registry, shrink `Variable.typeAssignment` to `{ storageDtype }`, support fixed-ratio (element-width-changing) codecs through layout/tracing/read, and activate each field pipeline's element-structured prefix in row interleaving.

**Architecture:** Everything is a bytes codec; the stride comes from `inputDtype` (delta/zigzag already prove the interface). New `CodecDefinition` metadata (`sizeEffect`, optional `outputDtype(inputDtype, params)`, `expects`, optional encode `stats`) makes the dtype/size flow derivable per-codec instead of hardcoded. Row mode hoists each field pipeline's maximal element-structured prefix to run per-variable before interleaving (implemented inside the Encoded stage — equivalent to strided execution since interleave order is element order).

**Tech Stack:** React + TypeScript + Vite, vitest for engine tests, Playwright scenario scripts for UI.

**Spec:** `docs/superpowers/specs/2026-08-19-codec-unification-design.md`

## Global Constraints

- Engine layer (`src/engine/`) must be tested and correct before UI work (CLAUDE.md cardinal rule).
- Unit tests go in `tests/unit/` (never in `src/`). Run with `npx vitest run`.
- No state migrations: old persisted states carrying removed fields are DROPPED (`migrateState` returns `null`), per standing policy.
- Components never call engine compute directly (CLAUDE.md pitfall 8) — new UI data comes through the worker payload.
- Inline styles from `src/theme.ts`; no CSS libs.
- Presets are GENERATED: edit `scripts/gen-presets.ts` and run `npx tsx scripts/gen-presets.ts` — never hand-edit `src/presets/*.json`.
- Advisory-only warnings: codec applicability never blocks or filters the picker (design.md "Codec Applicability and Warnings").
- Commit after each task; messages end with the Claude co-author line per repo convention.

## Design deviations from the spec (agreed rationale, encode in code comments)

1. **`type_assignments` metadata entry is DELETED entirely**, not shrunk to `{storageDtype}`: after the shrink it would duplicate `schema` (which already carries per-variable dtype) — the metadata redesign's "every entry must be one the reader actually uses" principle (the `chunk_grid` deletion precedent). `reverseTypeAssignment`/`reverseTypeAssignmentValues` are deleted with it (a bare-cast reversal is a no-op on already-decoded values).
2. **Codec `encode`/`decode` gain an optional `byteOrder` 4th arg.** Transforms interpret bytes as values, so unlike delta (byte-wise modular) they must honor the file's endianness. Existing codecs ignore the arg.
3. **scale-offset carries a `sourceDtype` param** (numcodecs `FixedScaleOffset(dtype, astype)` precedent): `decode` only receives the encoded dtype + params, so the pre-step dtype must live in params. The editor seeds it from the running dtype at add time (the `elementSize` seeding precedent).

---

### Task 1: Codec metadata & params-aware dtype flow

**Files:**
- Modify: `src/types/codecs.ts` (CodecDefinition)
- Modify: `src/engine/codecs.ts` (registry entries, `outputDtypeFor`, `computeDtypeFlow`, `stepWarnings`; new `pipelineOutputDtype`, `encodedByteLength`)
- Modify: `src/engine/decode.ts:29`, `src/engine/layout.ts:217`, `src/engine/read.ts:509` (pass `step.params`)
- Modify: `src/components/config/CodecPipelineEditor.tsx:46` (pass `step.params`)
- Test: `tests/unit/engine/codecs.test.ts`

**Interfaces:**
- Consumes: existing `CodecDefinition`, `CodecStep`.
- Produces (later tasks rely on these exact signatures):
  - `CodecDefinition.category: 'transform' | 'reordering' | 'entropy'`
  - `CodecDefinition.sizeEffect: 'preserving' | 'fixed-ratio' | 'variable'` (required)
  - `CodecDefinition.expects?: string`
  - `CodecDefinition.outputDtype?: (inputDtype: DtypeKey, params: Record<string, number | string>) => DtypeKey`
  - `CodecDefinition.encode` return gains `stats?: { clipped: number; rounded: number }`
  - `outputDtypeFor(codec: CodecDefinition, inputDtype: DtypeKey, params: Record<string, number | string>): DtypeKey`
  - `pipelineOutputDtype(steps: CodecStep[], inputDtype: DtypeKey): DtypeKey` (exported; walks active steps)
  - `encodedByteLength(steps: CodecStep[], inputDtype: DtypeKey, rawLength: number): number | null` (null = a `variable`-size step makes it underivable)

- [ ] **Step 1: Write failing tests** in `tests/unit/engine/codecs.test.ts` (new `describe('codec metadata & dtype flow', ...)`):

```ts
import { CODEC_REGISTRY, outputDtypeFor, pipelineOutputDtype, encodedByteLength } from '../../../src/engine/codecs.ts';

describe('codec metadata & dtype flow', () => {
  it('every codec declares a sizeEffect', () => {
    for (const codec of Object.values(CODEC_REGISTRY)) {
      expect(['preserving', 'fixed-ratio', 'variable']).toContain(codec.sizeEffect);
    }
  });
  it('entropy codecs are variable-size; reordering codecs preserve size', () => {
    expect(CODEC_REGISTRY['rle'].sizeEffect).toBe('variable');
    expect(CODEC_REGISTRY['zstd'].sizeEffect).toBe('variable');
    expect(CODEC_REGISTRY['dictionary'].sizeEffect).toBe('variable');
    expect(CODEC_REGISTRY['delta'].sizeEffect).toBe('preserving');
    expect(CODEC_REGISTRY['byte-shuffle'].sizeEffect).toBe('preserving');
  });
  it('outputDtypeFor takes params and defers to a codec-declared outputDtype', () => {
    // no codec declares outputDtype yet: rule matches the old behavior
    expect(outputDtypeFor(CODEC_REGISTRY['delta'], 'int16', {})).toBe('int16');
    expect(outputDtypeFor(CODEC_REGISTRY['rle'], 'int16', {})).toBe('uint8');
    expect(outputDtypeFor(CODEC_REGISTRY['byte-shuffle'], 'float32', {})).toBe('uint8');
  });
  it('pipelineOutputDtype walks active steps', () => {
    const steps = [
      { codec: 'delta', params: {} },
      { codec: 'rle', params: {}, enabled: false },
    ];
    expect(pipelineOutputDtype(steps, 'int16')).toBe('int16');
    expect(pipelineOutputDtype([{ codec: 'rle', params: {} }], 'int16')).toBe('uint8');
  });
  it('encodedByteLength: preserving keeps length, variable returns null', () => {
    expect(encodedByteLength([{ codec: 'delta', params: {} }], 'int16', 64)).toBe(64);
    expect(encodedByteLength([{ codec: 'rle', params: {} }], 'int16', 64)).toBeNull();
    expect(encodedByteLength([], 'float64', 80)).toBe(80);
    // disabled variable-size step is inert
    expect(encodedByteLength([{ codec: 'rle', params: {}, enabled: false }], 'int16', 64)).toBe(64);
  });
});
```

- [ ] **Step 2: Run to verify failure**: `npx vitest run tests/unit/engine/codecs.test.ts` — expect failures on `sizeEffect` undefined and missing exports.

- [ ] **Step 3: Implement.**
  In `src/types/codecs.ts`, change `CodecDefinition`:

```ts
category: 'transform' | 'reordering' | 'entropy';
/** How this codec changes the encoded byte count:
 *  - 'preserving': output length === input length (delta, zigzag, shuffles)
 *  - 'fixed-ratio': length changes deterministically via element widths
 *    (scale-offset float32→int16 = 1/2) — offsets stay computable from
 *    geometry + codec metadata, so no chunk index is demanded
 *  - 'variable': data-dependent (every entropy codec) */
sizeEffect: 'preserving' | 'fixed-ratio' | 'variable';
/** Human-readable input expectation, surfaced by stepWarnings when
 *  applicableTo fails. Advisory only — never blocks. */
expects?: string;
/** Declared (possibly param-dependent) output dtype. Absent = the default
 *  rule in outputDtypeFor (entropy/traceMode → uint8, else input). */
outputDtype?: (inputDtype: DtypeKey, params: Record<string, number | string>) => DtypeKey;
encode: (bytes: Uint8Array, inputDtype: string, params: Record<string, number | string>, byteOrder?: 'little' | 'big') => {
  bytes: Uint8Array;
  outputDtype: string;
  stats?: { clipped: number; rounded: number };
};
decode: (bytes: Uint8Array, encodedDtype: string, params: Record<string, number | string>, byteOrder?: 'little' | 'big') => {
  bytes: Uint8Array;
  outputDtype: string;
};
```

  (The `byteOrder` args are declared here but threaded through callers in Task 2 — declaring optional args breaks no existing codec.)

  In `src/engine/codecs.ts`:
  - Add `sizeEffect` to every entry: `delta`/`zigzag`/`byte-shuffle`/`bit-shuffle` → `'preserving'`; `dictionary`/`rle` → `'variable'`; the `pyodideCodec` factory → `'variable'`.
  - `outputDtypeFor`:

```ts
export function outputDtypeFor(
  codec: CodecDefinition,
  inputDtype: DtypeKey,
  params: Record<string, number | string>,
): DtypeKey {
  // (keep the existing doc comment)
  if (codec.outputDtype) return codec.outputDtype(inputDtype, params);
  return codec.category === 'entropy' || codec.traceMode ? 'uint8' : inputDtype;
}
```

  - `computeDtypeFlow` passes `step.params`; add + export:

```ts
/** Final output dtype of an entire pipeline (active steps only). */
export function pipelineOutputDtype(steps: CodecStep[], inputDtype: DtypeKey): DtypeKey {
  let dtype = inputDtype;
  for (const step of activeSteps(steps)) {
    const codec = CODEC_REGISTRY[step.codec];
    if (!codec) continue;
    dtype = outputDtypeFor(codec, dtype, step.params);
  }
  return dtype;
}

/** Encoded byte length of `rawLength` input bytes after `steps`, or null when
 *  a variable-size step makes it underivable. Fixed-ratio scaling floors to
 *  whole elements and copies the tail through, matching every codec's
 *  trailing-partial-element convention. */
export function encodedByteLength(steps: CodecStep[], inputDtype: DtypeKey, rawLength: number): number | null {
  let dtype = inputDtype;
  let length = rawLength;
  for (const step of activeSteps(steps)) {
    const codec = CODEC_REGISTRY[step.codec];
    if (!codec) continue;
    if (codec.sizeEffect === 'variable') return null;
    const out = outputDtypeFor(codec, dtype, step.params);
    if (codec.sizeEffect === 'fixed-ratio') {
      const inW = getDtype(dtype).size;
      const outW = getDtype(out).size;
      length = Math.floor(length / inW) * outW + (length % inW);
    }
    dtype = out;
  }
  return length;
}
```

  - `stepWarnings` applicability branch uses `expects` when present:

```ts
if (!codec.applicableTo(dtype)) {
  warnings.push(codec.expects
    ? `${codec.label} expects ${codec.expects}; got ${dtypeInfo.label} — results may be garbled or meaningless.`
    : `${codec.label} is not applicable to ${dtypeInfo.label} input — results may be garbled or meaningless.`);
}
```

  Update the three engine call sites (`decode.ts:29`, `layout.ts:217` in `encodedChunkMeta`, `read.ts:509` in `isPipelineLossy`) and `CodecPipelineEditor.tsx`'s `computeRunningDtypes` (line 46) to pass `step.params`.

- [ ] **Step 4: Run**: `npx vitest run` — full suite green (existing behavior unchanged).

- [ ] **Step 5: Commit**: `git commit -m "feat(engine): codec sizeEffect/expects metadata, params-aware dtype flow"`

---

### Task 2: byteOrder threading through the codec pipeline

**Files:**
- Modify: `src/engine/codecs.ts` (`runCodecPipeline`)
- Modify: `src/engine/decode.ts` (`reverseCodecPipeline`)
- Modify: `src/engine/pipelineCompute.ts` (`computeEncodedStage` + its two callers, lines 606 and 809)
- Modify: `src/engine/readReassemble.ts:280,306` (pass `ctx.byteOrder`)
- Test: `tests/unit/engine/codecs.test.ts`

**Interfaces:**
- Produces:
  - `runCodecPipeline(inputBytes, steps, inputDtype, byteOrder: 'little' | 'big' = 'little')`
  - `reverseCodecPipeline(encodedBytes, steps, originalDtype, byteOrder: 'little' | 'big' = 'little')`
  - `computeEncodedStage(chunks, linearizedChunks, interleaving, variables, fieldPipelines, chunkPipeline, linearizedLayout, byteOrder: 'little' | 'big' = 'little')`

- [ ] **Step 1: Write failing test** — a probe codec proving byteOrder reaches encode/decode:

```ts
it('runCodecPipeline and reverseCodecPipeline forward byteOrder to the codec', () => {
  const seen: string[] = [];
  const probe: CodecDefinition = {
    key: 'probe', label: 'Probe', category: 'reordering', sizeEffect: 'preserving',
    description: '', params: {}, applicableTo: () => true, isLossy: () => false,
    encode: (bytes, dt, _p, bo) => { seen.push(`enc:${bo}`); return { bytes, outputDtype: dt }; },
    decode: (bytes, dt, _p, bo) => { seen.push(`dec:${bo}`); return { bytes, outputDtype: dt }; },
  };
  CODEC_REGISTRY['probe'] = probe;
  try {
    runCodecPipeline(new Uint8Array(4), [{ codec: 'probe', params: {} }], 'int16', 'big');
    reverseCodecPipeline(new Uint8Array(4), [{ codec: 'probe', params: {} }], 'int16', 'big');
    expect(seen).toEqual(['enc:big', 'dec:big']);
  } finally { delete CODEC_REGISTRY['probe']; }
});
```

- [ ] **Step 2: Run to verify failure** (byteOrder arrives `undefined`).

- [ ] **Step 3: Implement**: add the `byteOrder = 'little'` parameter to both functions and pass it into `codec.encode(...)`/`codec.decode(...)`. Add the trailing `byteOrder` param to `computeEncodedStage` and pass `state.byteOrder` at both call sites in `pipelineCompute.ts` (line 606 `computePipelineStages`, line 809 `createPipelineComputer`; the encoded memo key already covers byteOrder via `linearizedKey`). In `readReassemble.ts`, pass `byteOrder` (already destructured from ctx at line 259) to both `reverseCodecPipeline` calls.

- [ ] **Step 4: Run**: `npx vitest run` — green.

- [ ] **Step 5: Commit**: `git commit -m "feat(engine): thread byteOrder through codec encode/decode"`

---

### Task 3: Transform codecs — quantize & bitround

**Files:**
- Modify: `src/engine/codecs.ts` (two new registry entries first in insertion order; `applyBitround` moves here from `typeAssign.ts`)
- Modify: `src/engine/typeAssign.ts` (import `applyBitround` from codecs.ts; delete the local copy)
- Test: `tests/unit/engine/transformCodecs.test.ts` (new)

**Interfaces:**
- Consumes: Task 1's `CodecDefinition` fields, Task 2's byteOrder arg; `bytesToValues`/`valuesToBytes` from `./elements.ts` (import is safe: elements.ts has no runtime import back into codecs.ts).
- Produces: registry keys `'quantize'`, `'bitround'`, both `category: 'transform'`, `sizeEffect: 'preserving'`, `isLossy: () => true`, no `traceMode`. Exported `applyBitround(bytes, dtype, keepBits, byteOrder)` from codecs.ts.
- Registry insertion order becomes: `quantize, bitround, scale-offset (Task 4), delta, zigzag, byte-shuffle, bit-shuffle, dictionary, rle, deflate, gzip, zstd` — transforms first (value domain first, picker order follows).

- [ ] **Step 1: Write failing tests** in `tests/unit/engine/transformCodecs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { CODEC_REGISTRY, runCodecPipeline } from '../../../src/engine/codecs.ts';
import { reverseCodecPipeline } from '../../../src/engine/decode.ts';
import { valuesToBytes, bytesToValues } from '../../../src/engine/elements.ts';

describe('quantize', () => {
  const q = CODEC_REGISTRY['quantize'];
  it('rounds float64 values to N decimal digits in place', () => {
    const bytes = valuesToBytes(Float64Array.from([1.2345, -2.71828, 3.0]), 'float64');
    const { bytes: out, outputDtype, stats } = q.encode(bytes, 'float64', { digits: 2 });
    expect(outputDtype).toBe('float64');
    expect(Array.from(bytesToValues(out, 'float64') as Float64Array)).toEqual([1.23, -2.72, 3]);
    expect(stats).toEqual({ clipped: 0, rounded: 2 });
  });
  it('decode is identity (irrecoverable)', () => {
    const bytes = valuesToBytes(Float64Array.from([1.23]), 'float64');
    expect(q.decode(bytes, 'float64', { digits: 2 }).bytes).toEqual(bytes);
  });
  it('honors byteOrder', () => {
    const be = valuesToBytes(Float64Array.from([1.2345]), 'float64', 'big');
    const { bytes: out } = q.encode(be, 'float64', { digits: 1 }, 'big');
    expect((bytesToValues(out, 'float64', 'big') as Float64Array)[0]).toBeCloseTo(1.2, 10);
  });
  it('skips NaN without counting it rounded', () => {
    const bytes = valuesToBytes(Float64Array.from([NaN, 1.25]), 'float64');
    const { stats } = q.encode(bytes, 'float64', { digits: 1 });
    expect(stats).toEqual({ clipped: 0, rounded: 1 });
  });
  it('metadata: transform category, preserving size, lossy, no traceMode', () => {
    expect(q.category).toBe('transform');
    expect(q.sizeEffect).toBe('preserving');
    expect(q.isLossy('float64')).toBe(true);
    expect(q.traceMode).toBeUndefined();
  });
});

describe('bitround', () => {
  const b = CODEC_REGISTRY['bitround'];
  it('zeroes low mantissa bits, dtype preserved, counts changed elements', () => {
    const bytes = valuesToBytes(Float64Array.from([Math.PI, 1.0]), 'float64');
    const { bytes: out, outputDtype, stats } = b.encode(bytes, 'float64', { keepBits: 8 });
    expect(outputDtype).toBe('float64');
    const vals = bytesToValues(out, 'float64') as Float64Array;
    expect(vals[0]).not.toBe(Math.PI);
    expect(Math.abs(vals[0] - Math.PI)).toBeLessThan(0.01);
    expect(vals[1]).toBe(1.0);          // exactly representable at any keepBits
    expect(stats).toEqual({ clipped: 0, rounded: 1 });
  });
  it('passes through non-float input unchanged', () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    expect(b.encode(bytes, 'int16', { keepBits: 8 }).bytes).toEqual(bytes);
  });
  it('roundtrips through the pipeline as a stable no-op on already-rounded data', () => {
    const step = [{ codec: 'bitround', params: { keepBits: 8 } }];
    const once = runCodecPipeline(valuesToBytes(Float64Array.from([Math.PI]), 'float64'), step, 'float64');
    const twice = runCodecPipeline(once.bytes, step, 'float64');
    expect(twice.bytes).toEqual(once.bytes);
    expect(reverseCodecPipeline(once.bytes, step, 'float64').bytes).toEqual(once.bytes);
  });
});
```

- [ ] **Step 2: Run to verify failure**: `npx vitest run tests/unit/engine/transformCodecs.test.ts`.

- [ ] **Step 3: Implement.** Move `applyBitround` (typeAssign.ts:218-257, keep the DC-6 comment) to codecs.ts and export it; `typeAssign.ts` imports it (temporary — Task 7 removes the usage). Add:

```ts
// ─── Quantize ───────────────────────────────────────────────────────────

/** Shared transform plumbing: decode whole elements at the input dtype,
 * map them, re-encode at `outDtype`, copy any trailing partial element
 * through (every codec's convention). Returns null when the input dtype
 * carries no numeric values to transform (charN). */
function mapValues(
  bytes: Uint8Array,
  inputDtype: DtypeKey,
  outDtype: DtypeKey,
  byteOrder: 'little' | 'big',
  fn: (v: number, out: { clipped: number; rounded: number }) => number,
): { bytes: Uint8Array; stats: { clipped: number; rounded: number } } | null {
  const inInfo = getDtype(inputDtype);
  if (inInfo.char) return null;
  const usable = Math.floor(bytes.length / inInfo.size) * inInfo.size;
  const values = bytesToValues(bytes.subarray(0, usable), inputDtype, byteOrder) as Float64Array;
  const stats = { clipped: 0, rounded: 0 };
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = fn(values[i], stats);
  const encoded = valuesToBytes(out, outDtype, byteOrder);
  const result = new Uint8Array(encoded.length + (bytes.length - usable));
  result.set(encoded);
  result.set(bytes.subarray(usable), encoded.length);
  return { bytes: result, stats };
}

const quantize: CodecDefinition = {
  key: 'quantize',
  label: 'Quantize',
  category: 'transform',
  sizeEffect: 'preserving',
  description:
    'Round values to a fixed number of decimal digits — same dtype, same size, '
    + 'less information. The precision thrown away here is what makes a later '
    + 'entropy codec bite.',
  params: {
    digits: { label: 'Decimal Digits', type: 'number', default: 1, min: 0, max: 12, step: 1 },
  },
  expects: 'float input (integer input has no fractional part to quantize)',
  applicableTo: (dtype) => getDtype(dtype as DtypeKey).float,
  isLossy: () => true,
  encode(bytes, inputDtype, params, byteOrder = 'little') {
    const raw = Math.floor(Number(params.digits));
    const digits = Number.isFinite(raw) ? Math.min(12, Math.max(0, raw)) : 1;
    const factor = 10 ** digits;
    const mapped = mapValues(bytes, inputDtype as DtypeKey, inputDtype as DtypeKey, byteOrder, (v, s) => {
      if (Number.isNaN(v)) return v;
      const q = Math.round(v * factor) / factor;
      if (q !== v) s.rounded++;
      return q;
    });
    if (!mapped) return { bytes: new Uint8Array(bytes), outputDtype: inputDtype };
    return { bytes: mapped.bytes, outputDtype: inputDtype, stats: mapped.stats };
  },
  decode: (bytes, encodedDtype) => ({ bytes: new Uint8Array(bytes), outputDtype: encodedDtype }),
};

// ─── Bit Round ──────────────────────────────────────────────────────────

const bitround: CodecDefinition = {
  key: 'bitround',
  label: 'Bit Round',
  category: 'transform',
  sizeEffect: 'preserving',
  description:
    'Zero the low mantissa bits, keeping N — the float stays a float, but '
    + 'slowly varying data gains long zero runs for a shuffle or entropy codec '
    + 'to exploit.',
  params: {
    keepBits: { label: 'Keep Bits', type: 'number', default: 10, min: 1, max: 52, step: 1 },
  },
  expects: 'float input (mantissa truncation is meaningless on integer bit patterns)',
  applicableTo: (dtype) => getDtype(dtype as DtypeKey).float,
  isLossy: () => true,
  encode(bytes, inputDtype, params, byteOrder = 'little') {
    if (inputDtype !== 'float32' && inputDtype !== 'float64') {
      return { bytes: new Uint8Array(bytes), outputDtype: inputDtype };
    }
    const maxBits = inputDtype === 'float64' ? 52 : 23;
    const raw = Math.floor(Number(params.keepBits));
    const keepBits = Number.isFinite(raw) ? Math.min(maxBits, Math.max(1, raw)) : Math.min(maxBits, 10);
    const out = applyBitround(bytes, inputDtype, keepBits, byteOrder);
    const size = getDtype(inputDtype).size;
    let rounded = 0;
    for (let i = 0; i + size <= bytes.length; i += size) {
      for (let b = 0; b < size; b++) {
        if (out[i + b] !== bytes[i + b]) { rounded++; break; }
      }
    }
    return { bytes: out, outputDtype: inputDtype, stats: { clipped: 0, rounded } };
  },
  decode: (bytes, encodedDtype) => ({ bytes: new Uint8Array(bytes), outputDtype: encodedDtype }),
};
```

  Add `import { valuesToBytes, bytesToValues } from './elements.ts';` and register both at the TOP of `CODEC_REGISTRY` insertion order.

- [ ] **Step 4: Run**: `npx vitest run` — green (existing picker tests are order-agnostic; if any pin registry order, update them to the new order).

- [ ] **Step 5: Commit**: `git commit -m "feat(engine): quantize and bitround transform codecs"`

---

### Task 4: Transform codec — scale-offset (fixed-ratio)

**Files:**
- Modify: `src/engine/codecs.ts` (registry entry after bitround)
- Test: `tests/unit/engine/transformCodecs.test.ts`

**Interfaces:**
- Produces: registry key `'scale-offset'`, `category: 'transform'`, `sizeEffect: 'fixed-ratio'`, params `scale` (number, default 10; 0 coerces to 1), `offset` (number, default 0), `sourceDtype` (select over numeric dtypes, default `'float32'`), `targetDtype` (select over int dtypes, default `'int16'`), declared `outputDtype: (_, params) => targetDtype-or-int16-fallback`.

- [ ] **Step 1: Write failing tests**:

```ts
describe('scale-offset', () => {
  const so = CODEC_REGISTRY['scale-offset'];
  const params = { scale: 10, offset: 0, sourceDtype: 'float32', targetDtype: 'int16' };
  it('packs floats into the target int dtype at 1/scale precision', () => {
    const bytes = valuesToBytes(Float64Array.from([1.5, 2.34, -0.7]), 'float32');
    const { bytes: out, outputDtype, stats } = so.encode(bytes, 'float32', params);
    expect(outputDtype).toBe('int16');
    expect(out.length).toBe(6); // 3 elements × 2 bytes — the fixed ratio
    expect(Array.from(bytesToValues(out, 'int16') as Float64Array)).toEqual([15, 23, -7]);
    expect(stats!.rounded).toBe(1); // 2.34×10 = 23.4 rounds; 1.5×10 and -0.7×10 are exact
    expect(stats!.clipped).toBe(0);
  });
  it('clamps and counts values outside the target range', () => {
    const bytes = valuesToBytes(Float64Array.from([40000, -1]), 'float32');
    const { bytes: out, stats } = so.encode(bytes, 'float32', { ...params, scale: 1 });
    expect(Array.from(bytesToValues(out, 'int16') as Float64Array)).toEqual([32767, -1]);
    expect(stats!.clipped).toBe(1);
  });
  it('decode divides out and re-emits at sourceDtype', () => {
    const enc = valuesToBytes(Float64Array.from([15, 23]), 'int16');
    const { bytes: out, outputDtype } = so.decode(enc, 'int16', params);
    expect(outputDtype).toBe('float32');
    expect(Array.from(bytesToValues(out, 'float32') as Float64Array)).toEqual([1.5, 2.299999952316284]);
  });
  it('reverseCodecPipeline roundtrips to the quantized values', () => {
    const original = valuesToBytes(Float64Array.from([1.5, 2.3, -0.7]), 'float32');
    const steps = [{ codec: 'scale-offset', params }];
    const enc = runCodecPipeline(original, steps, 'float32');
    expect(enc.outputDtype).toBe('int16');
    const dec = reverseCodecPipeline(enc.bytes, steps, 'float32');
    expect(dec.outputDtype).toBe('float32');
    const vals = bytesToValues(dec.bytes, 'float32') as Float64Array;
    expect(vals[0]).toBeCloseTo(1.5, 5);
    expect(vals[1]).toBeCloseTo(2.3, 5);
    expect(vals[2]).toBeCloseTo(-0.7, 5);
  });
  it('encodedByteLength accounts for the ratio', () => {
    expect(encodedByteLength([{ codec: 'scale-offset', params }], 'float32', 12)).toBe(6);
    expect(encodedByteLength(
      [{ codec: 'scale-offset', params }, { codec: 'delta', params: { elementSize: 2 } }],
      'float32', 12,
    )).toBe(6);
  });
  it('NaN stores as 0 without clip/round counts (assignType NF-4 convention)', () => {
    const bytes = valuesToBytes(Float64Array.from([NaN]), 'float32');
    const { bytes: out, stats } = so.encode(bytes, 'float32', params);
    expect(Array.from(bytesToValues(out, 'int16') as Float64Array)).toEqual([0]);
    expect(stats).toEqual({ clipped: 0, rounded: 0 });
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** in codecs.ts:

```ts
// ─── Scale/Offset ───────────────────────────────────────────────────────

const SCALE_TARGET_DTYPES: DtypeKey[] = ['int8', 'uint8', 'int16', 'uint16', 'int32', 'uint32'];
const SCALE_SOURCE_DTYPES: DtypeKey[] = [...SCALE_TARGET_DTYPES, 'float32', 'float64'];

function scaleOffsetTarget(params: Record<string, number | string>): DtypeKey {
  return (SCALE_TARGET_DTYPES as string[]).includes(String(params.targetDtype))
    ? params.targetDtype as DtypeKey : 'int16';
}

const scaleOffset: CodecDefinition = {
  key: 'scale-offset',
  label: 'Scale/Offset',
  category: 'transform',
  sizeEffect: 'fixed-ratio',
  description:
    "v' = round((v − offset) × scale), stored in a smaller integer dtype — "
    + "numcodecs' FixedScaleOffset. The decimals you keep are the scale you choose.",
  params: {
    scale: { label: 'Scale', type: 'number', default: 10, min: -1_000_000_000, max: 1_000_000_000, step: 1 },
    offset: { label: 'Offset', type: 'number', default: 0, min: -1e12, max: 1e12, step: 1 },
    // decode's return dtype: the reader can't know the pre-step dtype from the
    // encoded bytes alone, so it rides in params (numcodecs FixedScaleOffset's
    // dtype/astype pair). Seeded from the running dtype at add time (editor).
    sourceDtype: { label: 'Source Dtype', type: 'select', default: 'float32', options: SCALE_SOURCE_DTYPES },
    targetDtype: { label: 'Target Dtype', type: 'select', default: 'int16', options: SCALE_TARGET_DTYPES },
  },
  expects: 'float input (packing decimals into an integer dtype is the point)',
  applicableTo: (dtype) => getDtype(dtype as DtypeKey).float,
  isLossy: () => true,
  outputDtype: (_inputDtype, params) => scaleOffsetTarget(params),
  encode(bytes, inputDtype, params, byteOrder = 'little') {
    const scale = Number(params.scale) || 1;
    const offset = Number(params.offset) || 0;
    const targetDtype = scaleOffsetTarget(params);
    const outInfo = getDtype(targetDtype);
    const mapped = mapValues(bytes, inputDtype as DtypeKey, targetDtype, byteOrder, (v, s) => {
      if (Number.isNaN(v)) return 0; // NF-4: NaN→0 on int storage, not a clip/round event
      const t = (v - offset) * scale;
      const r = Math.round(t);
      if (r !== t) s.rounded++;
      const c = Math.max(outInfo.min, Math.min(outInfo.max, r));
      if (c !== r) s.clipped++;
      return c;
    });
    if (!mapped) return { bytes: new Uint8Array(bytes), outputDtype: inputDtype };
    return { bytes: mapped.bytes, outputDtype: targetDtype, stats: mapped.stats };
  },
  decode(bytes, encodedDtype, params, byteOrder = 'little') {
    const scale = Number(params.scale) || 1;
    const offset = Number(params.offset) || 0;
    const sourceDtype = (SCALE_SOURCE_DTYPES as string[]).includes(String(params.sourceDtype))
      ? params.sourceDtype as DtypeKey : 'float32';
    const mapped = mapValues(bytes, encodedDtype as DtypeKey, sourceDtype, byteOrder,
      (v) => v / scale + offset);
    if (!mapped) return { bytes: new Uint8Array(bytes), outputDtype: encodedDtype };
    return { bytes: mapped.bytes, outputDtype: sourceDtype };
  },
};
```

  Register after `bitround`.

- [ ] **Step 4: Run**: `npx vitest run` — green.

- [ ] **Step 5: Commit**: `git commit -m "feat(engine): scale-offset fixed-ratio transform codec"`

---

### Task 5: Fixed-ratio slot geometry in the Encoded layout

**Files:**
- Modify: `src/engine/layout.ts` (`buildEncodedLayout` signature)
- Modify: `src/engine/pipelineCompute.ts` (`computeEncodedStage` builds per-chunk slot fields)
- Test: `tests/unit/engine/encodedTracing.test.ts`

**Interfaces:**
- Consumes: `encodedChunkMeta(steps, inputDtype)` (unchanged signature; now params-aware internally via Task 1).
- Produces: `buildEncodedLayout(linearizedLayout, encodedChunks, slotFields: ChunkFieldLayout[][], traceModes: ChunkTraceMode[])` — `slotFields[i]` is the fully-relabeled field list for chunk i (ignored for `chunk-level` chunks). Task 8 supplies row-mode per-variable fields through the same parameter.

- [ ] **Step 1: Write failing tests** in `tests/unit/engine/encodedTracing.test.ts` (follow the file's existing fixture style for building a linearized layout — a single-variable column chunk of 4 float32 values):

```ts
it('fixed-ratio pipeline: slots take the post-pipeline dtype AND width', () => {
  const steps = [{ codec: 'scale-offset', params: { scale: 10, offset: 0, sourceDtype: 'float32', targetDtype: 'int16' } }];
  const meta = encodedChunkMeta(steps, 'float32');
  expect(meta).toEqual({ outputDtype: 'int16', slotDtype: 'int16', traceMode: 'value-preserving' });
  // build a 1-chunk column layout over 4 float32 elements (16 raw bytes),
  // encode to 8 int16 bytes, and check the region's slot geometry:
  // (use the file's existing makeLinearizedLayout/chunk fixtures)
  const encoded = buildEncodedLayout(linearizedLayout, [{ chunkId, bytes: new Uint8Array(8) }],
    [[{ variableName: 'temp', variableColor: '#fff', dtype: 'int16', size: 2, offset: 0 }]],
    ['value-preserving']);
  const region = encoded.regions[0] as ChunkBlockRegion;
  expect(region.byteLength).toBe(8);
  expect(region.fields[0]).toMatchObject({ dtype: 'int16', size: 2 });
});
it('traceAt on a fixed-ratio chunk: element i sits at i × new width and decodes stage bytes', () => {
  // stage bytes = int16 [15, 23, -7, 42]; byte 2 → element 1, byteCount 2, display "23"
});
it('byteRangesForTrace inverts traceAt across the new width', () => {
  // traceId of element 1 → [{start: 2, end: 4}]
});
```

  Fill the last two tests concretely using the file's existing helpers (it already builds `StageLayout`s and `ValueSources` inline; mirror the nearest existing value-preserving test, swapping the pipeline for scale-offset and asserting the 2-byte stride).

- [ ] **Step 2: Run to verify failure** (buildEncodedLayout still takes `slotDtypes: string[]`).

- [ ] **Step 3: Implement.**
  `layout.ts` — change `buildEncodedLayout`'s third parameter from `slotDtypes: string[]` to `slotFields: ChunkFieldLayout[][]`; the non-chunk-level branch becomes:

```ts
regions.push({
  ...r, start: cursor, byteLength: encBytes,
  mode: traceModes[i],
  fields: slotFields[i],
});
```

  (`chunk-level` branch unchanged — it still reads `r.fields` for the shared-variable check and emits `fields: []`.)

  `pipelineCompute.ts` — in `computeEncodedStage`, replace the `slotDtypes` accumulation with:

```ts
const slotFields: ChunkFieldLayout[][] = [];
// inside chunks.map, after `const meta = encodedChunkMeta(steps, inputDtype);`:
const region = linearizedLayout.regions[idx] as ChunkBlockRegion;
const slotSize = getDtype(meta.slotDtype as DtypeKey).size;
slotFields.push(region.fields.length === 1
  // single-field (column) chunk: the slot takes the pipeline's dtype AND width —
  // a fixed-ratio transform narrows every slot (4 float32 bytes → 2 int16 bytes)
  ? [{ ...region.fields[0], dtype: meta.slotDtype, size: slotSize }]
  // multi-field (row) chunk: dtype relabel only, widths untouched (pre-prefix
  // behavior — Task 8 replaces this branch with per-variable prefix fields)
  : region.fields.map((f) => ({ ...f, dtype: meta.slotDtype })));
```

  Import `ChunkFieldLayout` and `getDtype` as needed; pass `slotFields` to `buildEncodedLayout`.

- [ ] **Step 4: Run**: `npx vitest run` — green, including `layout.equivalence`/`layout.reverse` (no transforms in their configs, so the reference impl still matches).

- [ ] **Step 5: Commit**: `git commit -m "feat(layout): fixed-ratio value-preserving slot geometry"`

---

### Task 6: Read path — fixed-ratio chunk-index synthesis & column round-trips

**Files:**
- Modify: `src/engine/readReassemble.ts` (`resolveChunkIndex`; delete `hasSizeChangingCodec`)
- Test: `tests/unit/engine/read.test.ts`, `tests/unit/engine/readGranular.test.ts`

**Interfaces:**
- Consumes: `encodedByteLength` (Task 1).
- Produces: `resolveChunkIndex` derives synthetic single-file offsets through fixed-ratio pipelines; throws `NoChunkIndexError` only when `encodedByteLength` returns null. `hasSizeChangingCodec` is deleted (update its importers/tests).

- [ ] **Step 1: Write failing tests** (follow `read.test.ts`'s existing state-building helpers — it constructs full `AppState`s and runs `computePipelineStages`):

```ts
it('scale-offset column pipeline round-trips through write/read', () => {
  // column state, one float32 variable with values like [1.5, 2.3, -0.7, 4.2],
  // fieldPipelines: [{codec:'scale-offset', params:{scale:10, offset:0, sourceDtype:'float32', targetDtype:'int16'}}]
  // assert read success and reconstructed values ≈ originals to 1 decimal
});
it('chunk-index OFF + fixed-ratio pipeline still reads (offsets derived from geometry × ratio)', () => {
  // same state, metadata.include.chunkIndex = false → success, not no-chunk-index
});
it('chunk-index OFF + entropy codec still fails no-chunk-index', () => {
  // regression: rle in the pipeline, include.chunkIndex=false → failure 'no-chunk-index'
});
it('codecs group OFF + scale-offset hard-fails on byte-count mismatch', () => {
  // include.codecs=false → failure 'decode-error' (AssumedIdentitySizeMismatch:
  // int16 bytes found where float32 geometry was expected)
});
it('codecs group OFF + quantize reads successfully and correctly', () => {
  // quantize is size/dtype-preserving with identity decode: the stored values ARE
  // the quantized values — assert success and values equal the quantized originals
});
```

  Write these concretely against the helpers already in the file (copy the nearest existing test's state literal and adjust).

- [ ] **Step 2: Run to verify failure** (fixed-ratio currently computes wrong synthetic sizes → decode-error or wrong values).

- [ ] **Step 3: Implement** — in `resolveChunkIndex`, replace both `hasSizeChangingCodec` checks with `encodedByteLength`-derived sizes:

```ts
if (interleaving === 'column') {
  const entries: ChunkIndexEntry[] = [];
  let offset = magicLength;
  for (const varInfo of schema) {
    const steps = fieldPipelines?.[varInfo.name] ?? [];
    const elemSize = getDtype(varInfo.dtype).size;
    for (const coords of coordsList) {
      const raw = chunkGeometry(coords, chunkShape, shape).elementCount * elemSize;
      const size = encodedByteLength(steps, varInfo.dtype, raw);
      if (size === null) {
        throw new NoChunkIndexError(`variable "${varInfo.name}" has a size-changing codec with no chunk index`);
      }
      entries.push({ coords, offset, size, variableName: varInfo.name });
      offset += size;
    }
  }
  return entries;
}

const steps = chunkPipeline ?? [];
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

  Delete `hasSizeChangingCodec` and update any test importing it to assert via `encodedByteLength(...) === null` instead. Note the column-mode variable-grouped offset accumulation comment must be preserved.

- [ ] **Step 4: Run**: `npx vitest run` — green.

- [ ] **Step 5: Commit**: `git commit -m "feat(read): fixed-ratio synthetic chunk index; column transform round-trips"`

---

### Task 7: TypeAssignment shrinks to the cast

**Files:**
- Modify: `src/types/state.ts:39-44` (`TypeAssignment` → `{ storageDtype: DtypeKey }`)
- Modify: `src/engine/typeAssign.ts` (gut scale/offset/keepBits; delete `reverseTypeAssignment`)
- Modify: `src/engine/readReassemble.ts` (delete `reverseTypeAssignmentValues`)
- Modify: `src/engine/read.ts` (delete the `typeAssignments` reversal block at lines 408-414, the `typeAssignments` field of `ParsedStructure`, and its `parseStructure` parsing)
- Modify: `src/engine/metadata.ts` (delete the `type_assignments` entry, lines 121-133, and its `METADATA_KEY_GROUPS` row)
- Modify: `src/components/config/TypeAssignConfig.tsx` (remove scale/offset/keepBits controls)
- Modify: `src/state/persistence.ts` (drop rule in `migrateState`)
- Modify: `scripts/gen-presets.ts` (rewrite the three scale-carrying presets), then regenerate `src/presets/*.json`
- Test: `tests/unit/engine/typeAssign.test.ts`, `tests/unit/engine/typeassign-edges.test.ts`, `tests/unit/state/persistence.test.ts`, `tests/unit/state/presets.test.ts`, plus fixture updates wherever `scale:`/`keepBits:` appear under a `typeAssignment` (grep `tests/`)

**Interfaces:**
- Consumes: scale-offset codec (Task 4), fixed-ratio read path (Task 6).
- Produces: `TypeAssignment = { storageDtype: DtypeKey }`; `assignType(values, logicalType, assignment, byteOrder)` unchanged signature, cast-only behavior (clamp/round/NaN stats and the char branch stay); NO `reverseTypeAssignment`, NO `type_assignments` metadata key.

- [ ] **Step 1: Write/adjust failing tests.**
  - `typeAssign.test.ts`: delete scale/offset/keepBits cases; keep/add cast-only cases (float64→int16 clamps and rounds with stats; char truncation; NaN counting; all-NaN stats). Add:

```ts
it('TypeAssignment carries only storageDtype', () => {
  const result = assignType(Float64Array.from([1.4, 70000]), { type: 'integer' } as LogicalTypeConfig,
    { storageDtype: 'int16' });
  expect(result.stats.rounded).toBe(1);
  expect(result.stats.clipped).toBe(1);
});
```

  - `persistence.test.ts`:

```ts
it('drops persisted states whose typeAssignment carries scale/offset/keepBits', () => {
  const raw = structuredClone(DEFAULT_STATE);
  (raw.variables[0].typeAssignment as Record<string, unknown>).scale = 10;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(raw));
  expect(loadState()).toBeNull(); // drop-to-defaults, no migration
});
```

  (Match the file's actual load/assert conventions.)

- [ ] **Step 2: Run to verify failures.**

- [ ] **Step 3: Implement engine + state.**
  - `types/state.ts`: `export interface TypeAssignment { storageDtype: DtypeKey; }`
  - `typeAssign.ts`: remove `hasScaleOffset`/scale/offset math, the `keepBits` branch, the float read-back rounding check (it existed to detect scale-induced precision loss; a plain float cast still detects float64→float32 rounding — KEEP the read-back check but compare against the raw original, no scale term). Delete `reverseTypeAssignment` and the `applyBitround` import (now only codecs.ts uses it).
  - `readReassemble.ts`: delete `reverseTypeAssignmentValues` (and its `TypeAssignment`/`reverseTypeAssignment` imports).
  - `read.ts`: delete `typeAssignments` from `ParsedStructure`, `parseStructure`, and the reversal loop in `reconstruct` (lines 408-414). The `variableStatistics`-driven `typeAssignLossy` set stays.
  - `metadata.ts`: delete the `type_assignments` entry block and the `type_assignments: 'schema'` row in `METADATA_KEY_GROUPS`. Code comment: `// type_assignments was deleted with the typeAssignment shrink: it would duplicate schema's per-variable dtype (chunk_grid precedent — every entry must be one the reader actually uses).`
  - `persistence.ts` — in `migrateState`, after the existing v1 branch:

```ts
// Codec-unification shrink: typeAssignment is storageDtype-only. A state
// carrying the old scale/offset/keepBits fields predates the shrink — drop it
// (standing no-migration policy; the lesson moved to the scale-offset codec).
const vars = Array.isArray((raw as { variables?: unknown }).variables)
  ? (raw as { variables: unknown[] }).variables : [];
for (const v of vars) {
  const ta = (v as { typeAssignment?: Record<string, unknown> })?.typeAssignment;
  if (ta && ('scale' in ta || 'offset' in ta || 'keepBits' in ta)) return null;
}
```

  - `TypeAssignConfig.tsx`: delete the scale/offset/keepBits inputs and their `showScaleOffset`/`showKeepBits` gating; keep the dtype select, the `type-assign-range-{id}` note, and the lossy indicator (cast stats only for now — Task 10 adds codec stats).

- [ ] **Step 4: Rewrite the preset generator.** In `scripts/gen-presets.ts`:
  - Every `typeAssignment: { storageDtype: 'int16', scale: 10 }` becomes `typeAssignment: { storageDtype: 'float32' }` (parquet-adjacent tmax/tmin/prcp; avroesque tmax/tmin/prcp; cog-esque elevation).
  - **parquet-adjacent** (column): prepend to each of those variables' `fieldPipelines` arrays: `{ codec: 'scale-offset', params: { scale: 10, offset: 0, sourceDtype: 'float32', targetDtype: 'int16' } }`, and set any following `delta` step's params to `{ elementSize: 2 }` (post-scale elements are int16).
  - **avroesque** (row): set each of tmax/tmin/prcp's `fieldPipelines` entries to `[{ codec: 'scale-offset', params: { scale: 10, offset: 0, sourceDtype: 'float32', targetDtype: 'int16' } }]` (these become active row-mode prefixes in Task 8; until then they are benignly inactive — values simply store as float32).
  - **cog-esque** (row, single variable): `chunkPipeline` becomes `[{ codec: 'scale-offset', params: { scale: 10, offset: 0, sourceDtype: 'float32', targetDtype: 'int16' } }, { codec: 'delta', params: { elementSize: 2 } }, { codec: 'deflate', params: {} }]` — the COG lesson: decimal metres → quantise to int16 → delta → entropy, now visible as three pipeline steps.
  - Update the generator's prose comments that describe scale living in `type_assignments`.
  Run `npx tsx scripts/gen-presets.ts` and commit the regenerated JSON.

- [ ] **Step 5: Sweep test fixtures**: `grep -rn "scale\|keepBits" tests/unit | grep -i typeassign` and fix every fixture; update `reducer.test.ts` UPDATE_VARIABLE fixtures, `presets.test.ts` expectations, and any `read.test.ts`/`readGranular.test.ts`/`metadata-adversarial.test.ts` reference to `type_assignments`.

- [ ] **Step 6: Run**: `npx vitest run` — green.

- [ ] **Step 7: Commit**: `git commit -m "feat!: typeAssignment shrinks to storageDtype; scale moves to the codec pipeline"`

---

### Task 8: Row-mode structured prefix — encode + layout

**Files:**
- Modify: `src/engine/codecs.ts` (`isElementStructured`, `splitStructuredPrefix`)
- Modify: `src/engine/pipelineCompute.ts` (`computeEncodedStage` row branch, `collectEncodedWarnings`)
- Test: `tests/unit/engine/codecs.test.ts` (split helper), `tests/unit/engine/pipeline.integration.test.ts` (row-mode encode)

**Interfaces:**
- Produces:
  - `isElementStructured(codec: CodecDefinition): boolean` — `!codec.traceMode && codec.sizeEffect !== 'variable'`
  - `splitStructuredPrefix(steps: CodecStep[]): { prefix: CodecStep[]; remainder: CodecStep[] }` — prefix ends at the first ACTIVE non-structured step; disabled steps are inert and never end it
  - Row-mode Encoded stage: per chunk, each variable's prefix runs on its contiguous chunk values, records re-interleave at post-prefix widths, then `chunkPipeline` runs on the result. Task 9's reader mirrors this exactly.

- [ ] **Step 1: Write failing tests.**
  In `codecs.test.ts`:

```ts
describe('splitStructuredPrefix', () => {
  it('splits at the first active structure-destroying step', () => {
    const steps = [
      { codec: 'scale-offset', params: {} },
      { codec: 'delta', params: {} },
      { codec: 'deflate', params: {} },
      { codec: 'zigzag', params: {} },
    ];
    const { prefix, remainder } = splitStructuredPrefix(steps);
    expect(prefix.map((s) => s.codec)).toEqual(['scale-offset', 'delta']);
    expect(remainder.map((s) => s.codec)).toEqual(['deflate', 'zigzag']);
  });
  it('a disabled destroyer does not end the prefix', () => {
    const steps = [
      { codec: 'rle', params: {}, enabled: false },
      { codec: 'delta', params: {} },
    ];
    expect(splitStructuredPrefix(steps).prefix).toHaveLength(2);
  });
  it('shuffles end the prefix (traceMode destroys slot identity)', () => {
    const steps = [{ codec: 'byte-shuffle', params: { elementSize: 4 } }];
    expect(splitStructuredPrefix(steps).prefix).toHaveLength(0);
  });
});
```

  In `pipeline.integration.test.ts` — a row-mode state with two variables (float32 `t` with a scale-offset field pipeline, int32 `d` with none) and a delta chunk pipeline; assert on `computePipelineStages(state)`:

```ts
it('row mode runs each field pipeline\'s structured prefix before interleaving', () => {
  // Encoded stage byte count: per element 2 (int16 post-scale) + 4 (int32) = 6,
  // not the pre-prefix 4 + 4 = 8.
  const encoded = result.stages[3];
  expect(encoded.stats.byteCount).toBe(elementCount * 6);
  // layout fields carry post-prefix widths
  const region = encoded.layout.regions[0] as ChunkBlockRegion;
  expect(region.fields.map((f) => ({ dtype: f.dtype, size: f.size, offset: f.offset })))
    .toEqual([{ dtype: 'int16', size: 2, offset: 0 }, { dtype: 'int32', size: 4, offset: 2 }]);
});
it('a field pipeline\'s non-structured remainder stays inactive in row mode', () => {
  // t's pipeline = [scale-offset, rle]: rle must NOT run (byte count still elementCount*6,
  // rle would change it) — remainder inactive, preserved in state
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.**
  codecs.ts:

```ts
/** A codec whose output still has fixed-width per-element structure — the
 *  derived form of Zarr's array-codec/bytes-codec split (spec: theorem, not
 *  axiom). Structured codecs may run per-variable before row interleaving;
 *  a traceMode codec destroyed slot↔element identity and a variable-size
 *  codec has no elements at all, so neither can be interleaved element-wise. */
export function isElementStructured(codec: CodecDefinition): boolean {
  return !codec.traceMode && codec.sizeEffect !== 'variable';
}

/** Maximal leading run of steps that may run per-variable under row
 *  interleaving. Disabled steps are inert everywhere (activeSteps) so they
 *  never end the prefix; they stay in whichever segment they sit in. */
export function splitStructuredPrefix(steps: CodecStep[]): { prefix: CodecStep[]; remainder: CodecStep[] } {
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].enabled === false) continue;
    const codec = CODEC_REGISTRY[steps[i].codec];
    if (codec && !isElementStructured(codec)) {
      return { prefix: steps.slice(0, i), remainder: steps.slice(i) };
    }
  }
  return { prefix: steps, remainder: [] };
}
```

  `pipelineCompute.ts` — rework the row-mode path of `computeEncodedStage` (replace `chunkCodecInput`'s row branch; column branch unchanged):

```ts
// row mode, per chunk: run each variable's structured prefix on its own
// contiguous values, re-interleave records at the post-prefix widths, then
// run the shared chunk pipeline. Equivalent to strided in-place execution
// (interleave order IS element order); hoisting keeps the code linear.
const prefixOut = chunk.variables.map((cv) => {
  const varId = nameToId.get(cv.variableName);
  const { prefix } = splitStructuredPrefix((varId !== undefined ? fieldPipelines[varId] : undefined) ?? []);
  const raw = valuesToBytes(cv.values, cv.dtype as DtypeKey, byteOrder);
  const res = runCodecPipeline(raw, prefix, cv.dtype as DtypeKey, byteOrder);
  const dtype = res.outputDtype as DtypeKey;
  return { ...res, dtype, size: getDtype(dtype).size, name: cv.variableName, color: cv.variableColor };
});
const elementCount = chunk.variables[0]?.values.length ?? 0;
const recordSize = prefixOut.reduce((a, p) => a + p.size, 0);
const interleaved = new Uint8Array(elementCount * recordSize);
let w = 0;
for (let i = 0; i < elementCount; i++) {
  for (const p of prefixOut) {
    interleaved.set(p.bytes.subarray(i * p.size, (i + 1) * p.size), w);
    w += p.size;
  }
}
const mixed = new Set(prefixOut.map((p) => p.dtype)).size > 1;
const inputDtype: DtypeKey = prefixOut.length === 0 ? 'uint8' : mixed ? 'uint8' : prefixOut[0].dtype;
const meta = encodedChunkMeta(chunkPipeline, inputDtype);
const result = runCodecPipeline(interleaved, chunkPipeline, inputDtype, byteOrder);
// slot fields: post-prefix geometry; if the chunk pipeline degraded the mode,
// relabel dtype to its frozen slotDtype (today's rule), widths stay post-prefix
let off = 0;
const fields: ChunkFieldLayout[] = prefixOut.map((p) => {
  const f = { variableName: p.name, variableColor: p.color,
    dtype: meta.traceMode === 'value-preserving' ? p.dtype : meta.slotDtype, size: p.size, offset: off };
  off += p.size;
  return f;
});
slotFields.push(fields);
```

  `collectEncodedWarnings` row branch: per-variable prefix warnings + chunk-pipeline warnings at the post-prefix input dtype:

```ts
const prefixWarnings = variables.flatMap((v) =>
  stepWarnings(splitStructuredPrefix(fieldPipelines[v.id] ?? []).prefix, v.typeAssignment.storageDtype));
const outs = variables.map((v) =>
  pipelineOutputDtype(splitStructuredPrefix(fieldPipelines[v.id] ?? []).prefix, v.typeAssignment.storageDtype));
const inputDtype: DtypeKey = outs.length === 0 ? 'uint8' : new Set(outs).size > 1 ? 'uint8' : outs[0];
return [...prefixWarnings, ...stepWarnings(chunkPipeline, inputDtype)];
```

- [ ] **Step 4: Run**: `npx vitest run` — green. NOTE: any existing test asserting "field pipelines are wholly inactive in row mode" (grep `pipeline.integration.test.ts` / `usePipeline.test.ts` for row-mode + fieldPipelines) now asserts the NEW rule: structured prefix active, remainder inactive. Update those assertions deliberately — this is the intended pitfall-4 narrowing.

- [ ] **Step 5: Commit**: `git commit -m "feat(engine): row mode runs each field pipeline's element-structured prefix"`

---

### Task 9: Row-mode structured prefix — metadata format + reader

**Files:**
- Modify: `src/engine/metadata.ts` (row-mode `codec_pipelines` value)
- Modify: `src/engine/read.ts` (`parseStructure` three-shape parsing; `computeCodecLossyVariables` row branch)
- Modify: `src/engine/readReassemble.ts` (row-mode `reconstructValues`, `resolveChunkIndex` row widths, new `deinterleaveRowChunkBytes`, delete `deinterleaveRowChunk`)
- Test: `tests/unit/engine/read.test.ts`, `tests/unit/engine/readGranular.test.ts`

**Interfaces:**
- Produces:
  - Row-mode metadata: `codec_pipelines = JSON.stringify({ chunk: activeSteps(chunkPipeline), fields: { [variableName]: activeSteps(prefix) } })`. Column mode keeps the plain by-name object; a bare array still parses as chunk-pipeline-only (defensive).
  - `deinterleaveRowChunkBytes(bytes: Uint8Array, encSchema: SchemaEntry[], chunkElementCount: number): Map<string, Uint8Array>` — byte-level deinterleave at post-prefix widths.
  - Row-mode read: reverse chunk pipeline → deinterleave at post-prefix widths → per-variable reverse prefix → `bytesToValues` at schema dtype.

- [ ] **Step 1: Write failing tests** (in `read.test.ts`, using its state helpers):

```ts
it('row-mode prefix round-trips: scale-offset per variable + deflate-free entropy on the chunk', () => {
  // two variables (float32 with scale-offset prefix, int32 bare), chunkPipeline [rle]
  // → read success, float values ≈ originals to 1 decimal, int values exact
});
it('avroesque shape: prefixes only, empty chunk pipeline', () => {
  // chunkPipeline [], three float32 vars each with a scale-offset prefix → success
});
it('row-mode chunk-index OFF with fixed-ratio prefixes derives offsets', () => {
  // include.chunkIndex=false, no entropy anywhere → success (record width = post-prefix sum)
});
it('row-mode codecs group OFF with a fixed-ratio prefix hard-fails on byte count', () => {
  // include.codecs=false → 'decode-error' (records are 6 bytes, schema geometry says 8)
});
it('row-mode prefix lossiness marks only the prefixed variable', () => {
  // lossyVariables contains the scale-offset variable, not the bare int32 one
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.**
  `metadata.ts` row branch of the `codec_pipelines` entry:

```ts
} else {
  // Row mode records BOTH halves of what actually ran: each variable's
  // structured prefix (applied per-variable before interleaving) and the
  // shared chunk pipeline. {chunk, fields} keys distinguish this from the
  // column-mode by-name object.
  const fields: Record<string, unknown> = {};
  for (const v of state.variables) {
    fields[v.name] = activeSteps(splitStructuredPrefix(state.fieldPipelines[v.id] ?? []).prefix);
  }
  entries.push({ key: 'codec_pipelines',
    value: JSON.stringify({ chunk: activeSteps(state.chunkPipeline), fields }) });
}
```

  `read.ts` `parseStructure`:

```ts
if (codecPipelinesStr) {
  const parsed = JSON.parse(codecPipelinesStr);
  if (Array.isArray(parsed)) {
    chunkPipeline = parsed;
  } else if (Array.isArray(parsed.chunk) && parsed.fields && typeof parsed.fields === 'object') {
    // row-mode {chunk, fields} envelope (structured prefixes + shared pipeline)
    chunkPipeline = parsed.chunk;
    fieldPipelines = parsed.fields;
  } else {
    fieldPipelines = parsed;
  }
}
```

  `readReassemble.ts` row branch of `reconstructValues`:

```ts
const steps = chunkPipeline ?? [];
// post-prefix encoded schema: what each field's bytes ARE inside a record
const encSchema: SchemaEntry[] = schema.map((v) => ({
  name: v.name,
  dtype: pipelineOutputDtype(fieldPipelines?.[v.name] ?? [], v.dtype),
}));
const inputDtype = rowModeInputDtype(encSchema);
const bytesPerElement = encSchema.reduce((sum, v) => sum + getDtype(v.dtype).size, 0);
// ... per entry:
const decoded = reverseCodecPipeline(chunkBytes, steps, inputDtype, byteOrder);
const chunkElementN = chunkGeometry(entry.coords, chunkShape, shape).elementCount;
const perVarBytes = deinterleaveRowChunkBytes(decoded.bytes, encSchema, chunkElementN);
for (const varInfo of schema) {
  const prefix = fieldPipelines?.[varInfo.name] ?? [];
  const rev = reverseCodecPipeline(perVarBytes.get(varInfo.name)!, prefix, varInfo.dtype, byteOrder);
  const chunkValues = bytesToValues(rev.bytes, rev.outputDtype as DtypeKey, byteOrder);
  scatterChunkValues(result.get(varInfo.name)!, chunkValues, entry.coords, chunkShape, shape, linearization);
}
```

  The assume-identity byte check (`codecInfoPresent === false`) keeps using SCHEMA widths — the reader knows nothing about prefixes then; that mismatch IS the honest failure.

```ts
/** Byte-level row-chunk deinterleave at the encoded (post-prefix) field
 *  widths. Values can't be decoded yet — each field's prefix must be
 *  reversed first — so this splits bytes, not values. */
export function deinterleaveRowChunkBytes(
  bytes: Uint8Array,
  encSchema: SchemaEntry[],
  chunkElementCount: number,
): Map<string, Uint8Array> {
  const widths = encSchema.map((v) => getDtype(v.dtype).size);
  const recordSize = widths.reduce((a, b) => a + b, 0);
  const result = new Map<string, Uint8Array>();
  encSchema.forEach((v, j) => result.set(v.name, new Uint8Array(chunkElementCount * widths[j])));
  for (let elem = 0; elem < chunkElementCount; elem++) {
    let off = elem * recordSize;
    encSchema.forEach((v, j) => {
      result.get(v.name)!.set(bytes.subarray(off, off + widths[j]), elem * widths[j]);
      off += widths[j];
    });
  }
  return result;
}
```

  Delete `deinterleaveRowChunk` and update its direct tests to the bytes variant. `resolveChunkIndex` row branch: `bytesPerElement` becomes the post-prefix sum (`encodedByteLength(fieldPipelines?.[v.name] ?? [], v.dtype, getDtype(v.dtype).size)` per variable — null → `NoChunkIndexError`), and the chunk-pipeline `encodedByteLength` call takes `rowModeInputDtype(encSchema)`. `computeCodecLossyVariables` row branch: per-variable `isPipelineLossy(fieldPipelines?.[v.name] ?? [], v.dtype)` marks that variable; a lossy chunk pipeline still marks all.

- [ ] **Step 4: Run**: `npx vitest run` — green (update any read test pinning the old row-mode `codec_pipelines` array shape).

- [ ] **Step 5: Commit**: `git commit -m "feat(read): row-mode prefix metadata envelope and reader reversal"`

---

### Task 10: Per-step codec stats → worker payload → UI

**Files:**
- Modify: `src/engine/codecs.ts` (`runCodecPipeline` returns `stepStats`)
- Modify: `src/engine/pipelineCompute.ts` (`computeEncodedStage` aggregates `codecStats`; `EncodedStageResult`, `StagePayloads.encoded`, `PipelineResult`, `assemblePipelineResult`)
- Modify: `src/state/PipelineContext.tsx` (expose `codecStats`)
- Modify: `src/components/layout/Sidebar.tsx` (pass to `CodecSection` + `TypeAssignConfig`)
- Modify: `src/components/config/CodecPipelineEditor.tsx` (per-step lossy badge), `src/components/config/CodecSection.tsx` (thread prop), `src/components/config/TypeAssignConfig.tsx` (indicator aggregation)
- Test: `tests/unit/engine/pipeline.integration.test.ts`, `tests/unit/components/typeAssignRange.test.tsx` (or a new `codecStats.test.tsx` beside it)

**Interfaces:**
- Produces:
  - `export interface CodecStepStats { clipped: number; rounded: number }`
  - `CodecPipelineResult.stepStats: (CodecStepStats | null)[]` — aligned to the INPUT steps array (disabled or stat-less steps → null)
  - `EncodedStageResult.codecStats: Record<string, (CodecStepStats | null)[]>` — keyed by `Variable.id` (column pipelines and row prefixes) and `'chunk'` (chunk pipeline); summed across chunks
  - `PipelineResult.codecStats` (same type), through `StagePayloads.encoded` and `PipelineContext`
  - `CodecPipelineEditor` prop `stepStats?: (CodecStepStats | null)[]`; badge testid `codec-lossy-{variableSlot}-{i}`
  - `TypeAssignConfig` prop `codecStats?: Record<string, (CodecStepStats | null)[]>`

- [ ] **Step 1: Write failing tests.**
  Engine (`pipeline.integration.test.ts`):

```ts
it('encoded stage aggregates per-step transform stats per variable', () => {
  // column state: float32 var with [scale-offset, delta] pipeline, values that round
  const { codecStats } = /* computeEncodedStage result or computePipelineStages plumbing */;
  const stats = codecStats[variableId];
  expect(stats[0]!.rounded).toBeGreaterThan(0); // scale-offset reported
  expect(stats[1]).toBeNull();                  // delta reports nothing
});
```

  Component: render `CodecPipelineEditor` with `stepStats={[{ clipped: 2, rounded: 5 }]}` and assert `codec-lossy-temp-0` renders with text containing `2 clipped` and `5 rounded`; absent stats → no badge.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.**
  `runCodecPipeline`: iterate the FULL steps list; disabled → push null; enabled → run, push `result.stats ?? null`. `computeEncodedStage`: accumulate per slot key:

```ts
const codecStats: Record<string, (CodecStepStats | null)[]> = {};
const addStats = (key: string, stepStats: (CodecStepStats | null)[]) => {
  const acc = codecStats[key] ?? (codecStats[key] = stepStats.map(() => null));
  stepStats.forEach((s, i) => {
    if (!s) return;
    const a = acc[i] ?? (acc[i] = { clipped: 0, rounded: 0 });
    a.clipped += s.clipped; a.rounded += s.rounded;
  });
};
```

  Column: `addStats(variableId, result.stepStats)`. Row: `addStats(varId, prefixResult.stepStats)` per variable + `addStats('chunk', chunkResult.stepStats)` — row prefix stepStats index into the FULL field pipeline list, so pad: prefix stats land at indices `0..prefix.length-1` (remainder indices null). Thread through `StagePayloads.encoded`, `assemblePipelineResult`, `PipelineResult`, `PipelineContext` (beside `variableStats` at PipelineContext.tsx:26/87), Sidebar → `CodecSection stepStats={codecStats[v.id]}` per editor / `codecStats['chunk']` for the chunk editor, and `TypeAssignConfig codecStats={codecStats}`.
  `CodecPipelineEditor` per-step badge (beside the dtype label):

```tsx
{stepStats?.[i] && (stepStats[i]!.clipped > 0 || stepStats[i]!.rounded > 0) && (
  <span data-testid={`codec-lossy-${variableSlot}-${i}`} style={{ color: colors.warning, fontSize: 11 }}>
    lossy: {stepStats[i]!.clipped} clipped, {stepStats[i]!.rounded} rounded
  </span>
)}
```

  `TypeAssignConfig` indicator: variable is lossy when `stats.isLossy` (cast) OR any entry of `codecStats?.[v.id]` has clipped+rounded > 0; extend the detail parts list with `codec: N clipped, M rounded` (summed over steps).

- [ ] **Step 4: Run**: `npx vitest run` — green.

- [ ] **Step 5: Commit**: `git commit -m "feat(ui): per-step codec lossy stats through the worker payload"`

---

### Task 11: UI — row-mode prefix rendering, sourceDtype seeding, scenario

**Files:**
- Modify: `src/components/config/CodecSection.tsx` (row mode renders per-variable editors)
- Modify: `src/components/config/CodecPipelineEditor.tsx` (`inactiveFrom` prop; `addCodec` seeds `sourceDtype`)
- Create: `tests/ui/scenario-transform-codecs.mjs`
- Test: run scenarios against a dev server

**Interfaces:**
- Produces:
  - `CodecPipelineEditor` prop `inactiveFrom?: number` — steps at index ≥ it render at `opacity: 0.45` with note testid `codec-row-inactive-note-{variableSlot}` on the first inactive step: "inactive in row mode — output past this step has no per-element structure to interleave"
  - Row-mode `CodecSection`: one editor per variable (`inactiveFrom = steps.length - splitStructuredPrefix(steps).remainder.length`) plus the chunk editor (`inputDtype` = post-prefix mixed → `'uint8'`); the "N per-field pipelines preserved, inactive" banner is deleted (the editors now show it directly)

- [ ] **Step 1: Implement UI.**
  - `CodecSection` row branch: keep the chunk editor; add per-variable editors above it mirroring the column branch's map, passing `inactiveFrom={steps.length - splitStructuredPrefix(steps).remainder.length}` and `inputDtype={v.typeAssignment.storageDtype}`; compute the chunk editor's `inputDtype` from `pipelineOutputDtype(prefix, storageDtype)` per variable (mixed → `'uint8'`). Delete the preserved-count banner.
  - `CodecPipelineEditor`: apply `opacity: 0.45` to steps `i >= inactiveFrom`, render the note on step `inactiveFrom`. In `addCodec`, beside the `elementSize` seeding: `if (codec.params.sourceDtype) defaultParams.sourceDtype = runningDtypes[steps.length];`

- [ ] **Step 2: Write the scenario** `tests/ui/scenario-transform-codecs.mjs` on `scenario-helpers.mjs`:
  - Seed (via `seedStateAndReload` — never bare evaluate+reload) a column-mode state with one float32 variable whose field pipeline is `[quantize(digits:1), scale-offset(scale:10, targetDtype:'int16')]` (no Pyodide codecs — keep it dependency-free).
  - Checks: `codec-step-{name}-0` and `-1` render; `read-status` shows success; `codec-lossy-{name}-1` badge appears; switch interleaving to row and assert the per-variable editor still shows both steps active (all structured) and `pane` still renders.

- [ ] **Step 3: Run**: `npm run dev &`, `node tests/ui/scenario-transform-codecs.mjs`, plus `node tests/ui/scenario-curated-variables.mjs` (preset round-trips with the new pipelines, in-browser Pyodide) and `node tests/ui/scenario-hover-linking.mjs` (tracing regression). All PASS.

- [ ] **Step 4: Commit**: `git commit -m "feat(ui): row-mode prefix editors, sourceDtype seeding, transform scenario"`

---

### Task 12: Docs + full validation

**Files:**
- Modify: `CLAUDE.md` (pitfalls 3 & 4, data-testid list)
- Modify: `docs/design.md` (codec table, metadata keys — `type_assignments` removal, `codec_pipelines` row envelope)
- Modify: `src/components/guide/steps.ts` if its type-assign/codec step text names scale/offset as type-assignment features (grep `scale` there)
- Verify: full suite + scenarios

- [ ] **Step 1: Rewrite CLAUDE.md pitfall 3** — one mechanism now: typeAssignment is the bare cast; quantize/bitround/scale-offset are transform codecs; `outputDtypeFor(codec, dtype, params)` remains the single source of truth and is params-aware; `sizeEffect` drives size math (`encodedByteLength`); the handoff invariant (reversed pipeline output dtype === storageDtype) still holds.
- [ ] **Step 2: Rewrite CLAUDE.md pitfall 4** — row mode now runs each field pipeline's maximal element-structured prefix (per `splitStructuredPrefix`); only the remainder is inactive; `SET_INTERLEAVING` still never touches state. Add new testids to the conventions list: `codec-lossy-{variable}-{index}`, `codec-row-inactive-note-{variable}`.
- [ ] **Step 3: Update design.md** codec/metadata sections to match (transform category, sizeEffect column, `codec_pipelines` row envelope, `type_assignments` deletion).
- [ ] **Step 4: Full validation**: `npx vitest run` (all green); dev server + ALL `tests/ui/scenario-*.mjs` files pass.
- [ ] **Step 5: Commit**: `git commit -m "docs: codec unification reflected in CLAUDE.md and design.md"`

---

## Self-review notes (already applied)

- **Spec §1** (metadata fields) → Tasks 1-2; **§2** (three transforms) → Tasks 3-4; **§3** (shrink) → Task 7; **§4** (row prefix) → Tasks 8-9; **§5** (tracing) → Task 5; **§6** (read/metadata) → Tasks 6, 7, 9; **§7** (UI) → Tasks 10-11; **§8** (presets/persistence) → Task 7; docs → Task 12. Spec open questions resolved: decode dtype via `sourceDtype` param (deviation 3), stats via `stepStats` arrays, row execution hoisted inside the Encoded stage.
- Type consistency: `outputDtypeFor(codec, inputDtype, params)`, `pipelineOutputDtype`, `encodedByteLength`, `splitStructuredPrefix`, `CodecStepStats`, `slotFields: ChunkFieldLayout[][]`, `deinterleaveRowChunkBytes` are each defined once (task noted) and consumed by name in later tasks.
- Ordering constraint: Task 7 (shrink) MUST follow Task 6 — presets regenerate with scale-offset pipelines, which need the fixed-ratio read path to round-trip in column mode. Avroesque's prefixes are benignly inactive until Task 8 lands (values store as float32; reads stay correct).
