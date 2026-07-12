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
  // ponytail: empty input is a no-op for every codec, and several numcodecs
  // codecs (zstd, blosc — confirmed via spike) error decoding their own
  // empty-source encoding under this Pyodide's numcodecs build. Short-circuit
  // rather than special-case each codec's C extension bug.
  if (bytes.length === 0) return new Uint8Array(0);
  const result = runCodecFn(op, JSON.stringify(config), bytes);
  if (result instanceof Uint8Array) {
    return new Uint8Array(result); // copy (see doc comment)
  }
  const proxy = result as BytesProxy;
  const out = new Uint8Array(proxy.toJs()); // copy (see doc comment)
  proxy.destroy();
  return out;
}
