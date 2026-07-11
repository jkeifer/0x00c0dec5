# Performance Viewers & Hot Paths Implementation Plan (Spec Phases 4–5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the two remaining viewers work at 1M-element scale (canvas GridView, windowed HexView with a clickable file-map overview) and fix the two engine hot paths (LZ hash-chain matching, sig-fig generation rounding), with a soft element-cap banner replacing the obsolete 10K warning.

**Architecture:** GridView gains a canvas rendering mode above a cell threshold — one ImageData pixel per element, colored by the same value→color ramp the DOM cells use (extracted to pure, unit-testable helpers); hover becomes mouse-position→coordinate math. HexView gains a per-section windowed mode above a row threshold — a canvas file-map strip (colored from the section's `StageLayout` regions) navigates a bounded row window, replacing unbounded virtual scroll that breaks past browser element-height caps (~17.9M px Firefox). The LZ codec's O(n×window) backward scan becomes hash-chain matching with the byte format frozen (roundtrip-pinned); `toPrecision` string rounding in generation becomes arithmetic.

**Tech Stack:** React 19 + TypeScript + Vite (base `/0x00c0dec5/`), vitest (unit tests in `tests/unit/`), Playwright scenario harness (`tests/ui/scenario-helpers.mjs`), Canvas 2D (no new dependencies).

**Context this plan builds on (Phases 1–3, complete):** per-stage `StageLayout` descriptors + `traceAt`/`byteRangesForTrace`/`chunkRegionsOf` (`src/engine/layout.ts`); worker-backed compute (`src/engine/pipelineCompute.ts`, `src/worker/`); `useWorkerPipeline` with stale-view UX; equivalence pinning vs `tests/unit/helpers/referenceTraces.ts`. **Phase 1–3 exit numbers (Task 16 commit `aa73769`):** 1M elements × 3 vars ≈ 2.2s total — values 1003ms / typed 841ms (generation-dominated: `toPrecision` per element), linearized 308ms; encoded/write/read <20ms each — measured with EMPTY codec pipelines, so LZ cost is unmeasured and the naive scan is the known cliff.

## Global Constraints

- **No new dependencies.** Canvas 2D and existing libraries only.
- **New unit tests go in `tests/unit/`** (mirroring the src path), NOT `src/` — user requirement; Playwright scenarios stay in `tests/ui/`.
- **Behavior pinning:** the layout-equivalence suite (`tests/unit/engine/layout.equivalence.test.ts`, `layout.reverse.test.ts` vs `referenceTraces.ts`) must stay green untouched. LZ's **byte format is frozen** (literal `[0x00, byte]`; match `[len 3–255, offset_hi, offset_lo]`, 16-bit offset, min match 3, overlapping matches legal) — encoder output bytes MAY differ from the naive encoder (different match choices), but every output must decode to the input via the UNCHANGED decoder.
- **Generated-value drift budget:** the generation fast path may shift `continuous`-type values by ≤1 ulp vs `toPrecision` in rare cases; determinism (same seed → same values) is absolute; any test asserting exact generated values is updated with justification in the report.
- **Styling:** inline styles from `src/theme.ts`; canvas-only exceptions (pixel colors) use the same variable-color hex values the DOM path uses. New interactive elements get `data-testid`s per CLAUDE.md conventions.
- **All existing tests and scenarios stay green after every task:** `npx vitest run` (832 baseline) and, where a task says so, the `tests/ui/scenario-*.mjs` suite (now five files) against `npm run dev`.
- **No branch changes; commit after every task** with the message given in the task.
- **Thresholds are named constants with a comment stating their derivation** — no magic numbers inline.

---

### Task 1: Generation fast path (`roundToSigFigs`)

**Files:**
- Modify: `src/engine/generate.ts` (the `continuous` case, ~line 155: `Number(raw.toPrecision(sigFigs))`)
- Test: `tests/unit/engine/roundToSigFigs.test.ts` (new), `tests/unit/engine/generate.test.ts` (update any exact-value assertions)

**Interfaces:**
- Consumes: nothing new.
- Produces: `export function roundToSigFigs(x: number, sigFigs: number): number` in `src/engine/generate.ts`.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/engine/roundToSigFigs.test.ts
import { describe, it, expect } from 'vitest';
import { roundToSigFigs, createPRNG, generateValues } from '../../../src/engine/generate.ts';

describe('roundToSigFigs', () => {
  it('handles exact cases', () => {
    expect(roundToSigFigs(0, 6)).toBe(0);
    expect(roundToSigFigs(123.456789, 6)).toBe(Number((123.456789).toPrecision(6)));
    expect(roundToSigFigs(-0.000123456, 3)).toBe(Number((-0.000123456).toPrecision(3)));
    expect(roundToSigFigs(1000, 2)).toBe(1000);
    expect(roundToSigFigs(999.999, 3)).toBe(Number((999.999).toPrecision(3))); // magnitude-boundary rounding
  });

  it('matches toPrecision within 1 ulp over a large seeded sample, exactly in >=99% of cases', () => {
    const rng = createPRNG(0xc0dec5);
    let exact = 0;
    const N = 100_000;
    for (let i = 0; i < N; i++) {
      // Cover the generation domains: magnitudes from ~1e-6 to ~1e6, both signs
      const mag = (rng() - 0.5) * 12;
      const x = (rng() - 0.5) * 2 * Math.pow(10, mag);
      const sig = 1 + Math.floor(rng() * 9);
      const fast = roundToSigFigs(x, sig);
      const ref = Number(x.toPrecision(sig));
      if (fast === ref) { exact++; continue; }
      // tolerance: within 1 ulp of the reference
      const ulp = Math.abs(ref) * Number.EPSILON * 2 + Number.MIN_VALUE;
      expect(Math.abs(fast - ref), `x=${x} sig=${sig}`).toBeLessThanOrEqual(ulp);
    }
    expect(exact / N).toBeGreaterThan(0.99);
  });

  it('generateValues stays deterministic (same seed, same values)', () => {
    const cfg = { type: 'continuous', min: -20, max: 40, significantFigures: 6, generation: 'random' } as const;
    const a = generateValues('temperature', cfg as never, 1000);
    const b = generateValues('temperature', cfg as never, 1000);
    expect(Array.from(a as Float64Array)).toEqual(Array.from(b as Float64Array));
  });
});
```

Adjust the `cfg as never` casts to the real `LogicalTypeConfig` shape (read `src/types/state.ts`).

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/unit/engine/roundToSigFigs.test.ts` → FAIL (`roundToSigFigs` not exported).

- [ ] **Step 3: Implement**

In `src/engine/generate.ts`, add and use in the `continuous` case:

```typescript
/**
 * Arithmetic replacement for Number(x.toPrecision(sig)) — the generation hot
 * path (3M string round-trips at the 1M-element target dominated the values
 * stage's ~1s in the Phase 1-3 exit profile). Matches toPrecision exactly in
 * the overwhelming majority of cases; may differ by 1 ulp when the scale
 * factor is not exactly representable. Determinism is unaffected (pure
 * arithmetic, same inputs -> same outputs).
 */
export function roundToSigFigs(x: number, sigFigs: number): number {
  if (x === 0 || !Number.isFinite(x)) return x;
  const mag = Math.floor(Math.log10(Math.abs(x)));
  const factor = Math.pow(10, sigFigs - 1 - mag);
  const rounded = Math.round(x * factor) / factor;
  // log10 can land one off at exact-power boundaries (e.g. 999.9999 -> mag 2
  // but rounds to 1000, which has mag 3). One corrective pass keeps the
  // digit count honest.
  if (Math.abs(rounded) >= Math.pow(10, mag + 1)) {
    const factor2 = Math.pow(10, sigFigs - 2 - mag);
    return Math.round(x * factor2) / factor2;
  }
  return rounded;
}
```

Then in the `continuous` case replace `values[i] = Number(raw.toPrecision(sigFigs));` with `values[i] = roundToSigFigs(raw, sigFigs);`. Note `Math.round` rounds half toward +Infinity while `toPrecision` rounds half away from zero — for negative exact-half values this is a legal ≤1-ulp drift under the budget; do not special-case it unless the sample test fails its 99% bar.

- [ ] **Step 4: Run tests; fix exact-value fallout** — `npx vitest run` → any `generate.test.ts`/other assertions pinning exact continuous values get updated (`Array.from(...)` re-goldened), each listed in the report with old→new values. The layout-equivalence suite must pass UNCHANGED (production and reference tracer share `generateValues`, so they shift together).

- [ ] **Step 5: Measure** — `NODE_OPTIONS=--expose-gc npm run profile` → record the 1M values/typed rows vs the exit baseline (1003ms/841ms) in the report and commit body. Expect a large drop in `values`; `typed` is `assignType`-bound and may move less.

- [ ] **Step 6: Commit**

```bash
git add src/engine/generate.ts tests/unit/engine
git commit -m "perf: arithmetic sig-fig rounding replaces toPrecision in generation (viewers plan Task 1)"
```

### Task 2: LZ hash-chain encoder

**Files:**
- Modify: `src/engine/codecs.ts` (the `lz` definition's `encode` only, ~lines 199–250; `decode` untouched)
- Test: `tests/unit/engine/lz.test.ts` (new; existing `codecs.test.ts` LZ roundtrips stay green)

**Interfaces:**
- Consumes: the frozen LZ byte format (Global Constraints).
- Produces: same `CodecDefinition.encode(bytes, inputDtype, params)` signature; output decodes via the unchanged `decode`.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/engine/lz.test.ts
import { describe, it, expect } from 'vitest';
import { CODEC_REGISTRY } from '../../../src/engine/codecs.ts';
import { createPRNG } from '../../../src/engine/generate.ts';

const lz = CODEC_REGISTRY['lz'];
const roundtrip = (input: Uint8Array, windowSize = 256) => {
  const enc = lz.encode(input, 'uint8', { windowSize });
  const dec = lz.decode(enc.bytes, 'uint8', { windowSize });
  return { enc: enc.bytes, dec: dec.bytes };
};

describe('lz hash-chain encoder', () => {
  const CASES: [string, () => Uint8Array][] = [
    ['empty', () => new Uint8Array(0)],
    ['single byte', () => new Uint8Array([7])],
    ['two bytes (below min match)', () => new Uint8Array([7, 7])],
    ['all zeros (max-length overlapping matches)', () => new Uint8Array(10_000)],
    ['repeating 3-byte period (overlap, offset < len)', () => {
      const b = new Uint8Array(999);
      for (let i = 0; i < b.length; i++) b[i] = i % 3;
      return b;
    }],
    ['random incompressible', () => {
      const rng = createPRNG(42);
      const b = new Uint8Array(20_000);
      for (let i = 0; i < b.length; i++) b[i] = Math.floor(rng() * 256);
      return b;
    }],
    ['prefix-heavy text', () => new TextEncoder().encode('WX-0007-A WX-0007-B WX-0014-A WX-0014-B '.repeat(500))],
    ['match at exact window boundary', () => {
      const b = new Uint8Array(600);
      b.set([1, 2, 3, 4, 5], 0);
      b.set([1, 2, 3, 4, 5], 256); // offset exactly == default windowSize
      return b;
    }],
  ];
  for (const [name, make] of CASES) {
    it(`roundtrips: ${name}`, () => {
      const input = make();
      const { dec } = roundtrip(input);
      expect(Array.from(dec)).toEqual(Array.from(input));
    });
    it(`roundtrips with large window: ${name}`, () => {
      const input = make();
      const { dec } = roundtrip(input, 32768);
      expect(Array.from(dec)).toEqual(Array.from(input));
    });
  }

  it('compresses repetitive input (sanity, not a pinned size)', () => {
    const input = new Uint8Array(10_000); // zeros
    const { enc } = roundtrip(input);
    expect(enc.length).toBeLessThan(input.length / 10);
  });

  it('encodes 1MB of compressible data in bounded time', () => {
    const b = new Uint8Array(1_048_576);
    for (let i = 0; i < b.length; i++) b[i] = (i >> 4) & 0xff; // runs of 16
    const t0 = performance.now();
    lz.encode(b, 'uint8', { windowSize: 4096 });
    const ms = performance.now() - t0;
    // Naive O(n*window) at 4096 window would take tens of seconds here.
    // Generous CI bound — this is a cliff detector, not a benchmark.
    expect(ms).toBeLessThan(3_000);
  });
});
```

- [ ] **Step 2: Run to verify state** — `npx vitest run tests/unit/engine/lz.test.ts`. Roundtrip cases likely PASS against the naive encoder (good — they pin the format); the 1MB timing case must FAIL (or take absurdly long — if the whole file times out, temporarily `it.skip` the timing case to verify the others pass, then unskip). Record which failed.

- [ ] **Step 3: Implement hash-chain matching**

Replace ONLY the `encode` body of the `lz` definition:

```typescript
encode(bytes, _inputDtype, params) {
  const windowSize = Number(params.windowSize ?? 256);
  if (bytes.length === 0) {
    return { bytes: new Uint8Array(0), outputDtype: 'uint8' };
  }

  // Hash-chain LZ77 (how real encoders find matches): a head table maps a
  // 3-byte-prefix hash to the most recent position, chained through prev[].
  // Replaces the O(n*window) backward scan; format unchanged (see decode).
  const HASH_BITS = 16;
  const HASH_SIZE = 1 << HASH_BITS;
  const MAX_CHAIN = 64; // candidates examined per position; quality/speed knob
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(bytes.length).fill(-1);
  const hashAt = (i: number) =>
    ((bytes[i] << 10) ^ (bytes[i + 1] << 5) ^ bytes[i + 2]) & (HASH_SIZE - 1);
  const insert = (i: number) => {
    if (i + 2 >= bytes.length) return;
    const h = hashAt(i);
    prev[i] = head[h];
    head[h] = i;
  };

  // Growable output (number[] push on multi-MB inputs is the old cliff).
  let out = new Uint8Array(Math.max(64, bytes.length >> 2));
  let outLen = 0;
  const push = (...vals: number[]) => {
    if (outLen + vals.length > out.length) {
      const next = new Uint8Array(out.length * 2 + vals.length);
      next.set(out.subarray(0, outLen));
      out = next;
    }
    for (const v of vals) out[outLen++] = v;
  };

  let i = 0;
  while (i < bytes.length) {
    let bestLen = 0;
    let bestOffset = 0;
    if (i + 2 < bytes.length) {
      let candidate = head[hashAt(i)];
      let chain = 0;
      const windowStart = i - windowSize;
      while (candidate >= 0 && candidate >= windowStart && chain < MAX_CHAIN) {
        let matchLen = 0;
        while (
          i + matchLen < bytes.length &&
          bytes[candidate + matchLen] === bytes[i + matchLen] &&
          matchLen < 255
        ) {
          matchLen++;
        }
        if (matchLen >= 3 && matchLen > bestLen) {
          bestLen = matchLen;
          bestOffset = i - candidate;
          if (matchLen === 255) break;
        }
        candidate = prev[candidate];
        chain++;
      }
    }

    if (bestLen >= 3) {
      push(bestLen, (bestOffset >> 8) & 0xff, bestOffset & 0xff);
      for (let k = 0; k < bestLen; k++) insert(i + k);
      i += bestLen;
    } else {
      push(0x00, bytes[i]);
      insert(i);
      i++;
    }
  }

  return { bytes: out.slice(0, outLen), outputDtype: 'uint8' };
},
```

Note: match candidates found via the chain always have `candidate < i`, so `bytes[candidate + matchLen]` may read at/past `i` — that is the overlapping-match case the decoder already supports (byte-by-byte copy); it is correct, not a bug.

- [ ] **Step 4: Run tests** — the new file all-PASS (timing case included) and full `npx vitest run` green. If any pre-existing test pinned exact ENCODED bytes/sizes for LZ, update it to a roundtrip + compression-sanity assertion and justify in the report (output bytes are legitimately different now; the format and decode are what's pinned).

- [ ] **Step 5: Commit**

```bash
git add src/engine/codecs.ts tests/unit/engine/lz.test.ts
git commit -m "perf: LZ encoder uses hash-chain matching, typed-array output (viewers plan Task 2)"
```

### Task 3: Soft element cap replaces the 10K warning

**Files:**
- Modify: `src/components/config/SchemaEditor.tsx:140` (the `totalValues > 10_000` warning)
- Modify: `CLAUDE.md` (Performance bullet: "warn above 10K" is stale)
- Test: `tests/unit/components/elementCap.test.tsx` (new; follow the environment pragma pattern of `tests/unit/components/aboutModal.test.tsx`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `export const SOFT_ELEMENT_CAP = 8_388_608;` from `src/components/config/SchemaEditor.tsx` (total values = shape product × variable count).

- [ ] **Step 1: Read the current warning** at `SchemaEditor.tsx:135-150` — note the exact JSX/copy it renders and where `totalValues` comes from.

- [ ] **Step 2: Write the failing test**

```tsx
// tests/unit/components/elementCap.test.tsx — copy the render/provider setup
// idiom from aboutModal.test.tsx (same environment pragma, same wrappers).
// Assertions:
// 1. With a state under the cap (e.g. default state), the element-cap banner
//    (data-testid "element-cap-warning") is NOT in the document.
// 2. With shape/variables whose product exceeds SOFT_ELEMENT_CAP (e.g. shape
//    [2048, 2048], 3 variables = 12.6M values), the banner IS present, uses
//    warning styling, and the copy mentions the app stays usable (soft cap,
//    no blocking).
```

Write real assertions per that sketch (the setup idiom comes from the existing component test — read it first).

- [ ] **Step 3: Implement.** Replace the 10K warning with:

```tsx
/** Soft cap on total values (shape product x variable count). Derived from
 * the Phase 1-3 exit profile: 3M values (1024x1024 x 3 vars) computes in
 * ~2.2s with ~1GB peak heap; 8M is roughly the comfort ceiling before
 * recompute latency and memory get hostile. Advisory only — nothing blocks. */
export const SOFT_ELEMENT_CAP = 8_388_608;
```

and a banner (`data-testid="element-cap-warning"`, `colors.warning` text on `colors.warningDim` background, matching the codec-warning banner idiom in `CodecSection.tsx:95-100`) shown when `totalValues > SOFT_ELEMENT_CAP`: copy along the lines of `"{formatted count} values — beyond the comfortable limit; recomputes will be slow and memory-heavy. The app won't stop you."` The old `> 10_000` advisory is deleted (the app demonstrably handles 100K+ now). Update CLAUDE.md's Performance bullet ("Keep the total element count reasonable (warn above 10K)") to name `SOFT_ELEMENT_CAP` and the new threshold.

- [ ] **Step 4: Run** — `npx vitest run` green.

- [ ] **Step 5: Commit**

```bash
git add src/components/config/SchemaEditor.tsx CLAUDE.md tests/unit/components/elementCap.test.tsx
git commit -m "feat: soft element cap banner replaces stale 10K warning (viewers plan Task 3)"
```

### Task 4: Grid color helpers + image builder (pure engine of the canvas mode)

**Files:**
- Create: `src/components/viewers/gridImage.ts`
- Modify: `src/components/viewers/GridView.tsx:33-69` (`lerp`/`diffToColor`/`valueToColor` move out and delegate)
- Test: `tests/unit/viewers/gridImage.test.ts`

**Interfaces:**
- Consumes: `ValueArray` from `src/engine/layout.ts`; the existing color-ramp math in `GridView.tsx:33-69` (MOVED, not duplicated — GridView's DOM path imports from `gridImage.ts` afterward).
- Produces (exact signatures later tasks rely on):

```typescript
// src/components/viewers/gridImage.ts
export function lerp(a: number, b: number, t: number): number;
/** rgb() string — the DOM cell path's existing API, now delegating to the RGB tuple fns. */
export function valueToColor(value: number, min: number, max: number, baseColor: string): string;
export function diffToColor(diff: number, maxAbsDiff: number): string;
/** Tuple forms for ImageData fills. Identical ramp math to the string forms. */
export function valueToRGB(value: number, min: number, max: number, baseColor: string): [number, number, number];
export function diffToRGB(diff: number, maxAbsDiff: number): [number, number, number];
/** Fill a width*height RGBA buffer (4 bytes/px, row-major) — one px per
 *  element. colorValues[i] drives the ramp (numeric values, or ordinal ranks
 *  for text — same contract as GridView's colorValues memo). diff mode: when
 *  diffs is provided, px i uses diffToRGB(diffs[i], maxAbsDiff) where
 *  diffActive[i], else the value ramp. Elements past values.length are
 *  transparent (alpha 0). */
export function buildGridImage(opts: {
  colorValues: ArrayLike<number>;
  min: number; max: number; baseColor: string;
  width: number; height: number;
  diffs?: Float64Array; diffActive?: Uint8Array; maxAbsDiff?: number;
}): Uint8ClampedArray;
```

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/viewers/gridImage.test.ts
import { describe, it, expect } from 'vitest';
import { valueToColor, valueToRGB, diffToColor, diffToRGB, buildGridImage } from '../../../src/components/viewers/gridImage.ts';

describe('color ramp parity', () => {
  it('valueToRGB matches valueToColor string output', () => {
    for (const v of [0, 0.25, 5, 9.99, 10]) {
      const [r, g, b] = valueToRGB(v, 0, 10, '#e06c75');
      expect(valueToColor(v, 0, 10, '#e06c75')).toBe(`rgb(${r},${g},${b})`);
    }
  });
  it('diffToRGB matches diffToColor, both signs and zero maxAbsDiff', () => {
    for (const d of [-3, 0, 3]) {
      const [r, g, b] = diffToRGB(d, 3);
      expect(diffToColor(d, 3)).toBe(`rgb(${r},${g},${b})`);
    }
    expect(diffToColor(1, 0)).toBe('rgb(40,40,40)');
  });
});

describe('buildGridImage', () => {
  it('fills one RGBA px per element, row-major, transparent past end', () => {
    const img = buildGridImage({ colorValues: [0, 5, 10], min: 0, max: 10, baseColor: '#ffffff', width: 2, height: 2 });
    expect(img.length).toBe(2 * 2 * 4);
    expect([img[0], img[1], img[2], img[3]]).toEqual([20, 20, 20, 255]); // min -> dark base
    expect([img[8], img[9], img[10], img[11]]).toEqual([255, 255, 255, 255]); // max -> full color
    expect(img[15]).toBe(0); // 4th px: no element -> alpha 0
  });
  it('min === max renders the base color (single-value degenerate)', () => {
    const img = buildGridImage({ colorValues: [7, 7], min: 7, max: 7, baseColor: '#61afef', width: 2, height: 1 });
    expect([img[0], img[1], img[2]]).toEqual([0x61, 0xaf, 0xef]);
  });
});
```

- [ ] **Step 2: Run to verify failure** — module doesn't exist.

- [ ] **Step 3: Implement** — MOVE `lerp`/`diffToColor`/`valueToColor` from `GridView.tsx` into `gridImage.ts` verbatim (including the `min === max → baseColor` and `maxAbsDiff === 0 → rgb(40,40,40)` branches and the ponytail comment), refactor the string forms to call the new tuple forms, add `buildGridImage` (simple double loop; hex parse the baseColor once). `GridView.tsx` imports the string forms from `gridImage.ts` — zero visual change.

- [ ] **Step 4: Run** — new tests + full suite green (GridView still renders identically; existing viewer tests confirm).

- [ ] **Step 5: Commit**

```bash
git add src/components/viewers/gridImage.ts src/components/viewers/GridView.tsx tests/unit/viewers/gridImage.test.ts
git commit -m "refactor: extract grid color ramps + pure RGBA image builder (viewers plan Task 4)"
```

### Task 5: GridView canvas mode

**Files:**
- Create: `src/components/viewers/GridCanvas.tsx`
- Modify: `src/components/viewers/GridView.tsx` (mode switch at `MAX_CELLS`; the DOM path is otherwise untouched)
- Test: scenario probe (Step 4) + existing suite; unit coverage came from Task 4's pure builder

**Interfaces:**
- Consumes: `buildGridImage` (Task 4 signature); `elementInChunk`, `chunkIdForElement`, `parseTraceId`, `makeTraceId`, `flatIndexToCoords` (already imported by GridView); `useHover`; `formatLogicalValue`.
- Produces: `<GridCanvas>` used ONLY by GridView, props:

```typescript
interface GridCanvasProps {
  rows: number; cols: number;
  values: ValueArray;                       // selected variable, for the hover status line
  colorValues: ArrayLike<number>;           // GridView's existing memo output
  min: number; max: number;
  variable: { name: string; color: string };
  chunkShape: number[]; interleaving: 'row' | 'column';
  paneId: 'left' | 'right';
  shape: number[];
  diffs?: { diffs: Float64Array; diffActive: Uint8Array; maxAbsDiff: number };
}
```

- [ ] **Step 1: Implement `GridCanvas`** (canvas behavior is probe-verified, not unit-tested — the pure image math was Task 4):
  - A `<canvas>` with `width={cols} height={rows}` (one px per element), `data-testid="grid-canvas"`, CSS-scaled to fit the container width (`imageRendering: 'pixelated'`, `width: 100%`, height auto, vertical overflow scrolls). Draw with `ctx.putImageData(new ImageData(buildGridImage({...}), cols, rows), 0, 0)` inside a `useEffect` keyed on the image inputs.
  - **Hover out:** `onMouseMove` → element coords from `((e.clientX - rect.left) / rect.width) * cols` (floor; same for rows) → `makeTraceId(variable.name, coords)` + `chunkIdForElement(...)` → `setHover(traceId, chunkId, paneId)`. Guard out-of-range. Hover state remains `{traceId, chunkId}` — data indices, never DOM refs (CLAUDE.md pitfall 2).
  - **Hover in (highlight):** an absolutely-positioned overlay `<div>` outline (like the DOM cells' outline style) sized/positioned from the hovered element's coords × the CSS scale factor — for `hoveredTraceId` (parse via `parseTraceId`, same guards as GridView.tsx:160-181) and, when only `hoveredChunkId` matches, a chunk-bounds rect computed from the chunkId's chunk coords × `chunkShape` (parse the id with the same helpers `elementInChunk` uses — read `src/engine/layout.ts`'s chunk-id parsing before writing this).
  - **Status line** (canvas can't do per-cell `title`): a one-line `<div>` under the canvas showing `name[coords] = formatLogicalValue(value)` for the local hover, or the diff tooltip copy from GridView.tsx:312-314 in diff mode — reuse those exact format strings.
  - **Cross-pane scroll:** when `hoverSource !== paneId` and the trace parses to this variable, adjust the scroll container so the hovered row is visible (row * cssRowHeight vs scrollTop/clientHeight — mirror the `scrollOffsetForCell` semantics with the canvas scale factor).

- [ ] **Step 2: Wire the mode switch in GridView.** Where `cellCount` is computed (GridView.tsx:146), branch: `values.length > MAX_CELLS` → render `<GridCanvas ...>` (passing the existing `colorValues`/`min`/`max` memo outputs and, in diff mode, precomputed `diffs`/`diffActive`/`maxAbsDiff` arrays built in a memo from `values`/`origVarVals`) instead of the truncated DOM grid. Add a comment: the DOM path previously TRUNCATED at `MAX_CELLS`; canvas mode replaces truncation with full rendering. Keep the DOM path byte-identical below the threshold. Keep the variable tabs and diff summary rendering for both modes.

- [ ] **Step 3: Verify with the full suite** — `npx vitest run` green; `npm run build` clean.

- [ ] **Step 4: Probe.** Dev server up; a throwaway Playwright probe (pattern: `tests/ui/scenario-helpers.mjs` launch + `seedStateAndReload`) seeding an ARRAY state, shape `[512, 512]`, 2 numeric variables (262K elements — over `MAX_CELLS`): assert `grid-canvas` present in a pane set to grid view on the values stage, screenshot it, hover mid-canvas and assert the hover-bar/status line shows a value and the OTHER pane's hex view highlights bytes (existing hover-linking assertion pattern). Also run `node tests/ui/scenario-hover-linking.mjs` (small sizes — DOM path must be untouched). Include outputs in the report; kill the server.

- [ ] **Step 5: Commit**

```bash
git add src/components/viewers/GridCanvas.tsx src/components/viewers/GridView.tsx
git commit -m "feat: canvas GridView above MAX_CELLS - full rendering, no truncation (viewers plan Task 5)"
```

### Task 6: File-map overview strip (pure colors + component)

**Files:**
- Create: `src/components/viewers/fileMap.ts`, `src/components/viewers/FileMapStrip.tsx`
- Test: `tests/unit/viewers/fileMap.test.ts`

**Interfaces:**
- Consumes: `StageLayout`, `LayoutRegion` (from `src/engine/layout.ts` — regions carry `kind`, `start`, `byteLength`, and `variableColor` on values/chunk regions).
- Produces:

```typescript
// src/components/viewers/fileMap.ts
/** One RGBA px-column per horizontal pixel: each column colored by the region
 *  owning the byte at that column's *center* ((col + 0.5) / width * byteLength).
 *  values/chunk regions -> the region's variableColor (fallback: alternate
 *  neutral grays when variableColor is ''); structural regions -> fixed
 *  distinct grays (magic bright, metadata mid). Returns width*4 RGBA. */
export function fileMapColors(layout: StageLayout, width: number): Uint8ClampedArray;
/** Byte offset at pixel x (inverse of the column mapping, clamped). */
export function fileMapByteAt(layout: StageLayout, width: number, x: number): number;
```

```tsx
// FileMapStrip.tsx
interface FileMapStripProps {
  layout: StageLayout;
  /** Byte range currently visible in the windowed hex view. */
  windowStart: number; windowEnd: number;
  onJump: (byteOffset: number) => void;
}
// Renders: canvas strip (height 16, width = container, data-testid
// "hex-overview"), a translucent window-indicator overlay div positioned from
// windowStart/windowEnd vs layout.byteLength, click -> onJump(fileMapByteAt(...)).
```

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/viewers/fileMap.test.ts
import { describe, it, expect } from 'vitest';
import { fileMapColors, fileMapByteAt } from '../../../src/components/viewers/fileMap.ts';
import { DEFAULT_STATE } from '../../../src/types/state.ts';
import { computePipelineStages } from '../../../src/engine/pipelineCompute.ts';

describe('fileMapColors', () => {
  const result = computePipelineStages(DEFAULT_STATE);
  const typed = result.stages[1]; // typed stage: one block per variable, distinct colors

  it('produces width*4 RGBA and colors columns by owning region', () => {
    const width = 300;
    const px = fileMapColors(typed.layout, width);
    expect(px.length).toBe(width * 4);
    // First and last columns belong to the first/last variable blocks:
    const first = typed.layout.regions[0];
    const last = typed.layout.regions[typed.layout.regions.length - 1];
    expect(first.kind).toBe('values');
    // Column 0's color equals the first region's variableColor hex:
    const hex = (r: number, g: number, b: number) =>
      '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
    if (first.kind === 'values') expect(hex(px[0], px[1], px[2])).toBe(first.variableColor);
    if (last.kind === 'values') {
      const o = (width - 1) * 4;
      expect(hex(px[o], px[o + 1], px[o + 2])).toBe(last.variableColor);
    }
  });

  it('fileMapByteAt inverts the column mapping within region tolerance', () => {
    const width = 300;
    for (const x of [0, 150, 299]) {
      const byte = fileMapByteAt(typed.layout, width, x);
      expect(byte).toBeGreaterThanOrEqual(0);
      expect(byte).toBeLessThan(typed.layout.byteLength);
      // The byte's own column round-trips to x (center-sampling symmetry):
      expect(Math.floor((byte / typed.layout.byteLength) * width)).toBe(x);
    }
  });

  it('empty layout yields transparent strip and byte 0', () => {
    const empty = { byteLength: 0, shape: [], regions: [] };
    expect(fileMapColors(empty, 10).every((v, i) => (i % 4 === 3 ? v === 0 : true))).toBe(true);
    expect(fileMapByteAt(empty, 10, 5)).toBe(0);
  });
});
```

(Adjust `regions[0].kind` expectations after reading how `buildValueBlocksLayout` orders regions — for DEFAULT_STATE's typed stage they are one `values` region per variable in schema order; the equivalence suite already proves this.)

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** `fileMap.ts` (center-sample column loop over regions using the same binary-search-by-start pattern as `regionAt` in `layout.ts` — import `regionAt` rather than reimplementing) and `FileMapStrip.tsx` (canvas draw in a `useEffect` from `fileMapColors(layout, canvasWidth)`; container-width via the existing `useContainerWidth` hook; window overlay div; `onClick` maps `e.clientX` to `onJump(fileMapByteAt(...))`).

- [ ] **Step 4: Run** — new tests + full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/components/viewers/fileMap.ts src/components/viewers/FileMapStrip.tsx tests/unit/viewers/fileMap.test.ts
git commit -m "feat: file-map overview strip - pure column colors + canvas component (viewers plan Task 6)"
```

### Task 7: HexView windowed mode

**Files:**
- Modify: `src/components/viewers/HexView.tsx`, `src/components/viewers/useHexData.ts`
- Test: `tests/unit/viewers/hexWindow.test.ts` (pure window math) + probe

**Interfaces:**
- Consumes: `FileMapStrip` (Task 6 props), `firstByteForTrace` (useHexData.ts:81), the per-section virtualizer structure in HexView.tsx (READ it first — `HexSectionView` with `scrollMargin`, `ROW_HEIGHT = 20`).
- Produces (in `useHexData.ts`):

```typescript
/** Sections whose rowCount exceeds this render a bounded row window with a
 *  FileMapStrip instead of unbounded virtual scroll. 262,144 rows = 4MB at
 *  16 B/row = ~5.2M px of scroll height — comfortably under Firefox's
 *  ~17.9M px element-height cap with headroom for multi-section views. */
export const WINDOWED_SECTION_ROWS = 262_144;
/** Rows per window (65,536 rows = 1MB at 16 B/row = ~1.3M px). */
export const WINDOW_ROWS = 65_536;
/** Clamp a desired window start row: aligned to whole rows, >= 0, and never
 *  leaving trailing dead space (start <= rowCount - WINDOW_ROWS). */
export function clampWindowStart(desiredStartRow: number, rowCount: number): number;
/** Window start row that centers `byteOffset`'s row. */
export function windowStartForByte(byteOffset: number, bytesPerRow: number, rowCount: number): number;
```

- [ ] **Step 1: Write the failing window-math tests**

```typescript
// tests/unit/viewers/hexWindow.test.ts
import { describe, it, expect } from 'vitest';
import { clampWindowStart, windowStartForByte, WINDOW_ROWS } from '../../../src/components/viewers/useHexData.ts';

describe('hex window math', () => {
  it('clamps to [0, rowCount - WINDOW_ROWS]', () => {
    expect(clampWindowStart(-5, 1_000_000)).toBe(0);
    expect(clampWindowStart(999_999_999, 1_000_000)).toBe(1_000_000 - WINDOW_ROWS);
    expect(clampWindowStart(1234, 1_000_000)).toBe(1234);
  });
  it('rowCount below one window pins start to 0', () => {
    expect(clampWindowStart(50, 100)).toBe(0);
  });
  it('windowStartForByte centers the target row', () => {
    const start = windowStartForByte(8_000_000, 16, 1_000_000); // row 500,000
    expect(start).toBe(500_000 - WINDOW_ROWS / 2);
    // target row is inside [start, start + WINDOW_ROWS)
    expect(500_000).toBeGreaterThanOrEqual(start);
    expect(500_000).toBeLessThan(start + WINDOW_ROWS);
  });
});
```

- [ ] **Step 2: Run to verify failure**, then implement the two functions + constants in `useHexData.ts` (trivial arithmetic per the doc comments).

- [ ] **Step 3: Wire windowed mode into `HexSectionView`** (HexView.tsx):
  - HexView holds per-section state `windowStarts: Record<string, number>` (keyed by section key, default 0). A section is *windowed* when `sectionData.rowCount > WINDOWED_SECTION_ROWS`.
  - For a windowed section: virtualizer `count = Math.min(WINDOW_ROWS, rowCount - windowStart)`; each virtual row's true row index is `windowStart + virtualRow.index`, so `byteStart = (windowStart + virtualRow.index) * bytesPerRow` — offsets/lookups need NO other change (HexRowRenderer already derives everything from `byteStart`). `rowOffset`/`scrollMargin` math in `useHexData` uses the WINDOWED row count (`Math.min(rowCount, WINDOW_ROWS)`) for downstream sections' offsets.
  - Above the section's rows render `<FileMapStrip layout={sectionData.layout} windowStart={windowStart * bytesPerRow} windowEnd={(windowStart + count) * bytesPerRow} onJump={(byte) => setWindowStart(key, clampWindowStart(windowStartForByte(byte, bytesPerRow, rowCount), rowCount))} />` plus a small offset-jump input (`data-testid="hex-offset-input"`): hex string (`0x…` or bare hex) → same jump on Enter, invalid input ignored (no crash — edge-case philosophy).
  - `scrollToRow(rowIndex)` (the cross-pane hover handle, HexView.tsx:80-84): when the section is windowed and `rowIndex` is outside `[windowStart, windowStart + count)`, first `setWindowStart(clampWindowStart(windowStartForByte(rowIndex * bytesPerRow, bytesPerRow, rowCount), rowCount))`, then scroll to `rowIndex - newWindowStart` (an effect keyed on windowStart landing, or compute-and-scroll in the same handler after state settles — implementer's choice, but cross-pane hover from TableView into a far offset MUST land visibly; the probe checks it).
  - Non-windowed sections: byte-identical behavior to today (guard everything behind the threshold).

- [ ] **Step 4: Verify** — `npx vitest run` green; `npm run build` clean; full scenario suite (all five) green against dev server — small sizes never cross the threshold so nothing should change; if a scenario fails, the threshold guard leaked. Probe (throwaway script): seed tabular shape `[600000]` × 3 float64 vars (values stage = 14.4MB = 900K rows > threshold): assert `hex-overview` present, click at 80% width → offset column shows a far offset; type an offset in `hex-offset-input` → window jumps; hover a table cell in the other pane → hex highlights (cross-pane across windows). Screenshot. Include outputs in the report; kill the server.

- [ ] **Step 5: Commit**

```bash
git add src/components/viewers/HexView.tsx src/components/viewers/useHexData.ts tests/unit/viewers/hexWindow.test.ts
git commit -m "feat: windowed hex mode with file-map overview above row cap (viewers plan Task 7)"
```

### Task 8: Large-array scenario, docs, exit profile

**Files:**
- Create: `tests/ui/scenario-large-array.mjs`
- Modify: `CLAUDE.md` (scenario list + new testids `grid-canvas`, `hex-overview`, `hex-offset-input`, `element-cap-warning`), `docs/design.md` ONLY if it still states the 10K guidance (grep first)
- Test: the scenario itself

**Interfaces:**
- Consumes: `scenario-helpers.mjs` (`seedStateAndReload`, `waitForPipelineIdle`, check harness); all Task 3/5/7 testids.

- [ ] **Step 1: Write the scenario** following `tests/ui/scenario-worker-pipeline.mjs`'s structure: seed ARRAY model, shape `[1024, 1024]`, 2 numeric variables (2M values — over `MAX_CELLS`, over `WINDOWED_SECTION_ROWS` at the values stage(16MB = 1M rows), under `SOFT_ELEMENT_CAP`), `waitForPipelineIdle(page, 90_000)`. Checks: no pageerror; `grid-canvas` renders in a grid-view pane; `hex-overview` present in a hex pane; clicking the overview strip changes the first visible offset (read a `hex-byte-*` testid's offset before/after); `hex-offset-input` jump works; hovering the grid canvas highlights hex bytes in the other pane; a second seeded run with shape `[3000, 3000]` (18M values) shows `element-cap-warning` in the sidebar and still renders without pageerror (soft cap = advisory).

- [ ] **Step 2: Run it** — dev server up, `node tests/ui/scenario-large-array.mjs` all PASS; then the full scenario suite (six files now) green. Kill server.

- [ ] **Step 3: Docs** — CLAUDE.md scenario list + testid additions; grep `10K\|10,000\|10_000` in `docs/` and CLAUDE.md for stale guidance and update to the cap constant.

- [ ] **Step 4: Exit profile** — `NODE_OPTIONS=--expose-gc npm run profile` AND a second measurement with a real codec: temporarily seed the profile state with an LZ step (edit the `makeState` call locally per `scripts/profile.ts`'s state construction — if the script lacks a codec knob, add `--lz` support to it in this task: set `fieldPipelines[v.id] = [{ codec: 'lz', params: { windowSize: 4096 } }]` for each variable) and record the encoded-stage cost at 1M. Both tables go in the commit body and the report as the Phase 4–5 exit numbers.

- [ ] **Step 5: Commit**

```bash
git add tests/ui/scenario-large-array.mjs scripts/profile.ts CLAUDE.md docs
git commit -m "test: large-array scenario; docs + exit profile (viewers plan Task 8)"
```

---

## Deliberately not in this plan

- **RLE encode/decode still build `number[]` outputs** — linear, and unmeasured as a problem; revisit only if Task 8's LZ-enabled profile shows RLE hurting.
- **Overview strip for non-hex views, grid zoom/pan, axes/geo colormap labels** — the geo project's scope, building on `GridCanvas`.
- **Raising or removing `MAX_CELLS`** for the DOM grid path — the threshold IS the canvas cutover.
