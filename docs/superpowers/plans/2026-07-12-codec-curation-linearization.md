# Codec Curation + Linearization/Endianness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the educational/real codec tier with one flat, curated, pedagogically ordered codec set (adding Zigzag, Bit Shuffle, Dictionary, Deflate; deleting toy LZ and Blosc), and make two byte-production choices explicit settings: linearization order (C/Fortran/Morton) and byte order (little/big) — the latter with a dedicated metadata toggle whose omission demonstrates silent data corruption.

**Architecture:** All codecs remain stride-aware bytes→bytes `CodecDefinition`s in the existing registry; internal `category` values (`'reordering'`/`'entropy'`) are unchanged (they drive dtype flow + trace degradation). Linearization order is a pure index-mapping family plugged into `chunk.ts`'s element gathering and mirrored in `layout.ts`'s coords↔offset math and the reader. Byte order threads through `valuesToBytes`/`bytesToValues` with a `'little'` default so untouched call sites stay byte-identical.

**Tech Stack:** existing engine + Pyodide/numcodecs bridge (`runPyodideCodec`); no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-12-codec-curation-linearization.md` — read it first; its decisions are binding.

## Global Constraints

- Engine stays synchronous. Unit tests in `tests/unit/`, never `src/`. prek (eslint + `tsc -b`) must pass on every commit.
- Registry insertion order IS the picker order (the picker iterates `Object.values(CODEC_REGISTRY)`); final order: `delta, zigzag, byte-shuffle, bit-shuffle, dictionary, rle, deflate, gzip, zstd`.
- No "(real)" in any label; no picker group labels — one flat option list.
- `category` internal values unchanged; new transforms are `'reordering'`, new compressors `'entropy'`.
- Defaults preserve today's bytes exactly: `linearization: 'c'`, `byteOrder: 'little'` must be byte-identical to current output (pinned by existing tests continuing to pass unmodified except where a signature changed).
- The endianness assume-host read path must NOT fail or mark lossy — silent success with wrong values is the lesson (spec risk 5).
- Per-element data never crosses the worker boundary (PERF-1): Morton permutations are derived on demand on each side, never serialized into results.
- Pyodide-runtime tests: wrap in `describe.skipIf(!!process.env.SKIP_PYODIDE)`, Node loader `loadPyodide({ packageCacheDir: 'node_modules/.cache/pyodide' })`.
- Scenario conventions per CLAUDE.md; dev server serves `http://localhost:5173/0x00c0dec5/` (start it yourself).

---

### Task 1: Registry curation — add Zigzag + Bit Shuffle, delete LZ + Blosc, reorder, de-"(real)" labels

**Files:**
- Modify: `src/engine/codecs.ts`
- Test: `tests/unit/engine/codecs.test.ts` (key list + new codec roundtrips), `tests/unit/engine/realCodecs.test.ts` (remove blosc), any other test referencing `'lz'`/`'blosc'` (grep)

**Interfaces:**
- Consumes: existing `CodecDefinition`, `getDtype`, `runPyodideCodec` (untouched).
- Produces: registry keys in exact order `delta, zigzag, byte-shuffle, bit-shuffle, dictionary*, rle, deflate*, gzip, zstd` (*added by Tasks 2–3; leave their slots as insertion points with a comment). Keys `lz` and `blosc` gone. Labels `GZip`/`Zstd` (no suffix).

- [ ] **Step 1: Write failing tests** — in `tests/unit/engine/codecs.test.ts` add:

