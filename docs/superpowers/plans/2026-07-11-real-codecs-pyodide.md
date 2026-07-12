# Real Codecs via Pyodide/numcodecs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three real compression codecs (Zstd, GZip, Blosc — the actual `numcodecs` library Zarr uses) to the codec pipeline, running in Python via Pyodide/WebAssembly, loaded eagerly at startup with a narrated progress banner.

**Architecture:** Pyodide loads asynchronously ONCE inside the pipeline worker at startup; after load, `runPython` executes synchronously, so the engine's `encode()`/`decode()` stay synchronous pure functions and nothing else goes async. The three codecs are ordinary `category: 'entropy'` registry entries (uint8 dtype flow, chunk-level trace degradation, `codec_pipelines` metadata, and read-side reversal are all inherited). Computes are gated on runtime readiness only when the state actually uses a real codec. The existing service worker gains a separate, Pyodide-version-keyed cache so the runtime survives deploys and works offline.

**Tech Stack:** Pyodide 314.0.2 (pinned; CDN `https://cdn.jsdelivr.net/pyodide/v314.0.2/full/`, verified to ship numcodecs 0.15.1 + numpy 2.4.3), `pyodide` npm package 314.0.2 as **devDependency only** (types + Node runtime for tests). No runtime npm dependencies added.

**Spec:** `docs/superpowers/specs/2026-07-11-real-codecs-pyodide-design.md` — read it first.

## Global Constraints

- **Engine stays synchronous.** No `async` may be added to any function in `src/engine/` except `initPyodideRuntime`. `readFile`, `computePipelineStages`, `createPipelineComputer`, and all codec `encode`/`decode` remain sync.
- **`pyodide` is a devDependency only** (`npm i -D pyodide@314.0.2`). The app bundle must not statically import the `pyodide` package — browser loading goes through a dynamic CDN import; only `import type` from `'pyodide'` is allowed in `src/`.
- **Pinned version appears in exactly two places** — `PYODIDE_VERSION` in `src/engine/pyodideRuntime.ts` and the copy in `public/sw.js` — with a unit test asserting they match.
- **Returned codec bytes must be copies, never views into the Pyodide WASM heap.** The PERF-1 delta protocol transfers result buffers; transferring a view into the WASM heap would transfer (detach) Pyodide's entire memory. Always `new Uint8Array(...)`-copy at the bridge boundary.
- Unit tests live in `tests/unit/` (never `src/`). Real-runtime tests are wrapped in `describe.skipIf(!!process.env.SKIP_PYODIDE)` and need network on first run (wheels cached under `node_modules/.cache/pyodide` afterwards).
- Follow existing conventions: inline styles from `src/theme.ts`, `data-testid` per CLAUDE.md, `tests/ui/scenario-helpers.mjs` for scenarios, commit per task (prek pre-commit runs eslint + tsc -b).
- Test commands: `npx vitest run <file>` (unit), `npx tsc --noEmit -p .` + build via prek on commit.

---

### Task 1: Pyodide runtime module (`pyodideRuntime.ts`) + real-runtime Node tests

**Files:**
- Create: `src/engine/pyodideRuntime.ts`
- Create: `tests/unit/engine/pyodideRuntime.test.ts`
- Modify: `package.json` (devDependency `pyodide@314.0.2`)

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces (later tasks rely on these exact names):
  - `PYODIDE_VERSION: string` (= `'314.0.2'`), `PYODIDE_CDN_BASE: string`
  - `type RuntimeStepId = 'download-runtime' | 'install-numpy' | 'install-numcodecs'`
  - `RUNTIME_STEP_ORDER: RuntimeStepId[]`, `RUNTIME_STEP_LABELS: Record<RuntimeStepId, string>`
  - `interface RuntimeProgressEvent { step: RuntimeStepId; state: 'start' | 'done'; label: string }`
  - `type PyodideLoader = () => Promise<PyodideInterface>`
  - `initPyodideRuntime(onProgress?: (e: RuntimeProgressEvent) => void, loadImpl?: PyodideLoader): Promise<void>` — idempotent (returns the same promise on repeat calls, including after failure)
  - `pyodideReady(): boolean`
  - `runPyodideCodec(op: 'encode' | 'decode', config: Record<string, unknown>, bytes: Uint8Array): Uint8Array` — synchronous; throws `Error('Python runtime is not loaded — real codecs are unavailable')` when not ready

- [ ] **Step 1: Install the devDependency**

```bash
npm install --save-dev pyodide@314.0.2
```

- [ ] **Step 2: Write the failing tests**

Create `tests/unit/engine/pyodideRuntime.test.ts`:

```ts
// Real-runtime tests for the Pyodide bridge. Loads actual Pyodide in Node
// (pyodide devDependency); numpy/numcodecs wheels are fetched from the CDN
// on the first run and cached under node_modules/.cache/pyodide, so repeat
// runs work offline. Set SKIP_PYODIDE=1 to skip the whole suite when
// offline with a cold cache.
import { describe, it, expect, beforeAll } from 'vitest';
import { loadPyodide } from 'pyodide';
import {
  PYODIDE_VERSION,
  RUNTIME_STEP_ORDER,
  initPyodideRuntime,
  pyodideReady,
  runPyodideCodec,
  type RuntimeProgressEvent,
} from '../../../src/engine/pyodideRuntime.ts';

const nodeLoader = () =>
  loadPyodide({ packageCacheDir: 'node_modules/.cache/pyodide' });

describe('pyodideRuntime (no runtime needed)', () => {
  it('pins the expected version', () => {
    expect(PYODIDE_VERSION).toBe('314.0.2');
  });

  it('runPyodideCodec throws a clear error before init', () => {
    // NOTE: this file's real-runtime describe below initializes the module;
    // vitest runs describes in order, so this must come first.
    if (pyodideReady()) return; // already initialized by a prior run in watch mode
    expect(() => runPyodideCodec('encode', { id: 'zstd', level: 3 }, new Uint8Array([1])))
      .toThrow(/Python runtime is not loaded/);
  });
});

describe.skipIf(!!process.env.SKIP_PYODIDE)('pyodideRuntime (real runtime)', () => {
  const events: RuntimeProgressEvent[] = [];

  beforeAll(async () => {
    await initPyodideRuntime((e) => events.push(e), nodeLoader);
  }, 300_000);

  it('reports every step in order, start then done', () => {
    const expected = RUNTIME_STEP_ORDER.flatMap((step) => [
      { step, state: 'start' },
      { step, state: 'done' },
    ]);
    expect(events.map((e) => ({ step: e.step, state: e.state }))).toEqual(expected);
    for (const e of events) expect(e.label.length).toBeGreaterThan(0);
  });

  it('pyodideReady flips true and init is idempotent', async () => {
    expect(pyodideReady()).toBe(true);
    const before = events.length;
    await initPyodideRuntime(); // second call: same promise, no new events
    expect(events.length).toBe(before);
  });

  it('round-trips bytes exactly through zstd, gzip, and blosc', () => {
    const input = new Uint8Array(4096);
    for (let i = 0; i < input.length; i++) input[i] = (i * 7 + (i >> 5)) & 0xff;
    const configs: Record<string, unknown>[] = [
      { id: 'zstd', level: 3 },
      { id: 'gzip', level: 6 },
      { id: 'blosc', cname: 'lz4', clevel: 5, shuffle: 1 },
    ];
    for (const config of configs) {
      const encoded = runPyodideCodec('encode', config, input);
      expect(encoded.length).toBeGreaterThan(0);
      const decoded = runPyodideCodec('decode', config, encoded);
      expect(Array.from(decoded)).toEqual(Array.from(input));
    }
  });

  it('compresses compressible input (honest numbers sanity check)', () => {
    const zeros = new Uint8Array(65536); // all zeros: any real codec crushes this
    const encoded = runPyodideCodec('encode', { id: 'zstd', level: 3 }, zeros);
    expect(encoded.length).toBeLessThan(zeros.length / 10);
  });

  it('returns copies, not views into the WASM heap', () => {
    const input = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const encoded = runPyodideCodec('encode', { id: 'gzip', level: 6 }, input);
    // A view into pyodide's memory would have a huge shared buffer; a copy's
    // buffer is exactly its own bytes. This is load-bearing for PERF-1's
    // transfer list (transferring the WASM heap would destroy the runtime).
    expect(encoded.buffer.byteLength).toBe(encoded.byteLength);
  });

  it('handles empty input', () => {
    const config = { id: 'zstd', level: 3 };
    const encoded = runPyodideCodec('encode', config, new Uint8Array(0));
    const decoded = runPyodideCodec('decode', config, encoded);
    expect(decoded.length).toBe(0);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/unit/engine/pyodideRuntime.test.ts`
