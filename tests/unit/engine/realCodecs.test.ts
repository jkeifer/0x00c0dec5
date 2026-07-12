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
    const params: Record<string, number | string> = key === 'blosc'
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