```ts
describe('zigzag codec', () => {
  it('is applicable to signed ints only', () => {
    const z = CODEC_REGISTRY['zigzag'];
    expect(z.category).toBe('reordering');
    expect(z.applicableTo('int16')).toBe(true);
    expect(z.applicableTo('int32')).toBe(true);
    expect(z.applicableTo('uint16')).toBe(false);
    expect(z.applicableTo('float32')).toBe(false);
  });
  it('maps small magnitudes to small unsigned values and round-trips exactly', () => {
    const values = [0, -1, 1, -2, 2, -100, 100, -32768, 32767];
    const bytes = valuesToBytes(values, 'int16');
    const enc = CODEC_REGISTRY['zigzag'].encode(bytes, 'int16', {});
    expect(enc.outputDtype).toBe('int16'); // dtype-preserving (stride unchanged)
    // zigzag(0)=0, zigzag(-1)=1, zigzag(1)=2, zigzag(-2)=3, zigzag(2)=4
    const encVals = bytesToValues(enc.bytes, 'uint16');
    expect(Array.from(encVals as Float64Array).slice(0, 5)).toEqual([0, 1, 2, 3, 4]);
    const dec = CODEC_REGISTRY['zigzag'].decode(enc.bytes, 'int16', {});
    expect(Array.from(bytesToValues(dec.bytes, 'int16') as Float64Array)).toEqual(values);
  });
  it('isLossy false for signed ints', () => {
    expect(CODEC_REGISTRY['zigzag'].isLossy('int16')).toBe(false);
  });
});

describe('bit-shuffle codec', () => {
  it('round-trips exactly for every multi-byte dtype and elementSize', () => {
    for (const dtype of ['int16', 'int32', 'float32', 'float64'] as const) {
      const values = Array.from({ length: 64 }, (_, i) => i - 32);
      const bytes = valuesToBytes(values, dtype);
      const enc = CODEC_REGISTRY['bit-shuffle'].encode(bytes, dtype, {});
      expect(enc.bytes.length).toBe(bytes.length); // size-preserving
      expect(enc.outputDtype).toBe(dtype);
      const dec = CODEC_REGISTRY['bit-shuffle'].decode(enc.bytes, dtype, {});
      expect(Array.from(dec.bytes)).toEqual(Array.from(bytes));
    }
  });
  it('groups same-position bits: constant data becomes all-0xFF/0x00 planes', () => {
    // 32 identical int16 values of 1 => bit plane 0 is all ones, rest zeros
    const bytes = valuesToBytes(new Array(32).fill(1), 'int16');
    const enc = CODEC_REGISTRY['bit-shuffle'].encode(bytes, 'int16', {});
    const counts = new Map<number, number>();
    for (const b of enc.bytes) counts.set(b, (counts.get(b) ?? 0) + 1);
    // Only two byte values appear (0x00 and 0xFF): perfect plane separation
    expect([...counts.keys()].sort()).toEqual([0, 255]);
  });
  it('handles trailing bytes not filling a whole element block (passes them through)', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]); // int16 stride 2 -> 1 leftover byte
    const enc = CODEC_REGISTRY['bit-shuffle'].encode(bytes, 'int16', {});
    const dec = CODEC_REGISTRY['bit-shuffle'].decode(enc.bytes, 'int16', {});
    expect(Array.from(dec.bytes)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('curation', () => {
  it('registry has the exact curated order (picker order source of truth)', () => {
    // dictionary/deflate join in Tasks 2-3; assert relative order of what exists now
    const keys = Object.keys(CODEC_REGISTRY);
    const expectOrder = ['delta', 'zigzag', 'byte-shuffle', 'bit-shuffle', 'rle', 'gzip', 'zstd'];
    expect(keys.filter((k) => expectOrder.includes(k))).toEqual(expectOrder);
  });
  it('lz and blosc are gone', () => {
    expect(CODEC_REGISTRY['lz']).toBeUndefined();
    expect(CODEC_REGISTRY['blosc']).toBeUndefined();
  });
  it('no label contains "(real)"', () => {
    for (const c of Object.values(CODEC_REGISTRY)) expect(c.label).not.toContain('(real)');
  });
});
```

Adjust the file's existing registry-key-list test to the new set. Update `realCodecs.test.ts`: remove blosc from `REAL_KEYS` and delete the blosc-shuffle test.

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/unit/engine/codecs.test.ts` → FAIL (zigzag/bit-shuffle undefined).

- [ ] **Step 3: Implement.** In `src/engine/codecs.ts`:

Zigzag (place after delta):

```ts
const zigzagCodec: CodecDefinition = {
  key: 'zigzag',
  label: 'Zigzag',
  category: 'reordering',
  description:
    'Maps signed integers to unsigned so small magnitudes get small byte values '
    + '(0→0, −1→1, 1→2, −2→3 …) — Parquet applies this before RLE/bit-packing. '
    + 'Bijective; byte width unchanged.',
  params: {},
  applicableTo: (dtype) => ['int8', 'int16', 'int32'].includes(dtype),
  isLossy: () => false,
  encode(bytes, inputDtype) {
    return { bytes: zigzagMap(bytes, inputDtype as DtypeKey, 'encode'), outputDtype: inputDtype };
  },
  decode(bytes, encodedDtype) {
    return { bytes: zigzagMap(bytes, encodedDtype as DtypeKey, 'decode'), outputDtype: encodedDtype };
  },
};

/** Per-element zigzag within the dtype's width. Uses 32-bit int math (widest
 * supported signed dtype is int32); encode: (n<<1)^(n>>31) on the
 * sign-extended value, masked back to the dtype width; decode: (u>>>1)^-(u&1). */