Expected: FAIL — cannot resolve `../../../src/engine/pyodideRuntime.ts`.

- [ ] **Step 4: Implement the module**

Create `src/engine/pyodideRuntime.ts`:

```ts
// Pyodide runtime bridge (project 4, real codecs). Owns the one Pyodide
// instance for this JS realm. In the app this module lives in the pipeline
// WORKER (the worker calls initPyodideRuntime at startup); in vitest it runs
// in Node with an injected loader. The KEY property: loading is async, but
// once loaded every call is synchronous — so the engine (and readFile, and
// every existing test) stays sync. See the design spec:
// docs/superpowers/specs/2026-07-11-real-codecs-pyodide-design.md
//
// IMPORTANT: only `import type` from 'pyodide' here — the package is a
// devDependency; the browser path dynamic-imports pyodide.mjs from the CDN.
import type { PyodideInterface } from 'pyodide';

export const PYODIDE_VERSION = '314.0.2'; // ALSO pinned in public/sw.js (unit test enforces the match)
export const PYODIDE_CDN_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

export type RuntimeStepId = 'download-runtime' | 'install-numpy' | 'install-numcodecs';

export const RUNTIME_STEP_ORDER: RuntimeStepId[] = [
  'download-runtime',
  'install-numpy',
  'install-numcodecs',
];

export const RUNTIME_STEP_LABELS: Record<RuntimeStepId, string> = {
  'download-runtime': `Downloading Python runtime (Pyodide ${PYODIDE_VERSION}, ~12 MB)`,
  'install-numpy': 'Installing numpy',
  'install-numcodecs': 'Installing numcodecs — the compression library Zarr uses',
};

export interface RuntimeProgressEvent {
  step: RuntimeStepId;
  state: 'start' | 'done';
  label: string;
}

export type PyodideLoader = () => Promise<PyodideInterface>;

// Minimal structural type for the PyProxy the bridge function returns —
// avoids depending on pyodide's full PyProxy type in app code.
interface BytesProxy {
  toJs: () => Uint8Array;
  destroy: () => void;
}

// Defined once at init; numcodecs.get_codec takes the SAME config-dict shape
// Zarr metadata uses ({"id": "zstd", "level": 3}), so the JS side passes the
// codec config verbatim as JSON.
const PY_BRIDGE = `
import json
import numcodecs

def _xc_run_codec(op, config_json, data):
    codec = numcodecs.get_codec(json.loads(config_json))
    raw = bytes(data.to_py())
    out = codec.encode(raw) if op == "encode" else codec.decode(raw)
    return bytes(out)
`;

let runCodecFn: ((op: string, configJson: string, data: Uint8Array) => unknown) | null = null;
let initPromise: Promise<void> | null = null;

async function defaultLoader(): Promise<PyodideInterface> {
  // Dynamic CDN import: Vite must leave this alone (@vite-ignore) in both
  // dev and build; jsdelivr serves CORS so module workers can import it.
  const mod = await import(/* @vite-ignore */ `${PYODIDE_CDN_BASE}pyodide.mjs`);
  return (mod as { loadPyodide: (opts: { indexURL: string }) => Promise<PyodideInterface> })
    .loadPyodide({ indexURL: PYODIDE_CDN_BASE });
}

/**
 * Load Pyodide + numpy + numcodecs, reporting each step as it starts and
 * completes. Idempotent: repeat calls (including after a failure) return the
 * same promise — a failed load stays failed until the worker respawns, which
 * is this app's retry mechanism.
 */
export function initPyodideRuntime(
  onProgress?: (e: RuntimeProgressEvent) => void,
  loadImpl: PyodideLoader = defaultLoader,
): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const report = (step: RuntimeStepId, state: 'start' | 'done') =>
      onProgress?.({ step, state, label: RUNTIME_STEP_LABELS[step] });

    report('download-runtime', 'start');
    const py = await loadImpl();
    report('download-runtime', 'done');

    report('install-numpy', 'start');
    await py.loadPackage('numpy');
    report('install-numpy', 'done');

    report('install-numcodecs', 'start');
    await py.loadPackage('numcodecs');
    report('install-numcodecs', 'done');

    py.runPython(PY_BRIDGE);
    runCodecFn = py.globals.get('_xc_run_codec');
  })();
  return initPromise;
}

export function pyodideReady(): boolean {
  return runCodecFn !== null;
}

/**
 * Synchronous bytes-in/bytes-out numcodecs call. `config` is the numcodecs
 * codec config dict (e.g. { id: 'zstd', level: 3 }).
 *
 * The returned Uint8Array is ALWAYS a fresh copy: a view into the Pyodide
 * WASM heap would be catastrophic downstream — PERF-1's delta protocol
 * transfers result buffers, and transferring the heap buffer would detach
 * the entire Python runtime.
 */
export function runPyodideCodec(
  op: 'encode' | 'decode',
  config: Record<string, unknown>,
  bytes: Uint8Array,
): Uint8Array {
  if (runCodecFn === null) {
    throw new Error('Python runtime is not loaded — real codecs are unavailable');
  }
  const result = runCodecFn(op, JSON.stringify(config), bytes);
  if (result instanceof Uint8Array) {
    return new Uint8Array(result); // copy (see doc comment)
  }
  const proxy = result as BytesProxy;
  const out = new Uint8Array(proxy.toJs()); // copy (see doc comment)
  proxy.destroy();
  return out;
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/unit/engine/pyodideRuntime.test.ts`
Expected: PASS (first run downloads ~30MB of wheels; takes 1–3 minutes; repeat runs are fast). If the bridge's byte conversion fails (e.g. `data.to_py()` needs adjusting for this Pyodide version), fix the PY_BRIDGE/`runPyodideCodec` conversion until the round-trip tests pass — that is this task's spike duty.

- [ ] **Step 6: Verify the full existing suite still passes**

Run: `npx vitest run`
Expected: all files PASS (the new suite adds to 935).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/engine/pyodideRuntime.ts tests/unit/engine/pyodideRuntime.test.ts
git commit -m "feat: Pyodide runtime bridge — async init, sync numcodecs calls (project 4 task 1)"
```

---

### Task 2: Registry entries (zstd/gzip/blosc) + `stateUsesPyodideCodec`

**Files:**
- Modify: `src/types/codecs.ts` (optional `runtime` field)
- Modify: `src/engine/codecs.ts` (three entries + helper)
- Create: `tests/unit/engine/realCodecs.test.ts`

**Interfaces:**
- Consumes: `runPyodideCodec`, `initPyodideRuntime`, `pyodideReady` from Task 1.
- Produces:
  - `CodecDefinition.runtime?: 'pyodide'` (absent on educational codecs)
  - Registry keys `'zstd'`, `'gzip'`, `'blosc'` in `CODEC_REGISTRY`, all `category: 'entropy'`
  - `stateUsesPyodideCodec(state: Pick<AppState, 'fieldPipelines' | 'chunkPipeline'>): boolean` exported from `src/engine/codecs.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/engine/realCodecs.test.ts`:

```ts
// Real codecs as registry citizens: dtype flow, pipeline round-trip through
// the actual engine paths (runCodecPipeline / reverseCodecPipeline), and the
// worker's gating predicate. The real-runtime describe needs network on
// first run (see pyodideRuntime.test.ts header comment); SKIP_PYODIDE=1 skips it.
import { describe, it, expect, beforeAll } from 'vitest';
import { loadPyodide } from 'pyodide';
import {
  CODEC_REGISTRY,
  outputDtypeFor,
  runCodecPipeline,
  stateUsesPyodideCodec,
} from '../../../src/engine/codecs.ts';
import { reverseCodecPipeline } from '../../../src/engine/decode.ts';
import { initPyodideRuntime } from '../../../src/engine/pyodideRuntime.ts';
import { valuesToBytes } from '../../../src/engine/elements.ts';
import { DEFAULT_STATE } from '../../../src/types/state.ts';
import type { CodecStep } from '../../../src/types/codecs.ts';
import type { DtypeKey } from '../../../src/types/dtypes.ts';

