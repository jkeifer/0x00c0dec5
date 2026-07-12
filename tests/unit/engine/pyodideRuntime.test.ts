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