function zigzagMap(bytes: Uint8Array, dtype: DtypeKey, op: 'encode' | 'decode'): Uint8Array {
  const size = getDtype(dtype).size;
  const out = new Uint8Array(bytes.length);
  const inView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const outView = new DataView(out.buffer);
  const count = Math.floor(bytes.length / size);
  for (let i = 0; i < count; i++) {
    const off = i * size;
    if (op === 'encode') {
      const n = size === 1 ? inView.getInt8(off) : size === 2 ? inView.getInt16(off, true) : inView.getInt32(off, true);
      const z = ((n << 1) ^ (n >> 31)) >>> 0;
      if (size === 1) outView.setUint8(off, z & 0xff);
      else if (size === 2) outView.setUint16(off, z & 0xffff, true);
      else outView.setUint32(off, z, true);
    } else {
      const z = size === 1 ? inView.getUint8(off) : size === 2 ? inView.getUint16(off, true) : inView.getUint32(off, true);
      const n = (z >>> 1) ^ -(z & 1);
      if (size === 1) outView.setInt8(off, n);
      else if (size === 2) outView.setInt16(off, n, true);
      else outView.setInt32(off, n, true);
    }
  }
  // Trailing partial element (shouldn't occur in practice): copy through.
  for (let i = count * size; i < bytes.length; i++) out[i] = bytes[i];
  return out;
}
```

Bit Shuffle (place after byte-shuffle):

```ts
const bitShuffleCodec: CodecDefinition = {
  key: 'bit-shuffle',
  label: 'Bit Shuffle',
  category: 'reordering',
  description:
    'Byte Shuffle one level finer: transposes the BITS of a block of elements '
    + 'into bit planes (all elements’ bit 0, then bit 1, …). Slowly varying '
    + 'data yields long constant bit runs — the transform inside blosc/bitshuffle.',
  params: {},
  applicableTo: (dtype) => getDtype(dtype as DtypeKey).size > 1,
  isLossy: () => false,
  encode(bytes, inputDtype) {
    return { bytes: bitTranspose(bytes, getDtype(inputDtype as DtypeKey).size, 'encode'), outputDtype: inputDtype };
  },
  decode(bytes, encodedDtype) {
    return { bytes: bitTranspose(bytes, getDtype(encodedDtype as DtypeKey).size, 'decode'), outputDtype: encodedDtype };
  },
};

/** Transpose bits within each whole block of elements. Block = all complete
 * elements (count*stride bytes); trailing bytes copied through unchanged.
 * encode: output bit-plane p (p in [0, stride*8)) holds bit p of every
 * element, packed in element order. decode is the inverse permutation.
 * O(bits) with plain loops — a chunk is at most tens of MB and this runs in
 * the worker; ponytail: no SIMD/word tricks until profiling asks. */
function bitTranspose(bytes: Uint8Array, stride: number, op: 'encode' | 'decode'): Uint8Array {
  const count = Math.floor(bytes.length / stride);
  const blockBytes = count * stride;
  const out = new Uint8Array(bytes.length);
  const bitsPerElement = stride * 8;
  const getBit = (arr: Uint8Array, bit: number) => (arr[bit >> 3] >> (bit & 7)) & 1;
  const setBit = (arr: Uint8Array, bit: number, v: number) => { if (v) arr[bit >> 3] |= 1 << (bit & 7); };
  for (let el = 0; el < count; el++) {
    for (let p = 0; p < bitsPerElement; p++) {
      const elementBit = el * bitsPerElement + p;   // bit position in element order
      const planeBit = p * count + el;              // bit position in plane order
      if (op === 'encode') setBit(out, planeBit, getBit(bytes, elementBit));
      else setBit(out, elementBit, getBit(bytes, planeBit));
    }
  }
  for (let i = blockBytes; i < bytes.length; i++) out[i] = bytes[i];
  return out;
}
```

Then: delete the `lz` codec definition and the `blosc` entry (and `bloscCodec` factory usage), remove " (real)" from gzip/zstd labels, and rebuild `CODEC_REGISTRY` in the curated insertion order with comment markers where `dictionary` (Task 2) and `deflate` (Task 3) will slot in.

- [ ] **Step 4: Run new tests** → PASS. **Step 5:** grep for remaining `'lz'`/`'blosc'` refs in `src/` and `tests/unit/` (NOT `tests/ui/` — scenarios are later tasks); fix them. **Step 6:** `npx vitest run` full suite → PASS. **Step 7: Commit** `feat: curate codec registry — add zigzag/bit-shuffle, drop lz/blosc, pedagogical order`.

---

### Task 2: Dictionary codec

**Files:**
- Modify: `src/engine/codecs.ts` (insert at its marked slot, before `rle`)
- Test: `tests/unit/engine/dictionaryCodec.test.ts` (new)

**Interfaces:**
- Produces: registry key `dictionary`, `category: 'entropy'` (uint8 output via the existing `outputDtypeFor` rule), self-contained byte format `[u8 stride][u32le dictCount][dictCount*stride dict bytes][u8 indexWidth][indices little-endian]` where `indexWidth` ∈ {1,2,4} is the smallest that holds `dictCount-1`.

- [ ] **Step 1: Write failing tests** (`tests/unit/engine/dictionaryCodec.test.ts`):

```ts
import { describe, it, expect } from 'vitest';
import { CODEC_REGISTRY, runCodecPipeline } from '../../../src/engine/codecs.ts';
import { reverseCodecPipeline } from '../../../src/engine/decode.ts';
import { valuesToBytes } from '../../../src/engine/elements.ts';