const REAL_KEYS = ['zstd', 'gzip', 'blosc'] as const;

describe('real codec registry entries (no runtime needed)', () => {
  it('registers all three as entropy codecs with runtime pyodide', () => {
    for (const key of REAL_KEYS) {
      const codec = CODEC_REGISTRY[key];
      expect(codec, key).toBeDefined();
      expect(codec.category).toBe('entropy');
      expect(codec.runtime).toBe('pyodide');
      expect(codec.applicableTo('float64')).toBe(true);
      expect(codec.isLossy('float64')).toBe(false);
      // entropy => uint8 output, same as RLE/LZ (single source of truth)
      expect(outputDtypeFor(codec, 'int16')).toBe('uint8');
    }
  });

  it('educational codecs have no runtime field', () => {
    for (const key of ['delta', 'byte-shuffle', 'rle', 'lz']) {
      expect(CODEC_REGISTRY[key]?.runtime).toBeUndefined();
    }
  });

  it('stateUsesPyodideCodec truth table', () => {
    const zstdStep: CodecStep = { codec: 'zstd', params: { level: 3 } };
    const deltaStep: CodecStep = { codec: 'delta', params: { order: 1 } };
    expect(stateUsesPyodideCodec({ fieldPipelines: {}, chunkPipeline: [] })).toBe(false);
    expect(stateUsesPyodideCodec({ fieldPipelines: {}, chunkPipeline: [deltaStep] })).toBe(false);
    expect(stateUsesPyodideCodec({ fieldPipelines: {}, chunkPipeline: [zstdStep] })).toBe(true);
    expect(stateUsesPyodideCodec({ fieldPipelines: { a: [deltaStep], b: [zstdStep] }, chunkPipeline: [] })).toBe(true);
    // Unknown codec keys are ignored, not crashed on
    expect(stateUsesPyodideCodec({ fieldPipelines: { a: [{ codec: 'nope', params: {} }] }, chunkPipeline: [] })).toBe(false);
    expect(stateUsesPyodideCodec(DEFAULT_STATE)).toBe(false);
  });
});