const dict = () => CODEC_REGISTRY['dictionary'];

describe('dictionary codec', () => {
  it('is an entropy codec applicable to everything', () => {
    expect(dict().category).toBe('entropy');
    expect(dict().applicableTo('float64')).toBe(true);
    expect(dict().isLossy('int16')).toBe(false);
  });
  it('low-cardinality data shrinks; format fields are as specified', () => {
    const values = Array.from({ length: 1000 }, (_, i) => [10, 20, 30][i % 3]);
    const bytes = valuesToBytes(values, 'int32'); // 4000 bytes
    const enc = dict().encode(bytes, 'int32', {});
    expect(enc.outputDtype).toBe('uint8');
    // header: stride=4, dictCount=3, indexWidth=1 -> 1+4+12+1+1000 = 1018
    expect(enc.bytes.length).toBe(1018);
    expect(enc.bytes[0]).toBe(4); // stride
    expect(new DataView(enc.bytes.buffer, enc.bytes.byteOffset).getUint32(1, true)).toBe(3);
    expect(enc.bytes[17]).toBe(1); // indexWidth after 12 dict bytes
  });
  it('round-trips exactly for every fixed-stride dtype including charN', () => {
    for (const [dtype, vals] of [
      ['int16', [5, -5, 5, 5, -5, 100]],
      ['float64', [1.5, 2.5, 1.5, NaN, 2.5, 1.5]], // NaN: byte-level dedup, still exact
      ['char4', ['ab', 'cd', 'ab', '', 'cd', 'ab']],
    ] as const) {
      const bytes = valuesToBytes(vals as never, dtype as never);
      const enc = dict().encode(bytes, dtype as string, {});
      const dec = dict().decode(enc.bytes, dtype as string, {});
      expect(Array.from(dec.bytes), dtype as string).toEqual(Array.from(bytes));
    }
  });
  it('promotes indexWidth for >255 and >65535 distinct values', () => {
    const many = Array.from({ length: 300 }, (_, i) => i);
    const enc = dict().encode(valuesToBytes(many, 'int32'), 'int32', {});
    const stride = enc.bytes[0];
    const dictCount = new DataView(enc.bytes.buffer, enc.bytes.byteOffset).getUint32(1, true);
    expect(dictCount).toBe(300);
    expect(enc.bytes[1 + 4 + dictCount * stride]).toBe(2); // u16 indices
    const dec = dict().decode(enc.bytes, 'int32', {});
    expect(Array.from(dec.bytes)).toEqual(Array.from(valuesToBytes(many, 'int32')));
  });
  it('handles empty input', () => {
    const enc = dict().encode(new Uint8Array(0), 'int32', {});
    const dec = dict().decode(enc.bytes, 'int32', {});
    expect(dec.bytes.length).toBe(0);
  });
  it('composes: dictionary -> zstd would decode via reverseCodecPipeline (decode side dtype flow)', () => {
    const values = Array.from({ length: 256 }, (_, i) => [7, 8][i % 2]);
    const input = valuesToBytes(values, 'int16');
    const steps = [{ codec: 'dictionary', params: {} }];
    const enc = runCodecPipeline(input, steps, 'int16');
    const dec = reverseCodecPipeline(enc.bytes, steps, 'int16');
    expect(dec.outputDtype).toBe('int16');
    expect(Array.from(dec.bytes)).toEqual(Array.from(input));
  });
});
```

NOTE: decode receives `encodedDtype` (`'uint8'` from the dtype chain) — it must NOT need the original dtype: stride is in the header. The decode signature's dtype argument is ignored (name it `_encodedDtype`).

- [ ] **Step 2: verify FAIL. Step 3: Implement** — encoder: iterate stride-sized byte tuples, dedupe with a `Map<string, number>` keyed by the tuple's byte string (`String.fromCharCode` over the bytes — exact, handles NaN payloads), dictionary in first-appearance order, then header + dict + indexWidth + indices. Decoder: parse header, expand indices. Empty input → `[stride][0][width=1]`-less: just return `new Uint8Array(0)` on both sides (match house empty-input convention). Place the definition at the marked slot before `rle`.

- [ ] **Step 4: tests PASS. Step 5: full suite PASS. Step 6: Commit** `feat: dictionary codec — Parquet's workhorse, self-contained format`.

---

### Task 3: Deflate codec (numcodecs Zlib)

**Files:**
- Modify: `src/engine/codecs.ts` (marked slot between `rle` and `gzip`)
- Test: extend `tests/unit/engine/realCodecs.test.ts`

**Interfaces:** registry key `deflate`, label `Deflate`, `runtime: 'pyodide'`, params `{ level: 1..9, default 6 }`, numcodecs config `{ id: 'zlib', level }`.

- [ ] **Step 1: failing test** — add `'deflate'` to `REAL_KEYS` in `realCodecs.test.ts` (it flows through the existing per-key round-trip matrix) plus one wrapper-comparison test in the real-runtime describe:

```ts
  it('deflate (zlib wrapper) differs from gzip only by container: gzip starts 1f 8b, zlib does not', () => {
    const input = sampleBytes('int16');
    const gz = runCodecPipeline(input, [{ codec: 'gzip', params: { level: 6 } }], 'int16');
    const df = runCodecPipeline(input, [{ codec: 'deflate', params: { level: 6 } }], 'int16');
    expect([gz.bytes[0], gz.bytes[1]]).toEqual([0x1f, 0x8b]);
    expect([df.bytes[0], df.bytes[1]]).not.toEqual([0x1f, 0x8b]);
  });
```

- [ ] **Step 2: FAIL. Step 3:** implement via the existing `pyodideCodec` factory: key `deflate`, description "The algorithm inside GZip, in a bare zlib container — compare the first bytes with GZip's 1f 8b magic: same compressed stream, different wrapper.", config `(p) => ({ id: 'zlib', level: Number(p.level ?? 6) })`. Insert at the marked slot. **Step 4:** `npx vitest run tests/unit/engine/realCodecs.test.ts tests/unit/engine/codecs.test.ts` PASS (update Task 1's order test to include `dictionary`/`deflate` now that all slots are filled: full expected key order `['delta','zigzag','byte-shuffle','bit-shuffle','dictionary','rle','deflate','gzip','zstd']`). **Step 5:** full suite PASS. **Step 6: Commit** `feat: deflate codec via numcodecs zlib — wrapper-vs-algorithm lesson`.

---

### Task 4: Picker flat list + neutral banner copy

**Files:**
- Modify: `src/components/config/CodecPipelineEditor.tsx` (AddCodecSelect), `src/components/layout/RuntimeBanner.tsx`
- Test: `tests/unit/components/codecPickerRuntime.test.tsx` (rewrite), `tests/unit/components/runtimeBanner.test.tsx` (copy updates)
- Scenario: `tests/ui/scenario-real-codecs.mjs` (it asserts the old copy/behavior — recalibrate its checks: error banner prefix becomes "Compression codecs unavailable", zstd-enablement checks unchanged)

**Interfaces:** `AddCodecSelect` renders ONE flat `<option>` list (no `<optgroup>`), in registry insertion order; pyodide-backed entries disabled with the existing `(loading…)`/`(unavailable)` suffixes when `runtimeStatus !== 'ready'`. `codec-group-real` testid deleted. Banner copy: loading prefix "Loading compression runtime:", error "Compression codecs unavailable: {error}. Everything else works — the other codecs are unaffected."

- [ ] **Step 1:** rewrite `codecPickerRuntime.test.tsx`: assert (a) no `optgroup` elements at all; (b) option values in exact registry order `['delta','zigzag','byte-shuffle','bit-shuffle','dictionary','rle','deflate','gzip','zstd']` (after the placeholder option); (c) `deflate`/`gzip`/`zstd` disabled when loading, enabled when ready; local codecs always enabled; (d) default-ready behavior for prop-less callers unchanged. Update `runtimeBanner.test.tsx` expected strings.
- [ ] **Step 2: FAIL. Step 3:** implement both components. **Step 4:** component tests PASS; full suite PASS. **Step 5:** start the dev server, run `node tests/ui/scenario-real-codecs.mjs` — recalibrate its banner-copy assertions (this task owns them); all PASS. **Step 6: Commit** `feat: flat pedagogically-ordered codec picker; neutral runtime banner copy`.

---

### Task 5: Linearization order module (pure) — the Morton spike

**Files:**
- Create: `src/engine/order.ts`
- Test: `tests/unit/engine/order.test.ts`

**Interfaces (later tasks rely on these exact names):**

```ts
export type LinearizationOrder = 'c' | 'fortran' | 'morton';
export const LINEARIZATION_ORDERS: LinearizationOrder[] = ['c', 'fortran', 'morton'];
/** Position of element `coords` (within a chunk of `dims`) in the linearized
 * element sequence. Bijective over [0, product(dims)). */
export function orderIndexOf(coords: number[], dims: number[], order: LinearizationOrder): number;
/** Inverse of orderIndexOf. */
export function orderCoordsOf(index: number, dims: number[], order: LinearizationOrder): number[];
/** Memoized permutation pair for one dims/order combination:
 * perm[linearIndex] = cOrderFlatIndex, inv[cOrderFlatIndex] = linearIndex.
 * Cache keyed by `${order}:${dims.join(',')}`, capped at 32 entries (chunk
 * dims repeat across chunks; edge-clipped variants add a few). Returns null
 * for 'c' (identity — callers use closed-form math and skip the arrays). */
export function orderPermutation(dims: number[], order: LinearizationOrder): { perm: Uint32Array; inv: Uint32Array } | null;
```

Semantics: `'c'` = row-major (identity vs today's `coordsToFlatIndex`); `'fortran'` = column-major (first dimension varies fastest); `'morton'` = elements sorted by bit-interleaved coordinate key (interleave per-dimension bits, LSB-first round-robin across dimensions, using each dimension's own bit width `ceil(log2(dim))`; ties impossible — keys are distinct), then COMPACTED to a dense [0, n) sequence by sorting the occupied keys. This is total and bijective for arbitrary (edge-clipped, non-power-of-two) dims. For 1-D dims, every order is the identity.

- [ ] **Step 1: failing tests** — property-style over shapes `[4,4]`, `[3,5]`, `[7,3,2]`, `[1,9]`, `[8]`, `[2047,3]`-scale spot check:
  - bijectivity: for every order, `orderCoordsOf(orderIndexOf(coords))` is identity over all elements, and the set of indices is exactly `[0, n)`;
  - `'c'` matches `coordsToFlatIndex` exactly (import from `chunk.ts`);
  - `'fortran'` on `[2,3]`: element order `(0,0),(1,0),(0,1),(1,1),(0,2),(1,2)` — assert the exact sequence;
  - `'morton'` on `[4,4]`: assert the exact classic Z curve prefix `(0,0),(0,1)…` — compute the expected first 8 by hand per the LSB-first convention chosen and pin them (document the convention in the test);
  - `orderPermutation` consistency: `perm`/`inv` agree with the scalar functions; `'c'` returns null; cache returns the same object for repeat calls.
- [ ] **Step 2: FAIL. Step 3: implement** (`morton` via key computation + `Uint32Array` argsort; scalar `orderIndexOf`/`orderCoordsOf` for morton delegate to the memoized permutation — O(1) after first call per dims). **Step 4: PASS. Step 5:** full suite. **Step 6: Commit** `feat: linearization order module — c/fortran/morton, bijective under edge-clipped dims`.

---

### Task 6: Linearization threading — state, chunking, layout/tracing, metadata, reader

The big integration task. **Read CLAUDE.md pitfalls 1 and 7 first.**

**Files:**
- Modify: `src/types/state.ts` (`linearization: LinearizationOrder` on AppState + DEFAULT_STATE `'c'`), `src/state/useAppState.ts` (`SET_LINEARIZATION` action), `src/state/persistence.ts` (backfill `'c'`)
- Modify: `src/engine/chunk.ts` (element gathering honors order), `src/engine/pipelineCompute.ts` (pass `state.linearization` into the linearized stage + its memo key), `src/engine/layout.ts` (coords↔offset math honors order), `src/engine/metadata.ts` (layout group gains `linearization`), `src/engine/read.ts` (reader de-linearizes per metadata)
- Test: `tests/unit/engine/linearizationRoundtrip.test.ts` (new), extend `tests/unit/engine/layout.reverse.test.ts` + `tests/unit/helpers/referenceTraces.ts`

**Interfaces:**
- Consumes: Task 5's `order.ts` exports.
- Produces: `AppState.linearization`; chunk gathering + `ChunkBlockRegion` layout math + reader all take the order; metadata layout entry key `linearization: 'c' | 'fortran' | 'morton'`.

**Key implementation points (verified against current source):**
- `chunk.ts` ~line 170: the per-chunk gather loop `for i < totalElements: localCoords = flatIndexToCoords(i, chunkExtent)` becomes `localCoords = orderCoordsOf(i, chunkExtent, order)` — that single substitution changes the element sequence feeding `chunk.variables[].values`, and therefore the linearized bytes. Thread `order` as a parameter from `chunkData`/`chunkDataPerVariable` (callers in `pipelineCompute.ts` pass `state.linearization`).
- `layout.ts`: `ChunkBlockRegion` gains `order: LinearizationOrder` (buildLinearizedLayout/buildEncodedLayout record it); every place converting between an element's in-chunk coords and its byte offset within the chunk region (`traceAt`'s chunk-region branch, `elementInChunk`, `chunkIdForElement`, `byteRangesForTrace`) replaces its implicit C-order flat-index math with `orderIndexOf`/`orderCoordsOf`. Grep for `coordsToFlatIndex`/`flatIndexToCoords` usages inside layout.ts and audit EACH.
- `referenceTraces.ts` is the frozen reference tracer — extend it deliberately (it may only support 'c'; parameterize it with the same order functions so the equivalence tests can pin all three orders).
- `metadata.ts`: inside an existing `include.layout` block, add `linearization` (only for array model / ndim>1, matching where chunk grid info lives). `read.ts`: parse it (default `'c'` when the layout group is present but the key absent — old files); the reconstruct path's de-linearization mirrors the gather loop with `orderCoordsOf`.
- Worker memo keys: `pipelineCompute.ts`'s linearized-stage deps object gains `linearization: state.linearization` (downstream keys chain automatically).
- PERF-1 constraint: `ChunkBlockRegion.order` is a STRING; permutations are derived via `orderPermutation` on whichever side needs them. Never put `Uint32Array` permutations in regions.