describe.skipIf(!!process.env.SKIP_PYODIDE)('real codecs through the engine pipeline', () => {
  beforeAll(async () => {
    await initPyodideRuntime(undefined, () =>
      loadPyodide({ packageCacheDir: 'node_modules/.cache/pyodide' }));
  }, 300_000);

  const dtypes: DtypeKey[] = ['uint8', 'int16', 'float32', 'float64'];

  function sampleBytes(dtype: DtypeKey): Uint8Array {
    const values = Array.from({ length: 512 }, (_, i) => (i % 97) - 48);
    return valuesToBytes(values, dtype);
  }

  it.each(REAL_KEYS.map((k) => [k]))('%s round-trips exactly via runCodecPipeline/reverseCodecPipeline', (key) => {
    const params = key === 'blosc'
      ? { cname: 'lz4', clevel: 5, shuffle: 'byte' }
      : key === 'zstd' ? { level: 3 } : { level: 6 };
    for (const dtype of dtypes) {
      const input = sampleBytes(dtype);
      const steps: CodecStep[] = [{ codec: key, params }];
      const encoded = runCodecPipeline(input, steps, dtype);
      expect(encoded.outputDtype).toBe('uint8');
      const decoded = reverseCodecPipeline(encoded.bytes, steps, dtype);
      expect(decoded.outputDtype).toBe(dtype);
      expect(Array.from(decoded.bytes)).toEqual(Array.from(input));
    }
  });

  it('composes with educational codecs (delta -> zstd) and reverses', () => {
    const input = sampleBytes('int16');
    const steps: CodecStep[] = [
      { codec: 'delta', params: { order: 1 } },
      { codec: 'zstd', params: { level: 3 } },
    ];
    const encoded = runCodecPipeline(input, steps, 'int16');
    const decoded = reverseCodecPipeline(encoded.bytes, steps, 'int16');
    expect(Array.from(decoded.bytes)).toEqual(Array.from(input));
  });

  it('blosc shuffle param maps none/byte/bit and all round-trip', () => {
    const input = sampleBytes('float32');
    for (const shuffle of ['none', 'byte', 'bit']) {
      const steps: CodecStep[] = [{ codec: 'blosc', params: { cname: 'zstd', clevel: 5, shuffle } }];
      const encoded = runCodecPipeline(input, steps, 'float32');
      const decoded = reverseCodecPipeline(encoded.bytes, steps, 'float32');
      expect(Array.from(decoded.bytes), `shuffle=${shuffle}`).toEqual(Array.from(input));
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/engine/realCodecs.test.ts`
Expected: FAIL — `CODEC_REGISTRY['zstd']` undefined; `stateUsesPyodideCodec` not exported.

- [ ] **Step 3: Add the `runtime` field to `CodecDefinition`**

In `src/types/codecs.ts`, after the `category` field:

```ts
  /** Present on codecs backed by an external runtime. 'pyodide' entries are
   *  the real numcodecs codecs: the picker disables them until the runtime
   *  loads, and the worker awaits runtime init before computes that use one
   *  (see stateUsesPyodideCodec). Absent = educational codec, always available. */
  runtime?: 'pyodide';
```

- [ ] **Step 4: Implement the three entries + helper in `src/engine/codecs.ts`**

Add the import at the top:

```ts
import { runPyodideCodec } from './pyodideRuntime.ts';
```

Add before `CODEC_REGISTRY`:

```ts
// ─── Real codecs (project 4): actual numcodecs via Pyodide ─────────────────
//
// Ordinary entropy entries — uint8 output dtype, chunk-level trace
// degradation, codec_pipelines metadata, and read-side reversal all come
// from the same machinery RLE/LZ use. The only differences: `runtime:
// 'pyodide'` (picker/gating) and encode/decode delegating to numcodecs.
// numcodecs.get_codec consumes the same config-dict shape Zarr metadata
// stores, so params translate 1:1.

const BLOSC_SHUFFLE: Record<string, number> = { none: 0, byte: 1, bit: 2 };

function pyodideCodec(opts: {
  key: string;
  label: string;
  description: string;
  params: Record<string, ParamDef>;
  config: (params: Record<string, number | string>) => Record<string, unknown>;
}): CodecDefinition {
  return {
    key: opts.key,
    label: opts.label,
    category: 'entropy',
    runtime: 'pyodide',
    description: opts.description,
    params: opts.params,
    applicableTo: () => true,
    isLossy: () => false,
    encode: (bytes, _inputDtype, params) => ({
      bytes: runPyodideCodec('encode', opts.config(params), bytes),
      outputDtype: 'uint8',
    }),
    decode: (bytes, _encodedDtype, params) => ({
      bytes: runPyodideCodec('decode', opts.config(params), bytes),
      outputDtype: 'uint8',
    }),
  };
}

const zstdCodec = pyodideCodec({
  key: 'zstd',
  label: 'Zstd (real)',
  description: 'Real Zstandard compression via numcodecs — the default compressor in modern Zarr.',
  params: {
    level: { label: 'Level', type: 'number', default: 3, min: 1, max: 22, step: 1 },
  },
  config: (p) => ({ id: 'zstd', level: Number(p.level ?? 3) }),
});

const gzipCodec = pyodideCodec({
  key: 'gzip',
  label: 'GZip (real)',
  description: 'Real DEFLATE/gzip via numcodecs — the same algorithm behind .gz files and PNG.',
  params: {
    level: { label: 'Level', type: 'number', default: 6, min: 0, max: 9, step: 1 },
  },
  config: (p) => ({ id: 'gzip', level: Number(p.level ?? 6) }),
});

const bloscCodec = pyodideCodec({
  key: 'blosc',
  label: 'Blosc (real)',
  description: 'Real Blosc meta-compressor via numcodecs — note it has byte/bit shuffle BUILT IN, the same trick as the educational Byte Shuffle step.',
  params: {
    cname: { label: 'Compressor', type: 'select', default: 'lz4', options: ['lz4', 'zstd', 'zlib'] },
    clevel: { label: 'Level', type: 'number', default: 5, min: 1, max: 9, step: 1 },
    shuffle: { label: 'Shuffle', type: 'select', default: 'byte', options: ['none', 'byte', 'bit'] },
  },
  config: (p) => ({
    id: 'blosc',
    cname: String(p.cname ?? 'lz4'),
    clevel: Number(p.clevel ?? 5),
    shuffle: BLOSC_SHUFFLE[String(p.shuffle ?? 'byte')] ?? 1,
  }),
});
```

Add the three to `CODEC_REGISTRY` (after the existing entries):

```ts
  zstd: zstdCodec,
  gzip: gzipCodec,
  blosc: bloscCodec,
```

Add the gating helper (near `outputDtypeFor`):

```ts
/** True when any configured pipeline step references a runtime-backed codec.
 *  Used by the worker to decide whether a compute must await Pyodide init.
 *  Deliberately checks ALL fieldPipelines (including ones inactive in row
 *  mode): the worst case of the conservative answer is an unnecessary await,
 *  never a wrong result. */
export function stateUsesPyodideCodec(
  state: Pick<AppState, 'fieldPipelines' | 'chunkPipeline'>,
): boolean {
  const usesRuntime = (steps: CodecStep[]) =>
    steps.some((s) => CODEC_REGISTRY[s.codec]?.runtime === 'pyodide');
  if (usesRuntime(state.chunkPipeline)) return true;
  return Object.values(state.fieldPipelines).some(usesRuntime);
}
```

(`AppState` needs importing: `import type { AppState } from '../types/state.ts';` — check for an existing import first. `ParamDef` is already imported in this file via `../types/codecs.ts`; extend that import if not.)

- [ ] **Step 5: Run the new tests**

Run: `npx vitest run tests/unit/engine/realCodecs.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full suite** — this is the important gate: the three new registry entries must not disturb any existing codec/pipeline/UI test (several iterate over `CODEC_REGISTRY`; if one now fails because it iterates all codecs and calls encode without the runtime, fix the TEST to filter on `runtime === undefined` **only when the test's purpose is educational-codec behavior**, and note it in the commit message).

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/types/codecs.ts src/engine/codecs.ts tests/unit/engine/realCodecs.test.ts
git commit -m "feat: zstd/gzip/blosc as numcodecs-backed registry entries (project 4 task 2)"
```

---

### Task 3: Worker eager init + runtime-status protocol + compute gating

**Files:**
- Modify: `src/worker/protocol.ts` (new message kind)
- Modify: `src/worker/pipeline.worker.ts` (init at startup, gate computes)
- Modify: `src/worker/client.ts` (`RuntimeState` in diagnostics)
- Modify: `src/hooks/useWorkerPipeline.ts` (IDLE_DIAGNOSTICS gains `runtime`)
- Test: extend `tests/unit/worker/client.test.ts`

**Interfaces:**
- Consumes: `initPyodideRuntime`, `RuntimeStepId`, `RUNTIME_STEP_LABELS`, `RUNTIME_STEP_ORDER` (Task 1); `stateUsesPyodideCodec` (Task 2).
- Produces:
  - Protocol: `interface RuntimeStatusMsg { kind: 'runtime-status'; status: 'loading' | 'ready' | 'error'; step?: RuntimeStepId; stepState?: 'start' | 'done'; error?: string }`, added to `WorkerResponse`.
  - `interface RuntimeState { status: 'loading' | 'ready' | 'error'; steps: { id: RuntimeStepId; label: string; done: boolean }[]; error: string | null }` exported from `src/worker/client.ts`.
  - `WorkerDiagnostics` gains `runtime: RuntimeState`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/worker/client.test.ts` (reuse the existing `FakeWorker`; add an emit helper to it):

```ts
  emitRuntimeStatus(msg: Omit<import('../../../src/worker/protocol.ts').RuntimeStatusMsg, 'kind'>) {
    this.listeners.message.forEach((f) => f({ data: { kind: 'runtime-status', ...msg } }));
  }
```

New describe block:

```ts
describe('PipelineWorkerClient runtime status (project 4)', () => {
  it('starts loading with no steps', () => {
    const w = new FakeWorker();
    const c = new PipelineWorkerClient({ createWorker: () => w, onResult: () => {} });
    c.compute(DEFAULT_STATE);
    expect(c.diagnostics().runtime).toEqual({ status: 'loading', steps: [], error: null });
  });

  it('accumulates narrated steps and flips ready', () => {
    const w = new FakeWorker();
    const statuses: RuntimeState[] = [];
    const c = new PipelineWorkerClient({
      createWorker: () => w,
      onResult: () => {},
      onStatus: (d) => statuses.push(d.runtime),
    });
    c.compute(DEFAULT_STATE);
    w.emitRuntimeStatus({ status: 'loading', step: 'download-runtime', stepState: 'start' });
    expect(c.diagnostics().runtime.steps).toEqual([
      { id: 'download-runtime', label: RUNTIME_STEP_LABELS['download-runtime'], done: false },
    ]);
    w.emitRuntimeStatus({ status: 'loading', step: 'download-runtime', stepState: 'done' });
    expect(c.diagnostics().runtime.steps[0].done).toBe(true);
    w.emitRuntimeStatus({ status: 'loading', step: 'install-numpy', stepState: 'start' });
    w.emitRuntimeStatus({ status: 'loading', step: 'install-numpy', stepState: 'done' });
    w.emitRuntimeStatus({ status: 'loading', step: 'install-numcodecs', stepState: 'start' });
    w.emitRuntimeStatus({ status: 'loading', step: 'install-numcodecs', stepState: 'done' });
    w.emitRuntimeStatus({ status: 'ready' });
    expect(c.diagnostics().runtime.status).toBe('ready');
    expect(c.diagnostics().runtime.steps).toHaveLength(3);
    expect(statuses.length).toBeGreaterThan(0); // onStatus fired for runtime updates
  });

  it('records a load error', () => {
    const w = new FakeWorker();
    const c = new PipelineWorkerClient({ createWorker: () => w, onResult: () => {} });
    c.compute(DEFAULT_STATE);
    w.emitRuntimeStatus({ status: 'error', error: 'CDN unreachable' });
    expect(c.diagnostics().runtime.status).toBe('error');
    expect(c.diagnostics().runtime.error).toBe('CDN unreachable');
  });

  it('runtime messages do not disturb an in-flight compute', () => {
    const w = new FakeWorker();
    const onResult = vi.fn();
    const c = new PipelineWorkerClient({ createWorker: () => w, onResult });
    c.compute(DEFAULT_STATE);
    w.emitRuntimeStatus({ status: 'ready' });
    w.emitResult(w.posted[0].id);
    expect(onResult).toHaveBeenCalledTimes(1);
  });
});
```

Imports to add at the top of the test file: `RUNTIME_STEP_LABELS` from `../../../src/engine/pyodideRuntime.ts`, `type RuntimeState` from `../../../src/worker/client.ts`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/worker/client.test.ts`
Expected: FAIL — `RuntimeState` not exported; `diagnostics().runtime` undefined.

- [ ] **Step 3: Protocol message**

In `src/worker/protocol.ts`:

```ts
import type { RuntimeStepId } from '../engine/pyodideRuntime.ts';

/** Pyodide runtime lifecycle (project 4). Not tied to a compute id — the
 *  worker loads the runtime eagerly at startup and narrates progress. */
export interface RuntimeStatusMsg {
  kind: 'runtime-status';
  status: 'loading' | 'ready' | 'error';
  step?: RuntimeStepId;
  stepState?: 'start' | 'done';
  error?: string;
}
```

and extend the union: `export type WorkerResponse = ProgressMsg | ResultOk | ResultErr | RuntimeStatusMsg;`

- [ ] **Step 4: Client state**

In `src/worker/client.ts`:

```ts
import { RUNTIME_STEP_LABELS, type RuntimeStepId } from '../engine/pyodideRuntime.ts';

export interface RuntimeState {
  status: 'loading' | 'ready' | 'error';
  steps: { id: RuntimeStepId; label: string; done: boolean }[];
  error: string | null;
}

export const INITIAL_RUNTIME_STATE: RuntimeState = { status: 'loading', steps: [], error: null };
```

Add to `WorkerDiagnostics`: `runtime: RuntimeState;`. Add the private field `private runtime: RuntimeState = INITIAL_RUNTIME_STATE;`, include `runtime: this.runtime` in `diagnostics()`, and at the TOP of `handleMessage` (before the progress/inFlight checks):

```ts
    if (msg.kind === 'runtime-status') {
      if (msg.status === 'error') {
        this.runtime = { ...this.runtime, status: 'error', error: msg.error ?? 'runtime load failed' };
      } else if (msg.status === 'ready') {
        this.runtime = { ...this.runtime, status: 'ready', error: null };
      } else if (msg.step) {
        const steps = this.runtime.steps.filter((s) => s.id !== msg.step);
        steps.push({ id: msg.step, label: RUNTIME_STEP_LABELS[msg.step], done: msg.stepState === 'done' });
        this.runtime = { status: 'loading', steps, error: null };
      }
      this.onStatus?.(this.diagnostics());
      return;
    }
```

(Keep step order stable: filter-then-push preserves arrival order because 'start' always precedes 'done' for the same step.)

- [ ] **Step 5: Worker init + gating**

In `src/worker/pipeline.worker.ts`, after the computer is constructed:

```ts
import { initPyodideRuntime } from '../engine/pyodideRuntime.ts';
import { stateUsesPyodideCodec } from '../engine/codecs.ts';

const post = (msg: WorkerResponse) => (self as unknown as Worker).postMessage(msg);

// Project 4: load the Python runtime eagerly at worker startup, narrating
// progress. Computes that don't use a real codec never wait on this; ones
// that do await `runtimeReady` below (a failed load surfaces per-compute
// through the existing ok:false path — and as a runtime-status error banner).
const runtimeReady = initPyodideRuntime((e) =>
  post({ kind: 'runtime-status', status: 'loading', step: e.step, stepState: e.state }),
).then(
  () => post({ kind: 'runtime-status', status: 'ready' }),
  (err) => {
    post({ kind: 'runtime-status', status: 'error', error: err instanceof Error ? err.message : String(err) });
    throw err;
  },
);
runtimeReady.catch(() => { /* handled per-compute; avoid unhandled rejection */ });
```

Make the message handler async and gate:

```ts
self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.kind !== 'compute') return;
  const timings: StageTimings = {};
  const t0 = performance.now();
  try {
    if (stateUsesPyodideCodec(msg.state)) await runtimeReady;
    const delta = computeDelta(msg.state, msg.knownKeys, (stage, ms) => {
      timings[stage] = ms;
      post({ kind: 'progress', id: msg.id, stage } satisfies WorkerResponse);
    });
    (self as unknown as Worker).postMessage(
      { kind: 'result', id: msg.id, ok: true, delta, timings, totalMs: performance.now() - t0 } satisfies WorkerResponse,
      collectTransferables(delta),
    );
  } catch (err) {
    post({ kind: 'result', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies WorkerResponse);
  }
};
```

(This preserves the existing structure exactly; only the `post` helper, the gating line, and async are new. The client serializes computes — one in flight — so the async handler never interleaves two computes.)

- [ ] **Step 6: Hook default**

In `src/hooks/useWorkerPipeline.ts`, extend `IDLE_DIAGNOSTICS`:

```ts
import { INITIAL_RUNTIME_STATE } from '../worker/client.ts';
// ...
const IDLE_DIAGNOSTICS: WorkerDiagnostics = {
  status: 'idle',
  respawnCount: 0,
  lastTimings: null,
  lastTotalMs: null,
  lastError: null,
  runtime: INITIAL_RUNTIME_STATE,
};
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run tests/unit/worker/ tests/unit/hooks/`
Expected: PASS (if `aboutModal.test.tsx` or others construct a `WorkerDiagnostics` literal, add `runtime: INITIAL_RUNTIME_STATE` to the fixture).

Then: `npx vitest run` — full suite PASS.

- [ ] **Step 8: Browser spike proof (the spec's risk item — do NOT skip)**

The dynamic CDN import inside a Vite module worker is the one unproven
integration. Prove it NOW, before any UI exists, with a throwaway probe in
the scratchpad (pattern: PERF-1's probe — patch `window.Worker` via
`addInitScript` to log messages):

```js
// scratchpad probe: start `npm run dev` first
import { launch } from '<repo>/tests/ui/scenario-helpers.mjs';
const { browser, page } = await launch();
page.on('console', (m) => { if (m.text().startsWith('[PROBE]')) console.log(m.text()); });
await page.context().addInitScript(() => {
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', (e) => {
        if (e.data?.kind === 'runtime-status') console.log(`[PROBE] runtime-status ${e.data.status} ${e.data.step ?? ''} ${e.data.stepState ?? ''} ${e.data.error ?? ''}`);
      });
    }
  };
});
await page.reload();
await page.waitForTimeout(120_000); // watch statuses stream; ready should land well before this
await browser.close();
```

Expected: the step sequence streams and ends with `runtime-status ready`.
If the CDN import fails under Vite dev (e.g. it rewrites the import), fix it
HERE (candidates: `new Function('u', 'return import(u)')` as the loader's
import mechanism, or `vite.config.ts` `worker.rollupOptions.external`) before
proceeding — Tasks 4–6 build on this working.

- [ ] **Step 9: Commit**

```bash
git add src/worker/ src/hooks/useWorkerPipeline.ts tests/unit/worker/client.test.ts
git commit -m "feat: eager Pyodide init in worker, runtime-status protocol, gated computes (project 4 task 3)"
```

---

### Task 4: UI — runtime banner + grouped/disabled codec picker

**Files:**
- Create: `src/components/layout/RuntimeBanner.tsx`
- Modify: `src/components/layout/App.tsx` (render banner under Header)
- Modify: `src/state/PipelineContext.tsx` (carry `runtimeStatus`)
- Modify: `src/components/layout/Sidebar.tsx` (read context, pass prop — find where `CodecSection` is rendered)
- Modify: `src/components/config/CodecSection.tsx` (thread `runtimeStatus` prop)
- Modify: `src/components/config/CodecPipelineEditor.tsx` (grouped picker, disabled real entries)
- Create: `tests/unit/components/runtimeBanner.test.tsx`
- Create: `tests/unit/components/codecPickerRuntime.test.tsx`

**Interfaces:**
- Consumes: `RuntimeState`/`INITIAL_RUNTIME_STATE` (Task 3), `RUNTIME_STEP_ORDER` (Task 1), `CodecDefinition.runtime` (Task 2).
- Produces:
  - `RuntimeBanner({ runtime }: { runtime: RuntimeState })` — renders nothing when `ready` or dismissed.
  - `CodecPipelineEditor` gains optional prop `runtimeStatus?: RuntimeState['status']` (default `'ready'` so existing callers/tests are unchanged); `CodecSection` gains and forwards the same optional prop.
  - `PipelineContextValue` gains `runtimeStatus: RuntimeState['status']`; `PipelineProvider` gains the prop (default `'ready'`).
  - Testids: `runtime-banner`, `runtime-banner-step-{id}`, `runtime-banner-dismiss`, `codec-group-real`.

- [ ] **Step 1: Write the failing banner test**

Create `tests/unit/components/runtimeBanner.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RuntimeBanner } from '../../../src/components/layout/RuntimeBanner.tsx';
import type { RuntimeState } from '../../../src/worker/client.ts';

const loading: RuntimeState = {
  status: 'loading',
  steps: [
    { id: 'download-runtime', label: 'Downloading Python runtime (Pyodide 314.0.2, ~12 MB)', done: true },
    { id: 'install-numpy', label: 'Installing numpy', done: false },
  ],
  error: null,
};

describe('RuntimeBanner', () => {
  it('narrates steps while loading (done steps checked, current step marked)', () => {
    render(<RuntimeBanner runtime={loading} />);
    const banner = screen.getByTestId('runtime-banner');
    expect(banner.textContent).toContain('Downloading Python runtime');
    expect(banner.textContent).toContain('Installing numpy');
    expect(screen.getByTestId('runtime-banner-step-download-runtime').textContent).toContain('✓');
    expect(screen.getByTestId('runtime-banner-step-install-numpy').textContent).not.toContain('✓');
  });

  it('renders nothing when ready', () => {
    render(<RuntimeBanner runtime={{ status: 'ready', steps: [], error: null }} />);
    expect(screen.queryByTestId('runtime-banner')).toBeNull();
  });

  it('shows a dismissible error with reassurance', () => {
    render(<RuntimeBanner runtime={{ status: 'error', steps: [], error: 'CDN unreachable' }} />);
    const banner = screen.getByTestId('runtime-banner');
    expect(banner.textContent).toContain('Real codecs unavailable');
    expect(banner.textContent).toContain('CDN unreachable');
    expect(banner.textContent).toContain('Everything else works');
    fireEvent.click(screen.getByTestId('runtime-banner-dismiss'));
    expect(screen.queryByTestId('runtime-banner')).toBeNull();
  });
});
```

- [ ] **Step 2: Write the failing picker test**

Create `tests/unit/components/codecPickerRuntime.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { CodecPipelineEditor } from '../../../src/components/config/CodecPipelineEditor.tsx';