- [ ] **Step 1: failing tests** (`linearizationRoundtrip.test.ts`): for each order × interleaving (row/column) × shape (`[6,4]` chunkShape `[4,3]` → edge-clipped chunks, plus a 3-D case): `computePipelineStages(state)` → `readResult.success` true and `reconstructedValues` exactly equal `logicalValues` for every variable; `'c'` output bytes byte-identical to a pre-change snapshot (pin by computing with DEFAULT-ish state and asserting the linearized stage bytes match the current implementation's — capture the expected bytes BEFORE making changes and hard-code them, or assert `'c'` equals the result of the old inline math reproduced in the test). Also: layout equivalence — `traceAt` at sampled offsets for fortran/morton returns traces whose (variableName, coords, displayValue) round-trip through `byteRangesForTrace` back to the same offset.
- [ ] **Step 2: FAIL. Step 3–6:** implement in the order above (state → chunk → pipelineCompute → layout → referenceTraces → metadata → read), running the roundtrip test as you go. **Step 7:** full suite PASS — pay attention to layout.reverse.test.ts and pipelineLayouts.test.ts (their fixtures now need `order: 'c'` on chunk regions). **Step 8: Commit** `feat: linearization order threaded — chunking, tracing, metadata, reader`.

---

### Task 7: Linearization UI

**Files:**
- Modify: `src/components/config/ChunkConfig.tsx` (54 lines today — add the select), `src/components/layout/Sidebar.tsx` (pass state/dispatch if not already)
- Test: `tests/unit/components/chunkConfig.test.tsx` (new or extend existing)

**Interfaces:** `linearization-select` (`data-testid`), options C order / Fortran order / Morton (Z-order) with one-line title tooltips; rendered ONLY when `dataModel === 'array' && shape.length > 1`; dispatches `SET_LINEARIZATION`.

- [ ] Steps: failing component test (renders for 2-D array model; hidden for tabular and 1-D; change dispatches the action) → FAIL → implement (follow the section's existing control idioms/inline styles) → PASS → full suite → Commit `feat: linearization select in Chunk section`.

---

### Task 8: Endianness engine — byteOrder threading + assume-host read lesson

**Files:**
- Modify: `src/engine/elements.ts` (`valuesToBytes`/`bytesToValues` gain `byteOrder: 'little' | 'big' = 'little'`), `src/engine/typeAssign.ts`, `src/engine/linearize.ts`, `src/engine/pipelineCompute.ts`, `src/engine/read.ts`, `src/engine/metadata.ts`, `src/types/state.ts` (+`byteOrder`, default `'little'`), `src/state/useAppState.ts` (`SET_BYTE_ORDER`), `src/state/persistence.ts` (backfill), metadata include types (the include config type gains `endianness: boolean`, default true — find it via `MetadataIncludeConfig`/`include-schema-toggle` grep)
- Test: `tests/unit/engine/endianness.test.ts` (new)

**Key points:**
- `elements.ts:38` and `:85` currently hardcode `true` (LE) — the new param lands exactly there. Char dtypes ignore it (byte-per-char).
- Threading spine (audit ALL `valuesToBytes`/`bytesToValues` call sites — 6 files, listed in the spec's risk 4): `typeAssign.assignType` (storage bytes) and its reverse, `linearize.buildBytes`, `pipelineCompute.computeTypedStage`'s `bytesToValues` read-back, and `read.ts`'s decode paths take the byteOrder; `buildLogicalValuesStage` (Values/Read display stages) ALSO takes it — one uniform rule: every value↔byte conversion in the pipeline honors `byteOrder`. Codec paths (`bytesToValues` inside codecs.ts, e.g. dictionary tests) do NOT — codecs are byte-domain; leave their call sites on the default.
- `metadata.ts`: new entry `byte_order: state.byteOrder` gated by `include.endianness` (its own flag, NOT inside `include.layout`).
- `read.ts`: `const byteOrder = parsedMeta.byte_order ?? hostByteOrder()` where `hostByteOrder()` returns `'little'` (browsers/Node are LE; write it as a real check via `new Uint8Array(Uint16Array.of(1).buffer)[0] === 1 ? 'little' : 'big'` so the code is honest). When the entry is ABSENT, the read process step that decodes chunks appends detail text: `byte order not recorded — assuming host (little-endian)`. **DO NOT fail or mark lossy** (spec risk 5). Memo keys: metadata/write stages already key on whole `state`; typed/linearized deps objects gain `byteOrder`.
- Worker memo keys: typed-stage deps gain `byteOrder: state.byteOrder` (values stage does NOT need it — logical generation is byte-order-free; but `buildLogicalValuesStage` output bytes change → values STAGE bytes depend on it → values deps gain it too. Check each stage's deps against what now reads byteOrder.)

- [ ] **Step 1: failing tests** (`endianness.test.ts`):
  - `valuesToBytes([0x1234], 'int16', 'big')` → `[0x12, 0x34]`; little → `[0x34, 0x12]`; default param = little (byte-identical to today).
  - Full-pipeline BE round-trip: `computePipelineStages({...state, byteOrder: 'big'})` (metadata endianness INCLUDED) → read success, reconstructed === logical exactly.
  - **The silent-corruption case:** state with `byteOrder: 'big'` and `metadata.include.endianness: false` → `readResult.success === true`, no failed step, AND `reconstructedValues` ≠ `logicalValues` for a multi-byte numeric variable (assert at least one value differs), AND the decode step's detail contains "assuming host".
  - LE + excluded endianness → still round-trips exactly (host matches authoring — the control case).
- [ ] **Step 2: FAIL. Steps 3–5:** thread it (elements → typeAssign → linearize → pipelineCompute + memo deps → metadata → read + narration). **Step 6:** full suite PASS (existing tests unchanged — default param proves byte-identity). **Step 7: Commit** `feat: byteOrder threaded through the pipeline; endianness metadata entry with assume-host read`.

---

### Task 9: Endianness + metadata-toggle UI

**Files:**
- Modify: `src/components/config/ChunkConfig.tsx` (byte-order control beside linearization), the metadata include-config component (6th row: `include-endianness-toggle`), `src/components/layout/Sidebar.tsx` as needed
- Test: extend `tests/unit/components/chunkConfig.test.tsx` + the existing metadata-toggles component test (grep `metadataToggles.test.tsx`)

**Interfaces:** `byte-order-toggle` (`data-testid`; radio or two-option toggle little/big, visible both models, all ndims), dispatches `SET_BYTE_ORDER`. `include-endianness-toggle` follows the exact idiom of the five existing include toggles; its helper/description text states the lesson: "off: the reader assumes the host's byte order — reads may silently succeed with wrong values."

- [ ] Steps: failing component tests (toggle renders both models; dispatches; include row toggles `metadata.include.endianness`) → FAIL → implement → PASS → full suite → Commit `feat: byte-order control + endianness include toggle`.

---

### Task 10: Content — presets, guide, scenarios

**Files:**
- Modify: `src/presets/basically-parquet.json` (add `zigzag` and/or `dictionary` ahead of its existing delta+rle where pedagogically sensible; ensure `linearization`/`byteOrder` fields present with defaults), `basically-zarr.json` (zstd showcase; fields), `basically-geotiff.json` (fields; review codec fit), and the preset loader's validation if it rejects unknown fields (check `src/state/presets.ts`)
- Modify: guide content (locate via `src/components/guide/` + `GuideContext` — the per-section teaching steps): codec section text reflects the new flat set; Chunk section gains a linearization beat; Metadata section gains the endianness silent-corruption beat
- Modify/verify: `tests/ui/scenario-talk-arc.mjs` (delta+rle beats — should pass unchanged; run it), `tests/ui/scenario-presets.mjs`
- Create: `tests/ui/scenario-linearization-endianness.mjs` — checks: (a) linearization select hidden for tabular, visible for 2-D array; (b) switching C→Morton changes Linearized-stage bytes (pipeline strip byte counts equal but hex first-row differs) and Read still round-trips; (c) byte-order big + endianness include ON → read succeeds ("File parsed successfully"); (d) byte-order big + endianness include OFF → read still reports success BUT the Read-stage diff/table shows values differing from Values stage (assert via table-cell text mismatch or read-process step detail containing "assuming host"); (e) no pageerrors.

- [ ] Steps: update presets + loader → guide text → run `npx vitest run` (presets tests exist — `gen-presets`/roundtrip tests may pin preset JSON; update them) → write scenario, calibrate selectors against live DOM per house convention → run the FULL scenario suite (all `tests/ui/scenario-*.mjs`) green → Commit `feat: presets/guide updated for curated codecs + linearization/endianness; scenario`.

---

### Task 11: Docs + final verification

**Files:**
- Modify: `docs/design.md` (codec table + new settings), `CLAUDE.md` (testids: remove `codec-group-real`; add `linearization-select`, `byte-order-toggle`, `include-endianness-toggle` with the silent-corruption note; scenario list gains `scenario-linearization-endianness.mjs`), `notes/improvement-ideas.md` (curation decision note; sharding rejection rationale)

- [ ] Steps: docs edits → `npx vitest run` (all green) → `npm run lint` (0 errors) → `npm run build` (clean) → full scenario suite (all files, exit 0) → Commit `docs: codec curation + linearization/endianness complete`.