function renderEditor(runtimeStatus?: 'loading' | 'ready' | 'error') {
  const onChange = vi.fn();
  const utils = render(
    <CodecPipelineEditor steps={[]} inputDtype="float32" onChange={onChange} runtimeStatus={runtimeStatus} />,
  );
  const select = utils.container.querySelector('select')!;
  return { onChange, select, ...utils };
}

describe('codec picker real-codec group', () => {
  it('groups real codecs separately with the numcodecs note', () => {
    const { select } = renderEditor('ready');
    const group = select.querySelector('optgroup[data-testid="codec-group-real"]')!;
    expect(group).not.toBeNull();
    expect(group.getAttribute('label')).toContain('Real codecs');
    const keys = Array.from(group.querySelectorAll('option')).map((o) => o.getAttribute('value'));
    expect(keys).toEqual(['zstd', 'gzip', 'blosc']);
    // Educational groups no longer contain the real entries
    const allOtherKeys = Array.from(select.querySelectorAll('optgroup:not([data-testid="codec-group-real"]) option'))
      .map((o) => o.getAttribute('value'));
    expect(allOtherKeys).not.toContain('zstd');
  });

  it('disables real codecs while loading, enables when ready', () => {
    const loading = renderEditor('loading');
    for (const opt of loading.select.querySelectorAll('optgroup[data-testid="codec-group-real"] option')) {
      expect((opt as HTMLOptionElement).disabled).toBe(true);
    }
    const ready = renderEditor('ready');
    for (const opt of ready.select.querySelectorAll('optgroup[data-testid="codec-group-real"] option')) {
      expect((opt as HTMLOptionElement).disabled).toBe(false);
    }
  });

  it('defaults to ready when the prop is omitted (existing callers unchanged)', () => {
    const onChange = vi.fn();
    const { container } = render(
      <CodecPipelineEditor steps={[]} inputDtype="float32" onChange={onChange} />,
    );
    const select = container.querySelector('select')!;
    fireEvent.change(select, { target: { value: 'zstd' } });
    expect(onChange).toHaveBeenCalledWith([
      { codec: 'zstd', params: { level: 3 } },
    ]);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/unit/components/runtimeBanner.test.tsx tests/unit/components/codecPickerRuntime.test.tsx`
Expected: FAIL — `RuntimeBanner` module missing; picker has no real group.

- [ ] **Step 4: Implement `RuntimeBanner`**

Create `src/components/layout/RuntimeBanner.tsx`:

```tsx
import { useState } from 'react';
import type { RuntimeState } from '../../worker/client.ts';
import { colors, fonts, fontSizes, spacing } from '../../theme.ts';

/** Project 4: narrated Pyodide load progress, rendered as a slim strip under
 *  the Header. Gone once ready; on failure it becomes a dismissible error
 *  ("everything else works" — educational codecs are unaffected). */
export function RuntimeBanner({ runtime }: { runtime: RuntimeState }) {
  const [dismissed, setDismissed] = useState(false);
  if (runtime.status === 'ready' || dismissed) return null;

  const base: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.md,
    padding: `${spacing.xs}px ${spacing.md}px`,
    fontFamily: fonts.mono,
    fontSize: fontSizes.xs,
    borderBottom: `1px solid ${colors.border}`,
  };

  if (runtime.status === 'error') {
    return (
      <div data-testid="runtime-banner" style={{ ...base, color: colors.error, background: colors.surfaceInput }}>
        <span style={{ flex: 1 }}>
          Real codecs unavailable: {runtime.error}. Everything else works — educational codecs are unaffected.
        </span>
        <button
          data-testid="runtime-banner-dismiss"
          onClick={() => setDismissed(true)}
          style={{ background: 'transparent', border: 'none', color: colors.textTertiary, cursor: 'pointer', fontSize: fontSizes.xs }}
        >
          dismiss
        </button>
      </div>
    );
  }

  return (
    <div data-testid="runtime-banner" style={{ ...base, color: colors.textSecondary, background: colors.surfaceInput }}>
      <span>Loading real codecs:</span>
      {runtime.steps.map((s) => (
        <span key={s.id} data-testid={`runtime-banner-step-${s.id}`} style={{ color: s.done ? colors.success : colors.textPrimary }}>
          {s.done ? '✓ ' : '… '}{s.label}
        </span>
      ))}
    </div>
  );
}
```

(Check `colors.success` exists in `src/theme.ts` — the lint-cleanup session confirmed `colors.error`; if `success` is absent, use the theme's existing success-ish color or `colors.accent`.)

- [ ] **Step 5: Wire the banner into App**

In `src/components/layout/App.tsx` (App component already holds `diagnostics`):

```tsx
import { RuntimeBanner } from './RuntimeBanner.tsx';
// inside <GuideProvider>, right after <Header ... />:
      <RuntimeBanner runtime={diagnostics.runtime} />
```

- [ ] **Step 6: Context + prop threading**

- `src/state/PipelineContext.tsx`: add `runtimeStatus: 'loading' | 'ready' | 'error'` to `PipelineContextValue`; `PipelineProvider` gains prop `runtimeStatus?: RuntimeState['status']` defaulting to `'ready'`, passed through following the exact split-memo pattern `computing` uses (a runtimeStatus-only change must not invalidate `pipelinePart` consumers — mirror how `computing` is composed into the context value).
- `src/components/layout/App.tsx`: MainLayout already receives `computing`; add `runtimeStatus: diagnostics.runtime.status` as a prop and pass it to `PipelineProvider`.
- `src/components/layout/Sidebar.tsx`: locate where `<CodecSection ...>` is rendered; read `const { runtimeStatus } = usePipelineContext();` in that component and pass `runtimeStatus={runtimeStatus}`.
- `src/components/config/CodecSection.tsx`: add optional `runtimeStatus?: 'loading' | 'ready' | 'error'` to props, forward to every `<CodecPipelineEditor ...>` it renders.

- [ ] **Step 7: Picker grouping in `CodecPipelineEditor.tsx`**

Replace the module-scope `categories`/`codecEntries` usage in `AddCodecSelect`:

```tsx
const codecEntries = Object.values(CODEC_REGISTRY);
const educationalCategories: Array<{ label: string; key: string }> = [
  { label: 'Reordering', key: 'reordering' },
  { label: 'Entropy', key: 'entropy' },
];

function AddCodecSelect({ onAdd, runtimeStatus }: { onAdd: (key: string) => void; runtimeStatus: 'loading' | 'ready' | 'error' }) {
  const realCodecs = codecEntries.filter((c) => c.runtime === 'pyodide');
  const realDisabled = runtimeStatus !== 'ready';
  const realSuffix = runtimeStatus === 'loading' ? ' (loading…)' : runtimeStatus === 'error' ? ' (unavailable)' : '';
  return (
    <select
      value=""
      onChange={(e) => {
        if (e.target.value) onAdd(e.target.value);
      }}
      style={{ ...inputStyle(), cursor: 'pointer', color: colors.accent }}
    >
      <option value="">+ Add codec</option>
      {educationalCategories.map((cat) => {
        const codecs = codecEntries.filter((c) => c.category === cat.key && c.runtime === undefined);
        if (codecs.length === 0) return null;
        return (
          <optgroup key={cat.key} label={cat.label}>
            {codecs.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </optgroup>
        );
      })}
      {realCodecs.length > 0 && (
        <optgroup data-testid="codec-group-real" label="Real codecs — actual numcodecs (Zarr's library), in Python via WebAssembly">
          {realCodecs.map((c) => (
            <option key={c.key} value={c.key} disabled={realDisabled}>
              {c.label}{realSuffix}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}
```

`CodecPipelineEditor` signature: add `runtimeStatus = 'ready'` to the destructured props (typed `runtimeStatus?: 'loading' | 'ready' | 'error'`), and pass `runtimeStatus={runtimeStatus}` at both `<AddCodecSelect onAdd={addCodec} />` call sites.

- [ ] **Step 8: Run the component tests, then the full suite**

Run: `npx vitest run tests/unit/components/ && npx vitest run`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/components/ src/state/PipelineContext.tsx tests/unit/components/
git commit -m "feat: runtime load banner + grouped/disabled real-codec picker (project 4 task 4)"
```

---

### Task 5: Service-worker Pyodide cache + version-sync test

**Files:**
- Modify: `public/sw.js`
- Create: `tests/unit/engine/pyodideVersionSync.test.ts`

**Interfaces:**
- Consumes: `PYODIDE_VERSION` (Task 1).
- Produces: SW caches Pyodide CDN GETs in cache `0xc-pyodide-<version>`, survives app deploys, purged only when the pinned version changes.

- [ ] **Step 1: Write the failing version-sync test**

Create `tests/unit/engine/pyodideVersionSync.test.ts`:

```ts
// public/sw.js cannot import from src/, so the pinned Pyodide version is
// duplicated there. This test is the thing that makes that duplication safe.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PYODIDE_VERSION } from '../../../src/engine/pyodideRuntime.ts';

describe('pyodide version pin consistency', () => {
  it('sw.js pins the same PYODIDE_VERSION as pyodideRuntime.ts', () => {
    const sw = readFileSync('public/sw.js', 'utf8');
    expect(sw).toContain(`const PYODIDE_VERSION = '${PYODIDE_VERSION}'`);
  });
});
```

Run: `npx vitest run tests/unit/engine/pyodideVersionSync.test.ts` — expected FAIL.

- [ ] **Step 2: Extend `public/sw.js`**

Add after the existing `CACHE` constant:

```js
// Project 4: the Pyodide runtime (+ numpy/numcodecs wheels) from the CDN.
// SEPARATE cache from the per-commit app-shell cache: these URLs are pinned
// and immutable, and evicting ~30MB of runtime on every deploy (the app
// cache's lifecycle) would force a re-download for no reason. Keep this
// version in sync with src/engine/pyodideRuntime.ts's PYODIDE_VERSION —
// tests/unit/engine/pyodideVersionSync.test.ts enforces the match.
const PYODIDE_VERSION = '314.0.2';
const PYODIDE_CACHE = `0xc-pyodide-${PYODIDE_VERSION}`;
const PYODIDE_ORIGIN = 'https://cdn.jsdelivr.net';
const PYODIDE_PATH_PREFIX = `/pyodide/v${PYODIDE_VERSION}/`;
```

In the `activate` handler, change the purge filter so the current Pyodide cache survives deploys but stale Pyodide versions are dropped:

```js
                names
                    .filter(name => name.startsWith('0xc-') && name !== CACHE && name !== PYODIDE_CACHE)
                    .map(name => self.caches.delete(name))
```

In the `fetch` handler, add a Pyodide branch BEFORE the same-origin check (immutable URLs → cache-first):

```js
    if (url.origin === PYODIDE_ORIGIN) {
        if (!url.pathname.startsWith(PYODIDE_PATH_PREFIX)) {
            return; // some other jsdelivr URL: not ours to cache
        }
        event.respondWith(
            (async () => {
                const cache = await self.caches.open(PYODIDE_CACHE);
                const cached = await cache.match(request);
                if (cached) {
                    return cached;
                }
                const response = await fetch(request);
                if (response.ok) {
                    await cache.put(request, response.clone());
                }
                return response;
            })()
        );
        return;
    }
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run tests/unit/engine/pyodideVersionSync.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add public/sw.js tests/unit/engine/pyodideVersionSync.test.ts
git commit -m "feat: version-keyed service-worker cache for the Pyodide runtime (project 4 task 5)"
```

---

### Task 6: Playwright scenario + docs

**Files:**
- Create: `tests/ui/scenario-real-codecs.mjs`
- Modify: `CLAUDE.md` (scenario list + relevant testids)

**Interfaces:**
- Consumes: everything above, running in a real browser against the dev server (`npm run dev` must be running; the scenario downloads Pyodide from the CDN on first run — the browser HTTP cache makes reruns fast; SW is PROD-only so no SW assertions here).

- [ ] **Step 1: Write the scenario**

Create `tests/ui/scenario-real-codecs.mjs`:

```js
// Regression scenario: project 4 (real codecs via Pyodide/numcodecs).
//
// Run 1 (online): the runtime banner narrates the load and disappears; real
// codecs go disabled -> enabled in the picker; adding Zstd to a variable
// pipeline shrinks the Encoded stage and the Read stage still round-trips.
// Run 2 (CDN blocked): the banner becomes a dismissible error; educational
// codecs still work.
//
// Needs network on a cold browser profile (downloads ~30MB from
// cdn.jsdelivr.net on run 1). Run: node tests/ui/scenario-real-codecs.mjs
// (dev server must be running).

import { chromium } from 'playwright';
import { newContext, shot, createHarness, seedStateAndReload, waitForPipelineIdle } from './scenario-helpers.mjs';

const h = createHarness('scenario-real-codecs');

// Column-interleaved tabular state with one small numeric variable — small
// shape so computes are instant and the codec effect is unambiguous.
function baseState() {
  return {
    dataModel: 'array',
    shape: [64, 64],
    chunkShape: [64, 64],
    interleaving: 'column',
    variables: [
      { id: 'temp', name: 'temp', color: '#e06c75',
        logicalType: { type: 'decimal', min: -50, max: 50, decimalPlaces: 1, generation: 'smooth' },
        typeAssignment: { storageDtype: 'float32' } },
    ],
    fieldPipelines: { temp: [] },
    chunkPipeline: [],
    metadata: { customEntries: [], serialization: 'json', include: { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true } },
    write: { includeMetadata: true, magicNumber: '00C0DEC5', partitioning: 'single', metadataPlacement: 'header', chunkOrder: 'row-major', footerLocator: 'trailer' },
    ui: { leftPaneStage: 'encoded', rightPaneStage: 'read', leftPaneView: 'hex', rightPaneView: 'table', showDiff: false },
  };
}

async function encodedByteCount(page) {
  // Pipeline strip stage node shows the Encoded stage's byte count.
  const text = await page.locator('[data-testid="pipeline-stage-3"]').innerText();
  const m = text.replace(/,/g, '').match(/(\d+)\s*B/i);
  return m ? parseInt(m[1], 10) : null;
}

async function main() {
  const browser = await chromium.launch();

  // ── Run 1: online — load narration, picker enablement, zstd round-trip ──
  {
    const { ctx, page, issues } = await newContext(browser);
    await seedStateAndReload(page, {
      '0x00c0dec5-active-model': 'array',
      '0x00c0dec5-state-array': baseState(),
    });

    const banner = page.locator('[data-testid="runtime-banner"]');
    const bannerAppeared = await banner.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true).catch(() => false);
    h.check('runtime banner appears while loading', bannerAppeared);

    const bannerGone = await banner.waitFor({ state: 'detached', timeout: 180_000 }).then(() => true).catch(() => false);
    h.check('runtime banner disappears when the runtime is ready', bannerGone);

    await waitForPipelineIdle(page, 60_000);

    const zstdOption = page.locator('option[value="zstd"]').first();
    h.check('zstd option is enabled once ready', await zstdOption.isEnabled());

    const before = await encodedByteCount(page);
    // Add Zstd to temp's pipeline via the sidebar picker.
    const select = page.locator('[data-testid="sidebar-section-codecs"] select').last();
    await select.selectOption('zstd');
    await waitForPipelineIdle(page, 60_000);
    const after = await encodedByteCount(page);
    h.check(
      'adding real zstd shrinks the Encoded stage',
      before !== null && after !== null && after < before,
      `before=${before} after=${after}`,
    );

    const readStatus = await page.locator('[data-testid="read-status"]').innerText();
    h.check('Read still round-trips with zstd in the pipeline', /success|ok|read/i.test(readStatus) && !/fail/i.test(readStatus), readStatus);

    h.check('no page errors in run 1', issues.pageerror.length === 0, issues.pageerror.slice(0, 3).join(' | '));
    await shot(page, 'real-codecs-online');
    await ctx.close();
  }

  // ── Run 2: CDN blocked — honest failure, educational codecs unaffected ──
  {
    const { ctx, page, issues } = await newContext(browser);
    await ctx.route('**://cdn.jsdelivr.net/**', (route) => route.abort());
    await seedStateAndReload(page, {
      '0x00c0dec5-active-model': 'array',
      '0x00c0dec5-state-array': baseState(),
    });

    const banner = page.locator('[data-testid="runtime-banner"]');
    await banner.waitFor({ state: 'visible', timeout: 60_000 }).catch(() => {});
    const text = (await banner.innerText().catch(() => '')) || '';
    h.check('CDN failure shows the error banner', text.includes('Real codecs unavailable'), text);

    await waitForPipelineIdle(page, 60_000);
    const select = page.locator('[data-testid="sidebar-section-codecs"] select').last();
    await select.selectOption('delta');
    await waitForPipelineIdle(page, 60_000);
    const readStatus = await page.locator('[data-testid="read-status"]').innerText();
    h.check('educational codecs still work with the runtime failed', !/fail/i.test(readStatus), readStatus);

    h.check('no page errors in run 2', issues.pageerror.length === 0, issues.pageerror.slice(0, 3).join(' | '));
    await shot(page, 'real-codecs-offline');
    await ctx.close();
  }

  await browser.close();
  h.finish();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
```

NOTE for the implementer: the selectors above (`pipeline-stage-3`, `sidebar-section-codecs`, `read-status` content) follow CLAUDE.md's testid conventions but MUST be verified against the live DOM before finalizing — adjust the byte-count regex/locators to what the strip actually renders (use a quick `page.innerText` dump if a check misfires; that is scenario calibration, not a product bug). If run 2's banner error text differs (e.g. import failure message), assert on the stable `Real codecs unavailable` prefix only.

- [ ] **Step 2: Run it (dev server up)**

```bash
npm run dev &
node tests/ui/scenario-real-codecs.mjs
```

Expected: all PASS (first run downloads Pyodide in the fresh browser profile; allow ~2–3 minutes).

- [ ] **Step 3: Update CLAUDE.md**

- Add `node tests/ui/scenario-real-codecs.mjs` to the scenario list (after `scenario-perf1-large-boot.mjs`).
- Add to the testid list: `runtime-banner` — Pyodide load-progress strip under the Header (`runtime-banner-step-{id}` per step, `runtime-banner-dismiss` on the error state); `codec-group-real` — the picker's real-codecs optgroup.

- [ ] **Step 4: Commit**

```bash
git add tests/ui/scenario-real-codecs.mjs CLAUDE.md
git commit -m "test: real-codecs scenario (load narration, zstd round-trip, CDN-blocked failure) (project 4 task 6)"
```

---

### Task 7: Full verification + PROD smoke + docs closeout

**Files:**
- Modify: `notes/improvement-ideas.md` (§4 status note)

- [ ] **Step 1: Full unit suite** — `npx vitest run` — expected: all PASS.
- [ ] **Step 2: Lint + build** — `npm run lint` (0 errors) and `npm run build` (clean; verify the built worker chunk does NOT contain the string `cdn.jsdelivr.net` **statically resolved into a bundled pyodide copy** — i.e. `grep -c loadPyodide dist/assets/*.js` should find the dynamic-import shim only, and no multi-MB chunk appeared in `dist/`).
- [ ] **Step 3: PROD smoke (SW + runtime together)** — `npm run build && npx vite preview` then, with Playwright or a browser, load the preview URL, wait for the banner to clear, and check `await caches.keys()` includes `0xc-pyodide-314.0.2`. This is the one place the SW cache is verified end-to-end (SW registration is PROD-only). Record the result in the task report; a scripted probe in the scratchpad is fine (it does not need to be committed).
- [ ] **Step 4: Scenario suite** — run every `tests/ui/scenario-*.mjs` against the dev server; expected: PASS/KNOWN-FAIL only.
- [ ] **Step 5: Docs** — in `notes/improvement-ideas.md` §4, add a status line: implemented via Pyodide/numcodecs (Zstd/GZip/Blosc), spec `docs/superpowers/specs/2026-07-11-real-codecs-pyodide-design.md`; CompressionStream/fflate rungs not taken (decision recorded in the spec). Remaining future rungs: more numcodecs entries, presets using real codecs.
- [ ] **Step 6: Commit**

```bash
git add notes/improvement-ideas.md
git commit -m "docs: project 4 (real codecs) complete — verification + roadmap status"
```
